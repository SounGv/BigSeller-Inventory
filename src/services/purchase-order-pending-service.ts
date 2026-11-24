import type { Page } from '@playwright/test';
import { BigSellerPurchaseOrderPage, PURCHASE_ORDER_URL } from '../bigseller/purchase-order-page.js';
import { ensureSessionValid } from '../bigseller/auth.js';
import { SheetsClient } from '../sheets/sheets-client.js';
import { logger } from '../utils/logger.js';

const SHEET_PURCHASE_ORDER_PENDING = process.env.SHEET_PURCHASE_ORDER_PENDING ?? 'DB_PURCHASE_ORDER_PENDING';
const SHEET_STOCK_VALUE_REF = process.env.SHEET_STOCK_VALUE_BIGSELLER ?? 'DB_STOCK_VALUE_BIGSELLER';

// See purchase-order-page.ts's doc comment for how these two were confirmed.
const STATE_FINISHED = 3;
const STATE_CANCELLED = 4;

const HEADERS = [
  'poNumber', 'supplier', 'warehouse', 'state', 'skuCount', 'orderedQty', 'receivedQty',
  'outstandingQty', 'estimatedUnitCost', 'estimatedValue', 'estimatedArrival', 'createdAt', 'sourceUpdatedAt',
] as const;

/** Per-warehouse average cost per unit, from the SAME on-hand reference sync-stock-value-reference.ts already writes — reused here rather than re-scraping, since a pending PO's own cost isn't available (see purchase-order-page.ts). */
async function readAvgUnitCostByWarehouse(sheetsClient: SheetsClient): Promise<Map<string, number>> {
  const rows = await sheetsClient.readAll(SHEET_STOCK_VALUE_REF);
  const header = rows[0] ?? [];
  const whIdx = header.indexOf('warehouse');
  const unitsIdx = header.indexOf('onHandUnits');
  const costIdx = header.indexOf('bigsellerOnHandCost');
  const map = new Map<string, number>();
  for (const row of rows.slice(1)) {
    const warehouse = row[whIdx];
    const units = Number(row[unitsIdx]);
    const cost = Number(row[costIdx]);
    if (warehouse && units > 0) map.set(warehouse, cost / units);
  }
  return map;
}

/**
 * Per explicit user request (2026-11-11): track the value of goods ON ORDER but not
 * yet (fully) received — "มูลค่าสั่งซื้อรอของเข้า" — as a thing genuinely separate
 * from transfer-in-transit-service.ts's warehouse-to-warehouse transfers.
 *
 * BigSeller itself has no usable order-value figure for a still-open purchase order
 * (confirmed live — see purchase-order-page.ts's doc comment), so `estimatedValue`
 * here is OUR OWN estimate: outstanding qty (ordered minus already received) × the
 * destination warehouse's own average on-hand unit cost (DB_STOCK_VALUE_BIGSELLER,
 * written by sync-stock-value-reference.ts — THIS job must run after that one in
 * run-stock-value-sync.bat). Confirmed with the user this estimate (rather than no
 * value at all) is what they want; it is clearly a different number from BigSeller's
 * own figures and must never be presented as if BigSeller reported it.
 *
 * `replaceAll` (not upsert) — this is a current-state snapshot of what is still open
 * right now, same reasoning as transfer-in-transit-service.ts/order-demand-service.ts.
 */
export async function syncPurchaseOrderPending(page: Page, sheetsClient: SheetsClient): Promise<void> {
  const start = Date.now();
  await ensureSessionValid(page, PURCHASE_ORDER_URL);

  const poPage = new BigSellerPurchaseOrderPage(page);
  await poPage.goto();
  const allRows = await poPage.fetchAllRows();

  const openRows = allRows.filter((r) => r.state !== STATE_FINISHED && r.state !== STATE_CANCELLED);
  await logger.info(`syncPurchaseOrderPending: ${allRows.length} PO(s) total, ${openRows.length} still open`);

  const avgUnitCostByWarehouse = await readAvgUnitCostByWarehouse(sheetsClient);
  const sourceUpdatedAt = new Date().toISOString();

  const records = openRows.map((r) => {
    const outstandingQty = Math.max(0, r.orderedQty - r.receivedQty);
    const estimatedUnitCost = avgUnitCostByWarehouse.get(r.warehouse) ?? 0;
    return {
      poNumber: r.poNumber,
      supplier: r.supplier,
      warehouse: r.warehouse,
      state: r.state,
      skuCount: r.skuCount,
      orderedQty: r.orderedQty,
      receivedQty: r.receivedQty,
      outstandingQty,
      estimatedUnitCost: Math.round(estimatedUnitCost * 100) / 100,
      estimatedValue: Math.round(outstandingQty * estimatedUnitCost * 100) / 100,
      estimatedArrival: r.estimatedArrival,
      createdAt: r.createdAt,
      sourceUpdatedAt,
    };
  });

  await sheetsClient.replaceAll(SHEET_PURCHASE_ORDER_PENDING, [...HEADERS], records);

  await logger.info(`syncPurchaseOrderPending: wrote ${records.length} row(s), done in ${Date.now() - start}ms`);
}
