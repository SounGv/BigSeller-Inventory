import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Page } from '@playwright/test';
import { ensureSessionValid } from '../bigseller/auth.js';
import { NEW_ORDERS_URL } from '../bigseller/new-orders-page.js';
import { sendLineGroupMessages } from './line-notify-service.js';
import { logger } from '../utils/logger.js';

/**
 * Pre-check of NEW, UNCONFIRMED orders against the pick-position stock, every
 * 10 minutes, announced to the LINE group — the rules of the older Claude-in-
 * Chrome routine `neworder-pick-precheck` (bigseller-ops repo, NEWORDER_RUNBOOK.md),
 * which the user asked to keep exactly (2026-11-24):
 *
 *  - Demand counts only what BigSeller has NOT locked yet (quantity - allocated),
 *    because a waiting order already holds stock, and "available" at the pick
 *    position already excludes that lock; counting the full quantity would count
 *    it twice. Bundle lines (GIFT-...) are split into their child SKUs x num.
 *  - Compared with the AVAILABLE stock of the pick positions of STOCK_5.
 *  - LINE only for shortages that include an urgent / ship-first order, one SKU
 *    once per day, one message of at most 15 SKUs (saves LINE quota).
 *  - Read-only on BigSeller. It moves nothing.
 */

const STOCK5_WAREHOUSE_ID = Number(process.env.BIGSELLER_STOCK5_WAREHOUSE_ID ?? '49484');
const STOCK5_WAREHOUSE_NAME = process.env.INVENTORY_WAREHOUSE_NAME ?? 'STOCK_5';

/** Carrier names that mean "ship first" — BigSeller gives no deadline, so the carrier name is the signal. SPX Express / J&T / Flash / KEX / LEX / Seller Delivery are NOT urgent. */
export const URGENT_CARRIER = /Instant|ส่งทันที|Express Delivery|SHP Food|Food|Lalamove|Grab/i;
const PREALERT_CAP = 15;
const SEPARATOR = '━━━━━━━━━━━━━━';

/** One row of BigSeller's shelf list (one SKU at one position). shelfType: 0 pick, 1 storage, 2 damaged/buffer. */
export interface ShelfRow {
  sku: string;
  shelfType: number;
  shelfName: string;
  onhand: number;
  available: number;
}

export interface StockEntry {
  pickOn: number;
  pickAv: number;
  storOn: number;
  damOn: number;
  /** Stock sitting in the storage position named ZZZZ = still being produced, so not refillable yet. */
  zzzz: number;
}

export interface RawOrderItem {
  quantity: number;
  allocated: number;
  inventorySku: string;
  group: { varSku: string; num: number }[];
}

export interface RawOrder {
  warehouseId: number;
  shipmentWarehouse: string;
  carrier: string;
  option: string;
  items: RawOrderItem[];
}

export interface Demand {
  demand: Record<string, number>;
  urgent: Record<string, number>;
  urgentBy: Record<string, Record<string, number>>;
  ordersUsed: number;
  urgentOrders: number;
}

export interface Shortage {
  sku: string;
  need: number;
  pick: number;
  gap: number;
  storage: number;
  zzzz: number;
  urgent: number;
  by: Record<string, number>;
}

export interface WatchState {
  /** YYYY-MM-DD (Asia/Bangkok) the `sent` list belongs to; a new day starts a fresh list. */
  date?: string;
  sent: string[];
}

/** Pure: per-SKU totals over every position of the warehouse. */
export function buildStockBySku(rows: ShelfRow[]): Record<string, StockEntry> {
  const stock: Record<string, StockEntry> = {};
  for (const x of rows) {
    if (!x.sku) continue;
    const e = (stock[x.sku] ??= { pickOn: 0, pickAv: 0, storOn: 0, damOn: 0, zzzz: 0 });
    const on = x.onhand || 0;
    if (x.shelfType === 0) {
      e.pickOn += on;
      e.pickAv += x.available || 0;
    } else if (x.shelfType === 1) {
      e.storOn += on;
      if (x.shelfName === 'ZZZZ') e.zzzz += on;
    } else if (x.shelfType === 2) {
      e.damOn += on;
    }
  }
  return stock;
}

/**
 * Pure: what the unconfirmed orders of STOCK_5 still need from the pick
 * position. Quantity already locked by BigSeller (`allocated`) is not counted
 * again, and bundle lines become their child SKUs x num.
 */
