import type { Page } from '@playwright/test';
import { BigSellerSkuInventoryPage } from '../bigseller/sku-inventory-page.js';
import { ensureSessionValid } from '../bigseller/auth.js';
import { SheetsClient } from '../sheets/sheets-client.js';
import { logger } from '../utils/logger.js';
import type { SkuInventoryRow } from '../types.js';

const SHEET_SKU_INVENTORY_OTHER = process.env.SHEET_SKU_INVENTORY_OTHER ?? 'DB_SKU_INVENTORY_OTHER';
const SHEET_SKU_COST = process.env.SHEET_SKU_COST ?? 'DB_SKU_COST';
const SKU_INVENTORY_URL = process.env.BIGSELLER_SKU_INVENTORY_URL ?? 'https://www.bigseller.com/web/inventory/index.htm';

/**
 * The warehouses shown in the "มูลค่าสต็อก" page besides STOCK_5 (DB_SKU_INVENTORY) and the online-sync warehouse
 * (DB_SKU_INVENTORY_DECOY). Chosen by the user on 2026-11-09 out of the 15 in BigSeller's warehouse filter; Test01 and
 * TestWave are test warehouses and deliberately left out. Each name must match the filter option's text exactly.
 * Override with OTHER_WAREHOUSES="name1,name2" — a name containing a comma is not supported.
 */
export const OTHER_WAREHOUSES: string[] = (process.env.OTHER_WAREHOUSES ?? 'STOCK_1 ของหาย,STOCK_12 คลังของคืน,STOCK_14,STOCK_6 แพ็คเกจเสีย')
  .split(',')
  .map((name) => name.trim())
  .filter(Boolean);

const HEADERS = [
  'sku', 'warehouse', 'totalWarehouseStock', 'lockedWarehouseStock',
  'availableWarehouseStock', 'unshelvedWarehouseStock', 'sourceUpdatedAt', 'sourceUrl',
] as const;

export interface WarehouseDryRunReport {
  warehouse: string;
  rows_in: number;
  /** Rows whose SKU has a cost price in DB_SKU_COST. */
  matched: number;
  /** Rows with stock > 0 and no cost price: the stock-value sheet silently values these at 0. */
  null_count_cost_missing_with_stock: number;
  duplicate_count: number;
  total_units: number;
  sample: Pick<SkuInventoryRow, 'sku' | 'warehouse' | 'totalWarehouseStock'>[];
  error?: string;
}

/** Cost lookup keyed by SKU, read from DB_SKU_COST (columns: sku, costPrice, currency). */
async function loadCostSkus(sheetsClient: SheetsClient): Promise<Set<string>> {
  const rows = await sheetsClient.readAll(SHEET_SKU_COST);
  const skus = new Set<string>();
  for (const row of rows.slice(1)) {
    const [sku, cost] = row;
    if (sku && cost !== undefined && cost !== '' && Number(cost) > 0) skus.add(sku.trim());
  }
  return skus;
}

export function buildDryRunReport(warehouse: string, rows: SkuInventoryRow[], costSkus: Set<string>): WarehouseDryRunReport {
  const seen = new Set<string>();
  let duplicates = 0;
  let matched = 0;
  let missingCostWithStock = 0;
  let totalUnits = 0;
  for (const r of rows) {
    const key = `${r.sku}|${r.warehouse}`;
    if (seen.has(key)) duplicates += 1;
    seen.add(key);
    const hasCost = costSkus.has(r.sku.trim());
    if (hasCost) matched += 1;
    else if (r.totalWarehouseStock > 0) missingCostWithStock += 1;
    totalUnits += r.totalWarehouseStock;
  }
  return {
    warehouse,
    rows_in: rows.length,
    matched,
    null_count_cost_missing_with_stock: missingCostWithStock,
    duplicate_count: duplicates,
    total_units: totalUnits,
    sample: rows.slice(0, 3).map((r) => ({ sku: r.sku, warehouse: r.warehouse, totalWarehouseStock: r.totalWarehouseStock })),
  };
}

