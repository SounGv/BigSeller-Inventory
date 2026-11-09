import type { Page } from '@playwright/test';
import { BigSellerSkuInventoryPage } from '../bigseller/sku-inventory-page.js';
import { ensureSessionValid } from '../bigseller/auth.js';
import { SheetsClient } from '../sheets/sheets-client.js';
import { logger } from '../utils/logger.js';
import { exportWarehouseWithRetry } from './other-warehouses-inventory-service.js';

const SHEET_STOCK_VALUE_REF = process.env.SHEET_STOCK_VALUE_BIGSELLER ?? 'DB_STOCK_VALUE_BIGSELLER';
const SKU_INVENTORY_URL = process.env.BIGSELLER_SKU_INVENTORY_URL ?? 'https://www.bigseller.com/web/inventory/index.htm';

/**
 * Every real warehouse in BigSeller's warehouse filter (15 on 2026-11-09) except the test ones, Test01 and TestWave.
 * Names must match the filter option text exactly. A new warehouse needs adding here; a renamed one shows up as a
 * failed warehouse in the log and the tab is then left untouched.
 */
export const REFERENCE_WAREHOUSES: string[] = [
  'STOCK_5', 'STOCK_1 ของหาย', 'STOCK_12 คลังของคืน', 'STOCK_13 FBS', 'STOCK_14',
  'STOCK_2 Service (ของเคลม)', 'STOCK_3 Service (ของเสีย)', 'STOCK_4 Gifset/ของรอติด', 'STOCK_6 แพ็คเกจเสีย',
  'STOCK_7 สินค้าหาย ล็อตเก่าๆ', 'STOCK_8 ของเสีย (รับคืน)', 'STOCK_9 Buffer Stock Online', 'STOCK_ซิงก์ขายออนไลน์',
];

const HEADERS = ['warehouse', 'onHandUnits', 'bigsellerOnHandCost', 'inTransitUnits', 'bigsellerInTransitCost', 'skuRows', 'sourceUpdatedAt'] as const;

export interface WarehouseReference {
  warehouse: string;
  onHandUnits: number;
  bigsellerOnHandCost: number;
  inTransitUnits: number;
  bigsellerInTransitCost: number;
  skuRows: number;
  sourceUpdatedAt: string;
  error?: string;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Records, per warehouse, what BigSeller itself says the stock and the in-transit goods cost, so the dashboard can show
 * its own (SKU Merchant price based) value next to BigSeller's and the difference, plus the goods on the way between
 * warehouses. The export already carries both figures per SKU ("ราคาต้นทุนทั้งหมด", "ระหว่างทาง",
 * "ต้นทุนรวมของระหว่างทาง"); this sums them per warehouse. In-transit units are NOT part of on-hand: BigSeller lists them
 * against the destination warehouse in their own column.
 *
 * All-or-nothing like the other warehouse sync: if any warehouse fails after retries nothing is written, since a missing
 * warehouse would otherwise disappear from the dashboard note. Dry-run follows the shared DRY_RUN env via replaceAll.
 */
export async function syncStockValueReference(page: Page, sheetsClient: SheetsClient): Promise<WarehouseReference[]> {
  const start = Date.now();
  await ensureSessionValid(page, SKU_INVENTORY_URL);
  const skuPage = new BigSellerSkuInventoryPage(page);
  await skuPage.ensureView();

  const results: WarehouseReference[] = [];
  for (const warehouse of REFERENCE_WAREHOUSES) {
    try {
      const rows = await exportWarehouseWithRetry(skuPage, warehouse);
      const result: WarehouseReference = {
        warehouse,
        onHandUnits: rows.reduce((s, r) => s + r.totalWarehouseStock, 0),
        bigsellerOnHandCost: round2(rows.reduce((s, r) => s + (r.costTotal ?? 0), 0)),
        inTransitUnits: rows.reduce((s, r) => s + (r.inTransitStock ?? 0), 0),
        bigsellerInTransitCost: round2(rows.reduce((s, r) => s + (r.inTransitCost ?? 0), 0)),
        skuRows: rows.length,
        sourceUpdatedAt: rows[0]?.sourceUpdatedAt ?? new Date().toISOString(),
      };
      results.push(result);
      await logger.info(`syncStockValueReference: ${JSON.stringify(result)}`);
    } catch (error) {
      const message = error instanceof Error ? (error.message.split('\n')[0] ?? '') : String(error);
      results.push({ warehouse, onHandUnits: 0, bigsellerOnHandCost: 0, inTransitUnits: 0, bigsellerInTransitCost: 0, skuRows: 0, sourceUpdatedAt: '', error: message });
      await logger.error(`syncStockValueReference: ${warehouse} failed: ${message}`);
    }
  }

  if (results.some((r) => r.error)) {
    await logger.error(`syncStockValueReference: ${results.filter((r) => r.error).length} warehouse(s) failed, ${SHEET_STOCK_VALUE_REF} left untouched`);
    return results;
  }

  await sheetsClient.replaceAll(SHEET_STOCK_VALUE_REF, [...HEADERS], results.map(({ error: _error, ...row }) => row));
  await logger.info(`syncStockValueReference: ${results.length} warehouse(s), done in ${Date.now() - start}ms`);
  return results;
}