export function buildDemand(orders: RawOrder[], warehouseId = STOCK5_WAREHOUSE_ID, warehouseName = STOCK5_WAREHOUSE_NAME): Demand {
  const demand: Record<string, number> = {};
  const urgent: Record<string, number> = {};
  const urgentBy: Record<string, Record<string, number>> = {};
  let ordersUsed = 0;
  let urgentOrders = 0;

  for (const o of orders) {
    if (o.warehouseId !== warehouseId && o.shipmentWarehouse !== warehouseName) continue;
    ordersUsed++;
    const isUrgent = URGENT_CARRIER.test(`${o.carrier} ${o.option}`);
    if (isUrgent) urgentOrders++;
    const carrierName = o.carrier.replace(/^[A-Za-z]+-TH-/, '').replace(/^Instant Delivery - /, '').trim() || 'ด่วน';

    for (const it of o.items) {
      const remaining = Math.max(0, (it.quantity || 0) - Math.min(it.quantity || 0, it.allocated || 0));
      if (remaining <= 0) continue;
      const parts: [string, number][] = it.group.length
        ? it.group.map((g) => [g.varSku, remaining * (g.num || 1)])
        : it.inventorySku
          ? [[it.inventorySku, remaining]]
          : [];
      for (const [sku, qty] of parts) {
        demand[sku] = (demand[sku] ?? 0) + qty;
        if (isUrgent) {
          urgent[sku] = (urgent[sku] ?? 0) + qty;
          const by = (urgentBy[sku] ??= {});
          by[carrierName] = (by[carrierName] ?? 0) + qty;
        }
      }
    }
  }
  return { demand, urgent, urgentBy, ordersUsed, urgentOrders };
}

/** Pure: every SKU whose remaining demand exceeds the available stock of its pick positions, biggest gap first. */
export function findShortages(d: Demand, stock: Record<string, StockEntry>): Shortage[] {
  const out: Shortage[] = [];
  for (const [sku, need] of Object.entries(d.demand)) {
    const e = stock[sku] ?? { pickOn: 0, pickAv: 0, storOn: 0, damOn: 0, zzzz: 0 };
    const gap = need - e.pickAv;
    if (gap <= 0) continue;
    out.push({
      sku,
      need,
      pick: e.pickAv,
      gap,
      storage: Math.max(0, e.storOn - e.zzzz),
      zzzz: e.zzzz,
      urgent: d.urgent[sku] ?? 0,
      by: d.urgentBy[sku] ?? {},
    });
  }
  return out.sort((a, b) => b.gap - a.gap || a.sku.localeCompare(b.sku));
}

/** Pure: the shortages that go to LINE — only those that include an urgent / ship-first order. */
export function urgentShortagesOnly(shortages: Shortage[]): Shortage[] {
  return shortages.filter((s) => s.urgent > 0);
}

/**
 * Pure: one SKU is announced once per day. Every SKU that was new this round is
 * remembered — including any beyond the 15 shown, which the message points to
 * the sheet for (same as the older routine). `limit` (> 0) caps how many are
 * announced and remembered, for the DryRun ladder's small-slice step.
 */
export function planPrealert(
  urgentShortages: Shortage[],
  state: WatchState,
  today: string,
  limit = 0,
): { toAlert: Shortage[]; alreadyAlertedCount: number; nextState: WatchState } {
  const sentToday = new Set(state.date === today ? state.sent : []);
  const fresh = urgentShortages.filter((s) => !sentToday.has(s.sku));
  const toAlert = limit > 0 ? fresh.slice(0, limit) : fresh;
  const sent = [...new Set([...sentToday, ...toAlert.map((s) => s.sku)])].sort();
  return { toAlert, alreadyAlertedCount: urgentShortages.length - fresh.length, nextState: { date: today, sent } };
}

