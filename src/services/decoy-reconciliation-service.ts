import type { Page } from '@playwright/test';
import { BigSellerInventoryPage } from '../bigseller/inventory-page.js';
import { BigSellerSkuInventoryPage } from '../bigseller/sku-inventory-page.js';
import { ensureSessionValid } from '../bigseller/auth.js';
import { SheetsClient } from '../sheets/sheets-client.js';
import { logger } from '../utils/logger.js';

const SHEET_DECOY_RECONCILIATION_EXCEPTIONS = process.env.SHEET_DECOY_RECONCILIATION_EXCEPTIONS ?? 'DECOY_RECONCILIATION_EXCEPTIONS';
const HEADERS = ['sku', 'decoyQty', 'damagedPositionQty', 'discrepancy', 'detectedAt', 'sourceUrl'] as const;
const REAL_WAREHOUSE = 'STOCK_5';
const DAMAGED_POSITION_TYPE = 'ตำแหน่งวางสินค้าชำรุด';
const DECOY_WAREHOUSE = 'STOCK_ซิงก์ขายออนไลน์';

/**
 * Syncs FEATURE-pending-demand-and-offline-lock.md's "Addendum (2026-08-31):
 * คลังหลอก STOCK_ซิงก์ขายออนไลน์" reconciliation check. This is a detection
 * ONLY feature — it reads two existing reports and flags mismatches, it does
 * NOT touch the transfer-plan pipeline or the decoy-warehouse workaround
 * itself (spec is explicit: "ห้ามแตะ pipeline เดิมเด็ดขาด").
 *
 * Background: warehouse staff mirror the qty sitting in STOCK_5's damaged
 * position ("ตำแหน่งวางสินค้าชำรุด") into a fake warehouse named
 * "STOCK_ซิงก์ขายออนไลน์" with the same qty, as a workaround so BigSeller's
 * own available-to-sell-online calculation excludes damaged stock. If
 * someone updates one side (repairs/discards/recounts damaged goods) without
 * updating the mirror, the two numbers drift apart and the online
 * availability calc silently becomes wrong (either overselling broken stock
 * or hiding sellable stock) with no other symptom.
 *
 * Reuses two page-objects that already existed for unrelated syncs — no new
 * DOM investigation needed: `BigSellerInventoryPage` (location-level export,
 * already has a confirmed `selectPositionType('ตำแหน่งวางสินค้าชำรุด')`
 * filter) for the real damaged-position qty, and `BigSellerSkuInventoryPage`
 * (SKU-level totals) filtered to the decoy warehouse for its mirrored qty.
 *
 * Moved from Supabase to Google Sheets (2026-11-09) — the Supabase project
 * this originally wrote to (`decoy_reconciliation_exceptions`) was deleted
 * (free-tier storage limit) with no replacement decided yet for a
 * transactional backend, and this feature has no staff-editable overlay to
 * worry about (unlike transfer-in-transit-service.ts), so a plain
 * current-state Sheets tab is a direct, lossless replacement.
 */
export async function syncDecoyReconciliation(page: Page, sheetsClient: SheetsClient): Promise<void> {
  const start = Date.now();
  const inventoryUrl = 'https://www.bigseller.com/web/inventory/warehouseInventory.htm';
  await ensureSessionValid(page, inventoryUrl);

  // Deliberately NOT calling .goto() here — ensureSessionValid() already
  // navigated to this URL to check the session, and a second .goto() right
  // after races with that (confirmed pattern from sync-service.ts's own
  // comment: "a bare page.goto() immediately followed by another navigation
  // risks ... a stray redirect to the login screen"). ensureLocationView()/
  // ensureView() below just switch the already-loaded page to the right
  // sub-tab.
  const invPage = new BigSellerInventoryPage(page);
  await invPage.ensureLocationView();
  await invPage.selectWarehouse(REAL_WAREHOUSE);
  await invPage.selectPositionType(DAMAGED_POSITION_TYPE);
  const damagedRows = await invPage.exportAllRows();
  const damagedBySku = new Map(damagedRows.map((r) => [r.sku, r.stockAtPosition]));
  await logger.info(`syncDecoyReconciliation: ${damagedRows.length} SKU(s) in ${REAL_WAREHOUSE}'s ${DAMAGED_POSITION_TYPE}`);

  const skuPage = new BigSellerSkuInventoryPage(page);
  await skuPage.ensureView();
  await skuPage.selectWarehouse(DECOY_WAREHOUSE);
  const decoyRows = await skuPage.exportAllRows();
  const decoyBySku = new Map(decoyRows.map((r) => [r.sku, r.totalWarehouseStock]));
  await logger.info(`syncDecoyReconciliation: ${decoyRows.length} SKU(s) in decoy warehouse ${DECOY_WAREHOUSE}`);

  const allSkus = new Set([...damagedBySku.keys(), ...decoyBySku.keys()]);
  const mismatches: Record<string, string | number>[] = [];
  for (const sku of allSkus) {
    const damagedQty = damagedBySku.get(sku) ?? 0;
    const decoyQty = decoyBySku.get(sku) ?? 0;
    if (damagedQty !== decoyQty) {
      mismatches.push({
        sku,
        decoyQty,
        damagedPositionQty: damagedQty,
        discrepancy: decoyQty - damagedQty,
        detectedAt: new Date().toISOString(),
        sourceUrl: 'https://www.bigseller.com/web/inventory/warehouseInventory.htm',
      });
    }
  }

  await sheetsClient.replaceAll(SHEET_DECOY_RECONCILIATION_EXCEPTIONS, [...HEADERS], mismatches);

  await logger.info(
    `syncDecoyReconciliation: ${allSkus.size} SKU(s) compared, ${mismatches.length} mismatch(es) found, done in ${Date.now() - start}ms`,
  );
}
