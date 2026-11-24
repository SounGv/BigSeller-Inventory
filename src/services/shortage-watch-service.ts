import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Page } from '@playwright/test';
import { SheetsClient } from '../sheets/sheets-client.js';
import { ensureSessionValid } from '../bigseller/auth.js';
import { BigSellerNewOrdersPage, NEW_ORDERS_URL } from '../bigseller/new-orders-page.js';
import { selectFilterPill, setWarehouseFilter } from '../bigseller/new-orders-dom.js';
import {
  STOCK_CHECK_HEADERS,
  buildStockCheckRows,
  isRealPickPosition,
  type PickPositionAgg,
} from './order-stock-check-service.js';
import { scrapeLocationRows } from './sync-service.js';
import { sendLineGroupMessages } from './line-notify-service.js';
import type { InventoryRow, NewOrderLineRow } from '../types.js';
import { logger } from '../utils/logger.js';

const SHEET_STOCK_CHECK_VIEW = process.env.SHEET_EMPLOYEE_STOCK_CHECK_VIEW ?? 'EMPLOYEE_STOCK_CHECK_VIEW';
const SHEET_SKU_INVENTORY = process.env.SHEET_SKU_INVENTORY ?? 'DB_SKU_INVENTORY';
const INVENTORY_URL = process.env.BIGSELLER_INVENTORY_URL ?? 'https://www.bigseller.com/web/inventory/warehouseInventory.htm';
const WAREHOUSE_NAME = process.env.INVENTORY_WAREHOUSE_NAME ?? 'STOCK_5';
const PICK_POSITION_TYPE = process.env.INVENTORY_POSITION_TYPE_NAME ?? 'ตำแหน่งหยิบสินค้า';

/** Only orders from these marketplaces count (confirmed by the user 2026-11-24); every other platform — manual orders, POS, WooCommerce, chat — is somebody else's process. */
const WATCH_PLATFORMS = (process.env.WATCH_PLATFORMS ?? 'Shopee,Lazada,TikTok').split(',').map((s) => s.trim()).filter(Boolean);
/** Only orders allocated to these warehouses count (confirmed by the user 2026-11-24): the picking warehouse and the online-sync warehouse. */
const WATCH_WAREHOUSES = (process.env.WATCH_WAREHOUSES ?? 'STOCK_5,STOCK_ซิงก์ขายออนไลน์').split(',').map((s) => s.trim()).filter(Boolean);

/** LINE allows 5 bubbles per push; each lists this many SKUs, so a message never exceeds LINE's 5000-character limit. */
const ITEMS_PER_BUBBLE = 20;
const MAX_BUBBLES = 4;

export interface Shortage {
  sku: string;
  orderDemandQty: number;
  pickPositionQty: number;
  short: number;
  positions: string;
}

export interface ShortageState {
  /** SKUs already announced and still short. A SKU leaves this map the moment it stops being short, so a later recurrence is announced again. */
  alerted: Record<string, { firstAlertedAt: string }>;
  /** YYYY-MM-DD (Asia/Bangkok) of the last "session expired" notice, so that notice goes out at most once a day. */
  lastSessionAlertDate?: string;
}

export interface AlertPlan {
  toAlert: Shortage[];
  /** How many currently-short SKUs were already announced earlier and are therefore not repeated. */
  alreadyAlertedCount: number;
  nextState: ShortageState;
}

/**
 * Pure: SKUs whose pending order quantity exceeds what sits at the pick
 * position — the same "แดง" rule as the morning sheet (see buildStockCheckRows),
 * returned worst-first so the biggest gap is at the top of the LINE message.
 */
export function findShortages(
  demandBySku: Map<string, number>,
  pickAggBySku: Map<string, PickPositionAgg>,
): Shortage[] {
  const rows = buildStockCheckRows(demandBySku, pickAggBySku, new Map());
  return rows
    .filter((r) => r.status === 'แดง')
    .map((r) => ({
      sku: r.sku,
      orderDemandQty: r.orderDemandQty,
      pickPositionQty: r.pickPositionQty,
      short: -r.shortfallOrSurplus,
      positions: r.positions,
    }))
    .sort((a, b) => b.short - a.short || a.sku.localeCompare(b.sku));
}

