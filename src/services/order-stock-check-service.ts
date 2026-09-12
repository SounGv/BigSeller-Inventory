import { SheetsClient } from '../sheets/sheets-client.js';
import { logger } from '../utils/logger.js';

const SHEET_LOCATION_CURRENT = process.env.SHEET_LOCATION_CURRENT ?? 'DB_LOCATION_CURRENT';
const SHEET_SKU_INVENTORY = process.env.SHEET_SKU_INVENTORY ?? 'DB_SKU_INVENTORY';
const SHEET_PENDING_ORDER_DEMAND = process.env.SHEET_PENDING_ORDER_DEMAND ?? 'DB_PENDING_ORDER_DEMAND';
const SHEET_STOCK_CHECK_VIEW = process.env.SHEET_EMPLOYEE_STOCK_CHECK_VIEW ?? 'EMPLOYEE_STOCK_CHECK_VIEW';

const WAREHOUSE_NAME = process.env.INVENTORY_WAREHOUSE_NAME ?? 'STOCK_5';
const PICK_POSITION_TYPE = process.env.INVENTORY_POSITION_TYPE_NAME ?? 'ตำแหน่งหยิบสินค้า';

// Same two markers transfer-plan-service.ts filters out of every replenishment
// target (isNoPickPosition/isGiftPosition there) — duplicated here as plain
// string checks rather than importing those private helpers, since this
// project treats transfer-plan-service.ts as settled/sensitive (see
// START-BUILD.md: "ห้ามแตะ ... transfer-plan-service.ts" is the one file with
// an explicit exception, everything else stays untouched by convention).
const NO_PICK_POSITION_MARKER = 'ไม่มีตำแหน่งหยิบ';
const GIFT_POSITION_MARKER = 'ของแถม';

export const STOCK_CHECK_HEADERS = [
  'sku', 'positions', 'orderDemandQty', 'pickPositionQty', 'pickMaxStock', 'pickMinStock',
  'totalWarehouseStock', 'shortfallOrSurplus', 'status', 'updatedAt',
] as const;

export type StockCheckStatus = 'แดง' | 'ส้ม' | 'ปกติ';

interface PickPositionAgg {
  stockAtPosition: number;
  maxStock: number;
  minStock: number;
  /** Every distinct pick position this SKU sits in — shown as one comma-joined column (not one row per position) so `status` can stay a single per-SKU judgment; see the service doc comment. */
  positions: string[];
}

function sumByColumn(
  rows: string[][],
  skuCol: string,
  valueCol: string,
  filter?: (row: string[], header: string[]) => boolean,
): Map<string, number> {
  const map = new Map<string, number>();
  if (rows.length < 2) return map;
  const header = rows[0];
  const skuIdx = header.indexOf(skuCol);
  const valueIdx = header.indexOf(valueCol);
  if (skuIdx === -1 || valueIdx === -1) return map;

  for (const row of rows.slice(1)) {
    if (filter && !filter(row, header)) continue;
    const sku = row[skuIdx]?.trim();
    const value = Number(row[valueIdx]);
    if (!sku || !Number.isFinite(value)) continue;
    map.set(sku, (map.get(sku) ?? 0) + value);
  }
  return map;
}

/**
 * Sums stockAtPosition/maxStock/minStock per SKU across every pick position
 * that SKU has (a SKU can legitimately sit in more than one pick position —
 * summed capacity/floor across all of them is the natural "how much can this
 * SKU hold at pick position(s) in total" figure, same aggregation direction
 * as everywhere else in this project). Filters to the real warehouse only
 * (never the STOCK_ซิงก์ขายออนไลน์ decoy — see the reconciliation addendum in
 * FEATURE-pending-demand-and-offline-lock.md for why that filter must never
 * be dropped) and excludes the same "no real pick position" / gift-position
 * placeholders that transfer-plan-service.ts excludes from replenishment.
 */
async function readPickPositionAggBySku(sheetsClient: SheetsClient): Promise<Map<string, PickPositionAgg>> {
  const rows = await sheetsClient.readAll(SHEET_LOCATION_CURRENT);
  const map = new Map<string, PickPositionAgg>();
  if (rows.length < 2) return map;

  const header = rows[0];
  const idx = (col: string) => header.indexOf(col);
  const skuIdx = idx('sku');
  const warehouseIdx = idx('warehouse');
  const positionIdx = idx('position');
  const positionTypeIdx = idx('positionType');
  const stockIdx = idx('stockAtPosition');
  const maxIdx = idx('maxStock');
  const minIdx = idx('minStock');

  for (const row of rows.slice(1)) {
    if (row[warehouseIdx] !== WAREHOUSE_NAME) continue;
    if (row[positionTypeIdx] !== PICK_POSITION_TYPE) continue;

    const position = row[positionIdx] ?? '';
    if (position.includes(NO_PICK_POSITION_MARKER) || position.includes(GIFT_POSITION_MARKER)) continue;

    const sku = row[skuIdx]?.trim();
    if (!sku) continue;

    const existing = map.get(sku) ?? { stockAtPosition: 0, maxStock: 0, minStock: 0, positions: [] };
    existing.stockAtPosition += Number(row[stockIdx]) || 0;
    existing.maxStock += Number(row[maxIdx]) || 0;
    existing.minStock += Number(row[minIdx]) || 0;
    if (!existing.positions.includes(position)) existing.positions.push(position);
    map.set(sku, existing);
  }
  return map;
}

