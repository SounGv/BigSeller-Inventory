import type { Page } from '@playwright/test';
import { BigSellerSkuInventoryPage } from '../bigseller/sku-inventory-page.js';
import { ensureSessionValid } from '../bigseller/auth.js';
import { SheetsClient } from '../sheets/sheets-client.js';
import { logger } from '../utils/logger.js';

const SHEET_SKU_INVENTORY_DECOY = process.env.SHEET_SKU_INVENTORY_DECOY ?? 'DB_SKU_INVENTORY_DECOY';
const SKU_INVENTORY_URL = process.env.BIGSELLER_SKU_INVENTORY_URL ?? 'https://www.bigseller.com/web/inventory/index.htm';

/**
 * Same decoy warehouse as decoy-reconciliation-service.ts's DECOY_WAREHOUSE —
 * duplicated as a literal here rather than imported, since that file's
 * constant is private and this is a separate, simpler feature (a plain stock
 * list for staff to look at, not the mismatch-detection logic).
 */
const DECOY_WAREHOUSE = 'STOCK_ซิงก์ขายออนไลน์';

const HEADERS = [
  'sku', 'warehouse', 'totalWarehouseStock', 'lockedWarehouseStock',
  'availableWarehouseStock', 'unshelvedWarehouseStock', 'sourceUpdatedAt', 'sourceUrl',
] as const;

/**
 * Per explicit user request (2026-11-09): a plain stock list for the
 * "คลัง ซิงก์ขายออนไลน์" decoy warehouse (see
 * FEATURE-pending-demand-and-offline-lock.md's decoy-warehouse addendum for
 * what this warehouse is and why it exists) — current-state snapshot, same
 * shape as DB_SKU_INVENTORY, just for this one warehouse instead of STOCK_5.
 *
 * `replaceAll` (not upsert) because this reflects "what's in the decoy
 * warehouse right now" — a SKU that's been cleared out of it should
 * disappear from this sheet on the next sync, not linger with a stale qty.
 */
export async function syncDecoyWarehouseInventory(page: Page, sheetsClient: SheetsClient): Promise<void> {
  const start = Date.now();
  await ensureSessionValid(page, SKU_INVENTORY_URL);

  const skuPage = new BigSellerSkuInventoryPage(page);
  await skuPage.ensureView();
  await skuPage.selectWarehouse(DECOY_WAREHOUSE);
  const rows = await skuPage.exportAllRows();

  await sheetsClient.replaceAll(
    SHEET_SKU_INVENTORY_DECOY,
    [...HEADERS],
    rows.map((r) => ({
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

  await logger.info(`syncDecoyWarehouseInventory: ${rows.length} SKU(s) in ${DECOY_WAREHOUSE}, done in ${Date.now() - start}ms`);
}