/**
 * Pure: decides which shortages to announce this round and what to remember.
 *
 * A SKU is announced once when it first goes short. It is not repeated while it
 * stays short, and is forgotten the moment it stops being short, so if it runs
 * out again it is announced again. `limit` (> 0) caps how many are announced and
 * remembered this round — used by the DryRun ladder's small-slice step.
 */
export function planShortageAlerts(
  shortages: Shortage[],
  state: ShortageState,
  nowIso: string,
  limit = 0,
): AlertPlan {
  const stillShort = new Set(shortages.map((s) => s.sku));
  const fresh = shortages.filter((s) => !state.alerted[s.sku]);
  const toAlert = limit > 0 ? fresh.slice(0, limit) : fresh;

  const alerted: ShortageState['alerted'] = {};
  for (const sku of Object.keys(state.alerted)) {
    if (stillShort.has(sku)) alerted[sku] = state.alerted[sku];
  }
  for (const s of toAlert) alerted[s.sku] = { firstAlertedAt: nowIso };

  return {
    toAlert,
    alreadyAlertedCount: shortages.length - fresh.length,
    nextState: { ...state, alerted },
  };
}

/** Pure: the LINE bubbles for the announced SKUs (split so none gets too long). */
export function buildShortageMessages(toAlert: Shortage[], hhmm: string): string[] {
  if (toAlert.length === 0) return [];
  const bubbles: string[] = [];
  const shown = toAlert.slice(0, ITEMS_PER_BUBBLE * MAX_BUBBLES);
  for (let i = 0; i < shown.length; i += ITEMS_PER_BUBBLE) {
    const chunk = shown.slice(i, i + ITEMS_PER_BUBBLE);
    const header =
      i === 0
        ? `⚠️ ของขาดตำแหน่งหยิบ (ออเดอร์ใหม่ยังไม่ยืนยัน) ${hhmm} — ${toAlert.length} รายการ`
        : '(ต่อ)';
    const lines = chunk.map((s) => {
      const where = s.positions ? `  [${s.positions.split(', ')[0]}]` : '';
      return `• ${s.sku}  สั่ง ${s.orderDemandQty} / ตำแหน่งหยิบมี ${s.pickPositionQty}  ขาด ${s.short}${where}`;
    });
    bubbles.push([header, ...lines].join('\n'));
  }
  const hidden = toAlert.length - shown.length;
  if (hidden > 0) {
    bubbles[bubbles.length - 1] += `\n… และอีก ${hidden} รายการ ดูทั้งหมดในชีต ${SHEET_STOCK_CHECK_VIEW}`;
  }
  return bubbles;
}

const BANGKOK = 'Asia/Bangkok';

function bangkokParts(now: Date): { date: string; hhmm: string; weekday: string } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: BANGKOK,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short',
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const hour = get('hour') === '24' ? '00' : get('hour');
  return { date: `${get('year')}-${get('month')}-${get('day')}`, hhmm: `${hour}:${get('minute')}`, weekday: get('weekday') };
}

/** Pure: Mon–Sat, between the start and end times (inclusive), Asia/Bangkok — the same window as the full sync. */
export function isWithinWatchHours(now: Date, start = '08:30', end = '18:30'): boolean {
  const { hhmm, weekday } = bangkokParts(now);
  if (weekday === 'Sun') return false;
  return hhmm >= start && hhmm <= end;
}

/** Pure: collapses fresh BigSeller pick-position rows into one total per SKU, using the same filters as the sheet-based reader. */
export function aggregatePickStock(rows: InventoryRow[]): Map<string, PickPositionAgg> {
  const map = new Map<string, PickPositionAgg>();
  for (const row of rows) {
    if (row.warehouse !== WAREHOUSE_NAME || row.positionType !== PICK_POSITION_TYPE) continue;
    if (!isRealPickPosition(row.position)) continue;
    const sku = row.sku?.trim();
    if (!sku) continue;
    const agg = map.get(sku) ?? { stockAtPosition: 0, maxStock: 0, minStock: 0, positions: [] };
    agg.stockAtPosition += Number(row.stockAtPosition) || 0;
    agg.maxStock += Number(row.maxStock) || 0;
    agg.minStock += Number(row.minStock) || 0;
    if (!agg.positions.includes(row.position)) agg.positions.push(row.position);
    map.set(sku, agg);
  }
  return map;
}