async function readTotalWarehouseStockBySku(sheetsClient: SheetsClient): Promise<Map<string, number>> {
  const rows = await sheetsClient.readAll(SHEET_SKU_INVENTORY);
  return sumByColumn(rows, 'sku', 'totalWarehouseStock', (row, header) => row[header.indexOf('warehouse')] === WAREHOUSE_NAME);
}

async function readOrderDemandBySku(sheetsClient: SheetsClient): Promise<Map<string, number>> {
  const rows = await sheetsClient.readAll(SHEET_PENDING_ORDER_DEMAND);
  return sumByColumn(rows, 'sku', 'qty');
}

/**
 * Morning stock-sufficiency check for staff, per explicit user request
 * (2026-09-09): every SKU appearing in today's new/unconfirmed orders
 * (DB_PENDING_ORDER_DEMAND), compared against what is physically sitting at
 * its pick position(s) right now — NOT total warehouse stock, since packing
 * only ever pulls from the pick position, never the wider warehouse.
 *
 * Status thresholds confirmed with the user (2026-09-09):
 *  - แดง (red): pick-position stock cannot even cover today's pending
 *    orders — needs an urgent transfer before staff can finish packing.
 *  - ส้ม (orange): enough for today's orders, but fulfilling them would drop
 *    the position below its own minStock — needs replenishing soon, not
 *    urgently.
 *  - ปกติ (normal): stays at or above minStock even after today's orders.
 *
 * This is a pure aggregation over three ALREADY-SYNCED sheets — the caller
 * (scripts/sync-order-stock-check.ts) is responsible for refreshing
 * DB_PENDING_ORDER_DEMAND right before calling this; DB_LOCATION_CURRENT and
 * DB_SKU_INVENTORY are trusted as-is (kept fresh by their own existing sync
 * schedule) — this function never re-syncs them and never opens a browser.
 */
export async function syncOrderStockCheck(sheetsClient: SheetsClient): Promise<void> {
  const [pickAggBySku, totalStockBySku, demandBySku] = await Promise.all([
    readPickPositionAggBySku(sheetsClient),
    readTotalWarehouseStockBySku(sheetsClient),
    readOrderDemandBySku(sheetsClient),
  ]);

  const updatedAt = new Date().toISOString();
  const rows = [...demandBySku.entries()].map(([sku, orderDemandQty]) => {
    const pick = pickAggBySku.get(sku) ?? { stockAtPosition: 0, maxStock: 0, minStock: 0, positions: [] };
    const shortfallOrSurplus = pick.stockAtPosition - orderDemandQty;
    const status: StockCheckStatus =
      shortfallOrSurplus < 0 ? 'แดง' : shortfallOrSurplus < pick.minStock ? 'ส้ม' : 'ปกติ';

    return {
      sku,
      positions: pick.positions.join(', '),
      orderDemandQty,
      pickPositionQty: pick.stockAtPosition,
      pickMaxStock: pick.maxStock,
      pickMinStock: pick.minStock,
      totalWarehouseStock: totalStockBySku.get(sku) ?? 0,
      shortfallOrSurplus,
      status,
      updatedAt,
    };
  });

  // Sorted by SKU (per explicit user request 2026-09-09: "ใส่ตัวกรอง เรียง sku
  // หรือ ตำแหน่ง ถ้าจะให้หาง่ายๆ") so staff can find a specific model quickly —
  // urgency is still visible at a glance via the red/ส้ม row color from
  // migrate-sheet-for-order-stock-check.ts, and the sheet's native filter
  // (also added there) lets staff re-sort by any column, including
  // `positions`, themselves without needing this script changed again.
  rows.sort((a, b) => a.sku.localeCompare(b.sku));

  await sheetsClient.replaceAll(SHEET_STOCK_CHECK_VIEW, [...STOCK_CHECK_HEADERS], rows);

  const redCount = rows.filter((r) => r.status === 'แดง').length;
  const orangeCount = rows.filter((r) => r.status === 'ส้ม').length;
  await logger.info(`syncOrderStockCheck: ${rows.length} SKU(s) checked — ${redCount} แดง, ${orangeCount} ส้ม`);
}