const MAX_ATTEMPTS = 3;

/** The warehouse dropdown occasionally fails to open (seen once on 2026-11-09: a 30 s click timeout on a warehouse that
 * had exported fine twice before), so each warehouse gets up to MAX_ATTEMPTS tries, re-opening the page between them. */
export async function exportWarehouseWithRetry(skuPage: BigSellerSkuInventoryPage, warehouse: string): Promise<SkuInventoryRow[]> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      await skuPage.selectWarehouse(warehouse);
      return await skuPage.exportAllRows();
    } catch (error) {
      lastError = error;
      await logger.warn(`syncOtherWarehousesInventory: ${warehouse} attempt ${attempt}/${MAX_ATTEMPTS} failed: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
      if (attempt < MAX_ATTEMPTS) await skuPage.ensureView();
    }
  }
  throw lastError;
}

/**
 * Pulls the stock list of each warehouse in OTHER_WAREHOUSES from BigSeller and replaces DB_SKU_INVENTORY_OTHER with
 * the combined result (same columns as DB_SKU_INVENTORY). `replaceAll` is used because the tab means "what is in these
 * warehouses right now". If any warehouse fails to export, nothing is written: replacing the tab with a partial list
 * would silently delete the failed warehouse from the stock-value page.
 *
 * The dry-run switch is the shared DRY_RUN env (SheetsClient.replaceAll only logs while it is true); the report below
 * is always printed so a dry run shows the numbers a real run would write.
 */
export async function syncOtherWarehousesInventory(page: Page, sheetsClient: SheetsClient): Promise<WarehouseDryRunReport[]> {
  const start = Date.now();
  await ensureSessionValid(page, SKU_INVENTORY_URL);

  const costSkus = await loadCostSkus(sheetsClient);
  const skuPage = new BigSellerSkuInventoryPage(page);
  await skuPage.ensureView();

  const reports: WarehouseDryRunReport[] = [];
  const allRows: SkuInventoryRow[] = [];
  for (const warehouse of OTHER_WAREHOUSES) {
    try {
      const rows = await exportWarehouseWithRetry(skuPage, warehouse);
      const report = buildDryRunReport(warehouse, rows, costSkus);
      reports.push(report);
      allRows.push(...rows);
      await logger.info(`syncOtherWarehousesInventory: ${JSON.stringify(report)}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      reports.push({ warehouse, rows_in: 0, matched: 0, null_count_cost_missing_with_stock: 0, duplicate_count: 0, total_units: 0, sample: [], error: message });
      await logger.error(`syncOtherWarehousesInventory: ${warehouse} failed: ${message}`);
    }
  }

  const failed = reports.filter((r) => r.error);
  if (failed.length > 0) {
    await logger.error(`syncOtherWarehousesInventory: ${failed.length} warehouse(s) failed, ${SHEET_SKU_INVENTORY_OTHER} left untouched`);
    return reports;
  }

  // DryRun ladder step 3: TEST_LIMIT=5 with DRY_RUN=false writes only the first rows, to check the write path.
  const testLimit = Number(process.env.TEST_LIMIT ?? 0);
  const rowsToWrite = testLimit > 0 ? allRows.slice(0, testLimit) : allRows;
  await sheetsClient.replaceAll(
    SHEET_SKU_INVENTORY_OTHER,
    [...HEADERS],
    rowsToWrite.map((r) => ({
      sku: r.sku,
      warehouse: r.warehouse,
      totalWarehouseStock: r.totalWarehouseStock,
      lockedWarehouseStock: r.lockedWarehouseStock,
      availableWarehouseStock: r.availableWarehouseStock,
      unshelvedWarehouseStock: r.unshelvedWarehouseStock,
      sourceUpdatedAt: r.sourceUpdatedAt,
      sourceUrl: r.sourceUrl,
    })),
  );
  await logger.info(`syncOtherWarehousesInventory: ${rowsToWrite.length} row(s) from ${OTHER_WAREHOUSES.length} warehouse(s), done in ${Date.now() - start}ms`);
  return reports;
}