/** Pure: total order quantity per SKU across all pending (unconfirmed, non-LockStock) order lines. */
export function sumDemandBySku(lines: Pick<NewOrderLineRow, 'sku' | 'qty'>[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const line of lines) {
    const sku = line.sku?.trim();
    const qty = Number(line.qty);
    if (!sku || !Number.isFinite(qty)) continue;
    map.set(sku, (map.get(sku) ?? 0) + qty);
  }
  return map;
}

// shortcut: state is one local JSON file on the machine that runs the job. If the watch ever runs on
// two machines, move it into a Sheets tab so both see the same "already announced" list.
const STATE_PATH = resolve(process.env.LOG_DIR ?? 'logs', 'shortage-watch-state.json');

export function loadShortageState(path = STATE_PATH): ShortageState {
  try {
    if (!existsSync(path)) return { alerted: {} };
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<ShortageState>;
    return { alerted: parsed.alerted ?? {}, lastSessionAlertDate: parsed.lastSessionAlertDate };
  } catch {
    return { alerted: {} };
  }
}

export function saveShortageState(state: ShortageState, path = STATE_PATH): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2));
}

const DRY_RUN = (process.env.DRY_RUN ?? 'true').toLowerCase() === 'true';
const NOTIFY_ENABLED = (process.env.LINE_NOTIFY_ENABLED ?? 'false').toLowerCase() === 'true';

/** Whether a real LINE message may go out right now (never under DRY_RUN, never while notifications are off). */
function canSendLine(): boolean {
  return !DRY_RUN && NOTIFY_ENABLED;
}

/**
 * Reads the new, unconfirmed orders that count for the watch: marketplace
 * platforms only, allocated to the picking warehouse or the online-sync
 * warehouse only. The warehouse filter is verified by setWarehouseFilter itself
 * (it throws rather than scan an unknown scope), and the platform pill is read
 * back after every click by selectFilterPill.
 *
 * Both filters are put back to "ทั้งหมด" afterwards so the shared BigSeller
 * account is not left looking filtered to whoever opens the order page next.
 * LockStock reservations are manual orders, so the platform filter already
 * leaves them out.
 */
export async function scrapeMarketplaceOrders(page: Page): Promise<NewOrderLineRow[]> {
  await ensureSessionValid(page, NEW_ORDERS_URL);
  const ordersPage = new BigSellerNewOrdersPage(page);
  await ordersPage.goto();

  const rows: NewOrderLineRow[] = [];
  const seen = new Set<string>();
  try {
    await setWarehouseFilter(page, WATCH_WAREHOUSES);
    for (const platform of WATCH_PLATFORMS) {
      await selectFilterPill(page, 'แพลตฟอร์ม', platform);
      for (const row of await ordersPage.scrapeCurrentFilterRows(platform)) {
        const key = `${row.orderId || row.orderNo}::${row.sku}`;
        if (seen.has(key)) continue; // an order can only sit on one platform, so this only guards against a page that did not refresh
        seen.add(key);
        rows.push({ ...row, platform });
      }
    }
  } finally {
    await selectFilterPill(page, 'แพลตฟอร์ม', 'ทั้งหมด').catch((e) => logger.warn(`shortage-watch: could not reset platform filter — ${(e as Error).message}`));
    await setWarehouseFilter(page, 'all').catch((e) => logger.warn(`shortage-watch: could not reset warehouse filter — ${(e as Error).message}`));
  }
  await logger.info(`shortage-watch: ${rows.length} order line(s) from ${WATCH_PLATFORMS.join('+')} in ${WATCH_WAREHOUSES.join('+')}`);
  return rows;
}

/**
 * One 10-minute round: reads the new unconfirmed orders, reads the pick-position
 * stock as it is right now, refreshes the staff stock-check sheet, and tells the
 * LINE group about SKUs that have newly become short.
 *
 * Does NOT write DB_LOCATION_CURRENT / DB_LOCATION_SNAPSHOT: the fresh pick
 * stock is used in memory only. Writing the snapshot every ten minutes would add
 * thousands of history rows a day; the 2-hourly full sync keeps owning those tabs.
 */