/** Pure: the single LINE text, same template as the older routine's line_notify.py. `nowText` e.g. "🕐 24/11/2026 15:29 น.". */
export function buildPrealertMessage(toAlert: Shortage[], nowText: string, cap = PREALERT_CAP): string | null {
  if (toAlert.length === 0) return null;
  const blocks = toAlert.slice(0, cap).map((s, i) => {
    const refill: string[] = [];
    if (s.storage > 0) refill.push(`✅ เติมจากที่จัดเก็บได้ ${s.storage.toLocaleString('en-US')} ชิ้น`);
    if (s.zzzz > 0) refill.push(`⏳ รอของจาก ZZZZ ${s.zzzz.toLocaleString('en-US')} ชิ้น (ยังผลิตไม่เสร็จ)`);
    if (refill.length === 0) refill.push('🚫 ที่จัดเก็บไม่มีของ ต้องหาของ');
    const carriers = Object.keys(s.by).length
      ? `🚚 ด่วน ${s.urgent.toLocaleString('en-US')} ชิ้น: ` +
        Object.entries(s.by)
          .sort((a, b) => b[1] - a[1])
          .map(([k, v]) => `${k} ${v.toLocaleString('en-US')}`)
          .join(', ')
      : s.urgent
        ? `🚚 ด่วน ${s.urgent.toLocaleString('en-US')} ชิ้น`
        : '';
    return (
      `${i + 1}) ${s.sku}\n` +
      `ต้องใช้ ${s.need.toLocaleString('en-US')} ชิ้น\n` +
      (carriers ? `${carriers}\n` : '') +
      `ตำแหน่งหยิบมี ${s.pick.toLocaleString('en-US')} ชิ้น\n` +
      `❗ ขาด ${s.gap.toLocaleString('en-US')} ชิ้น\n` +
      refill.join('\n')
    );
  });
  const more = toAlert.length > cap ? `\n\n…และอีก ${toAlert.length - cap} รุ่น ดูแท็บ "ออเดอร์ใหม่ vs ตำแหน่งหยิบ" ในชีต` : '';
  const text =
    `⏰ เร่งเติมตำแหน่งหยิบ\nออเดอร์ด่วน (ยังไม่ยืนยัน) ทำให้ของในตำแหน่งหยิบไม่พอ\n${nowText}\n\n${SEPARATOR}\n` +
    blocks.join(`\n\n${SEPARATOR}\n`) +
    more;
  return text.slice(0, 4500);
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

/** Pure: "🕐 DD/MM/YYYY HH:MM น." in Bangkok time. */
export function formatNowText(now: Date): string {
  const { date, hhmm } = bangkokParts(now);
  const [y, m, d] = date.split('-');
  return `🕐 ${d}/${m}/${y} ${hhmm} น.`;
}

/** Pure: Mon–Sat, from the start to the end time (inclusive), Asia/Bangkok — the older routine's 08:02–17:52 window. */
export function isWithinWatchHours(now: Date, start = '08:00', end = '17:55'): boolean {
  const { hhmm, weekday } = bangkokParts(now);
  if (weekday === 'Sun') return false;
  return hhmm >= start && hhmm <= end;
}

// shortcut: state is one local JSON file on the machine that runs the job. If the watch ever runs on
// two machines, move it into a Sheets tab so both see the same "already announced today" list.
const STATE_PATH = resolve(process.env.LOG_DIR ?? 'logs', 'shortage-watch-state.json');

export function loadWatchState(path = STATE_PATH): WatchState {
  try {
    if (!existsSync(path)) return { sent: [] };
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<WatchState>;
    return { date: parsed.date, sent: Array.isArray(parsed.sent) ? parsed.sent : [] };
  } catch {
    return { sent: [] };
  }
}

export function saveWatchState(state: WatchState, path = STATE_PATH): void {
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
 * Read-only pull of the stock positions and the unconfirmed orders, through the
 * same BigSeller endpoints the older routine used (confirmed live by it). Runs
 * inside the already-logged-in page so the saved session is reused. Returns raw
 * rows only; every calculation happens in the pure functions above.
 */
async function fetchSnapshot(page: Page): Promise<{ pos: ShelfRow[]; orders: RawOrder[] }> {
  const browserCode = `(async (cfg) => {
    const post = async (url, body, ct) => { const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': ct }, body }); return r.json(); };
    const pos = []; let pg = 1, tp = 1;
    do {
      const j = await post('/api/v1/inventory/wms/shelfZonePageList.json',
        new URLSearchParams({ 'warehouseIdList[0]': String(cfg.warehouseId), hideZeroStockSku: 'false', openFlag: 'false', pageNo: String(pg), pageSize: '300', searchType: 'sku', inquireType: '1', searchContent: '' }).toString(),
        'application/x-www-form-urlencoded; charset=UTF-8');
      if (j.code !== 0) throw new Error('stock ' + j.msg);
      tp = j.data.totalPage;
      for (const x of j.data.rows) pos.push({ sku: x.sku || '', shelfType: x.shelfType, shelfName: x.shelfName || '', onhand: x.onhand || 0, available: x.available || 0 });
      pg++;
    } while (pg <= tp && pg < 40);
    const orders = []; pg = 1; tp = 1;
    do {
      const j = await post('/api/v1/order/new/pageList.json',
        JSON.stringify({ status: 'new', packState: '0', timeType: 1, searchType: 'orderNo', inquireType: 2, showLogisticsArr: 0, showStoreArr: 0, allOrder: false, historyOrder: false, desc: 1, orderBy: 'orderTime', pageNo: pg, pageSize: 200 }),
        'application/json;charset=UTF-8');
      if (j.code !== 0) throw new Error('orders ' + j.msg);
      tp = j.data.page.totalPage;
      for (const o of j.data.page.rows) orders.push({
        warehouseId: o.warehouseId, shipmentWarehouse: o.shipmentWarehouse || '',
        carrier: String(o.shippingCarrierName || ''), option: String(o.shippingConfigOptionName || ''),
        items: (o.orderItemList || []).map((it) => ({
          quantity: it.quantity || 0, allocated: it.allocated || 0, inventorySku: it.inventorySku || '',
          group: (Array.isArray(it.varSkuGroupVoList) ? it.varSkuGroupVoList : []).filter((x) => x.varSku).map((x) => ({ varSku: x.varSku, num: x.num || 1 })),
        })),
      });
      pg++;
    } while (pg <= tp && pg < 30);
    return { pos, orders };
  })(${JSON.stringify({ warehouseId: STOCK5_WAREHOUSE_ID })})`;

  return (await page.evaluate(browserCode)) as { pos: ShelfRow[]; orders: RawOrder[] };
}

/**
 * One 10-minute round. Read-only on BigSeller and writes no sheet: it reads the
 * stock and the unconfirmed orders, works out which SKUs the orders will leave
 * short at the pick position, and tells the LINE group about the ones that
 * include an urgent order — once per SKU per day.
 */
export async function runShortageWatchRound(page: Page): Promise<void> {
  const testLimit = Number(process.env.TEST_LIMIT ?? 0) || 0;
  const now = new Date();

  await ensureSessionValid(page, NEW_ORDERS_URL);
  const { pos, orders } = await fetchSnapshot(page);

  const stock = buildStockBySku(pos);
  // Same completeness check as the older routine: a short stock pull must never produce alerts.
  if (Object.keys(stock).length < 500) {
    throw new Error(`Stock pull looks incomplete (${Object.keys(stock).length} SKUs, ${pos.length} positions) — nothing announced`);
  }

  const d = buildDemand(orders);
  const shortages = findShortages(d, stock);
  const urgentShortages = urgentShortagesOnly(shortages);

  const state = loadWatchState();
  const plan = planPrealert(urgentShortages, state, bangkokParts(now).date, testLimit);
  const message = buildPrealertMessage(plan.toAlert, formatNowText(now));

  const skusWithoutStockRow = Object.keys(d.demand).filter((sku) => !stock[sku]).length;
  await logger.info(
    `shortage-watch report: rows_in=${orders.length} orders_used(STOCK_5)=${d.ordersUsed} urgent_orders=${d.urgentOrders} ` +
      `skus_with_demand=${Object.keys(d.demand).length} matched=${Object.keys(d.demand).length - skusWithoutStockRow} ` +
      `null_count(no stock row)=${skusWithoutStockRow} stock_skus=${Object.keys(stock).length} positions=${pos.length} ` +
      `shortages_all=${shortages.length} shortages_urgent=${urgentShortages.length} to_alert=${plan.toAlert.length} ` +
      `skipped(already announced today)=${plan.alreadyAlertedCount} dry_run=${DRY_RUN} line_enabled=${NOTIFY_ENABLED}`,
  );
  await logger.info(`shortage-watch sample_diff: ${JSON.stringify(plan.toAlert.slice(0, 5))}`);

  if (!message) return;

  if (!canSendLine()) {
    await logger.info(`[no LINE sent — dry_run=${DRY_RUN}, line_enabled=${NOTIFY_ENABLED}] message would be:\n${message}`);
    return; // state is NOT saved, so the same SKUs are announced when sending is really on
  }

  const result = await sendLineGroupMessages([message]);
  if (!result.ok) {
    await logger.error(`shortage-watch: LINE send failed, will retry next round — ${result.errorMessage}`);
    return; // state not saved => same SKUs are retried
  }
  saveWatchState(plan.nextState);
  await logger.info(`shortage-watch: announced ${plan.toAlert.length} SKU(s) (requestId ${result.requestId ?? '-'})`);
}