export async function runShortageWatchRound(page: Page, sheetsClient: SheetsClient): Promise<void> {
  const testLimit = Number(process.env.TEST_LIMIT ?? 0) || 0;
  const now = new Date();

  const pendingRows = await scrapeMarketplaceOrders(page);
  // scrapeLocationRows expects the page to be on the inventory screen already (ensureSessionValid does that navigation), and syncOrderDemand just left it on the orders screen.
  await ensureSessionValid(page, INVENTORY_URL);
  const pickRows = await scrapeLocationRows(page, WAREHOUSE_NAME, PICK_POSITION_TYPE);

  const demandBySku = sumDemandBySku(pendingRows);
  const pickAggBySku = aggregatePickStock(pickRows);

  // Whole-warehouse totals are a "nice to have" column on the sheet; the 2-hourly sync keeps this tab fresh enough.
  const totalStockBySku = new Map<string, number>();
  const skuRows = await sheetsClient.readAll(SHEET_SKU_INVENTORY);
  if (skuRows.length > 1) {
    const h = skuRows[0];
    const [iSku, iWh, iTot] = [h.indexOf('sku'), h.indexOf('warehouse'), h.indexOf('totalWarehouseStock')];
    for (const r of skuRows.slice(1)) {
      if (iSku < 0 || iWh < 0 || iTot < 0 || r[iWh] !== WAREHOUSE_NAME) continue;
      totalStockBySku.set(r[iSku], (totalStockBySku.get(r[iSku]) ?? 0) + (Number(r[iTot]) || 0));
    }
  }

  const viewRows = buildStockCheckRows(demandBySku, pickAggBySku, totalStockBySku, now.toISOString());
  await sheetsClient.replaceAll(SHEET_STOCK_CHECK_VIEW, [...STOCK_CHECK_HEADERS], viewRows);

  const shortages = findShortages(demandBySku, pickAggBySku);
  const state = loadShortageState();
  const plan = planShortageAlerts(shortages, state, now.toISOString(), testLimit);
  const messages = buildShortageMessages(plan.toAlert, bangkokParts(now).hhmm);

  const skusWithoutPickPosition = [...demandBySku.keys()].filter((sku) => !pickAggBySku.has(sku)).length;
  await logger.info(
    `shortage-watch report: rows_in=${pendingRows.length} skus_with_demand=${demandBySku.size} ` +
      `matched=${demandBySku.size - skusWithoutPickPosition} null_count(no pick position)=${skusWithoutPickPosition} ` +
      `pick_skus=${pickAggBySku.size} shortages=${shortages.length} to_alert=${plan.toAlert.length} ` +
      `skipped(already announced)=${plan.alreadyAlertedCount} dry_run=${DRY_RUN} line_enabled=${NOTIFY_ENABLED}`,
  );
  await logger.info(`shortage-watch sample_diff: ${JSON.stringify(plan.toAlert.slice(0, 5))}`);

  if (messages.length === 0) return;

  if (!canSendLine()) {
    await logger.info(`[no LINE sent — dry_run=${DRY_RUN}, line_enabled=${NOTIFY_ENABLED}] message would be:\n${messages.join('\n---\n')}`);
    return; // state is NOT saved, so the same SKUs are announced when sending is really on
  }

  const result = await sendLineGroupMessages(messages);
  if (!result.ok) {
    await logger.error(`shortage-watch: LINE send failed, will retry next round — ${result.errorMessage}`);
    return; // state not saved => same SKUs are retried
  }
  saveShortageState(plan.nextState);
  await logger.info(`shortage-watch: announced ${plan.toAlert.length} SKU(s) (requestId ${result.requestId ?? '-'})`);
}

/** Tells the group once a day that BigSeller needs a manual re-login, instead of failing silently every ten minutes. */
export async function announceSessionExpiredOncePerDay(now = new Date()): Promise<void> {
  const state = loadShortageState();
  const today = bangkokParts(now).date;
  if (state.lastSessionAlertDate === today) return;
  if (!canSendLine()) {
    await logger.info('[no LINE sent] BigSeller session expired — would announce once today');
    return;
  }
  const result = await sendLineGroupMessages(['🔒 BigSeller session หมดอายุ ระบบเฝ้าของขาดหยุดชั่วคราว ต้องล็อกอินใหม่ด้วย npm run login:bigseller']);
  if (result.ok) saveShortageState({ ...state, lastSessionAlertDate: today });
  else await logger.error(`shortage-watch: could not announce session expiry — ${result.errorMessage}`);
}
