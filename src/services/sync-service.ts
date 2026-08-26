import path from 'node:path';
import type { Page } from '@playwright/test';
import { BigSellerInventoryPage } from '../bigseller/inventory-page.js';
import { BigSellerSkuInventoryPage } from '../bigseller/sku-inventory-page.js';
import { BigSellerSalesPage, SALES_REPORT_EXPECTED_HEADERS } from '../bigseller/sales-page.js';
import { readTabularFile } from '../bigseller/extract-table.js';
import { ensureSessionValid } from '../bigseller/auth.js';
import { SheetsClient } from '../sheets/sheets-client.js';
import type { InventoryRow, SkuInventoryRow, SyncRunResult, SyncLogEntry, ErrorLogEntry } from '../types.js';
import { inventoryRowKey, skuInventoryRowKey, generateRunId } from '../types.js';
import { logger } from '../utils/logger.js';

const SHEET_LOCATION_SNAPSHOT = process.env.SHEET_LOCATION_SNAPSHOT ?? 'DB_LOCATION_SNAPSHOT';
const SHEET_LOCATION_CURRENT = process.env.SHEET_LOCATION_CURRENT ?? 'DB_LOCATION_CURRENT';
const SHEET_SKU_INVENTORY = process.env.SHEET_SKU_INVENTORY ?? 'DB_SKU_INVENTORY';
const SHEET_SALES_SNAPSHOT = process.env.SHEET_SALES_SNAPSHOT ?? 'DB_SALES_SNAPSHOT';
const SHEET_SYNC_LOG = process.env.SHEET_SYNC_LOG ?? 'SYNC_LOG';
const SHEET_ERROR_LOG = process.env.SHEET_ERROR_LOG ?? 'ERROR_LOG';
const LOG_DIR = process.env.LOG_DIR ?? './logs';

const INVENTORY_URL = process.env.BIGSELLER_INVENTORY_URL ?? 'https://www.bigseller.com/web/inventory/warehouseInventory.htm';
const SALES_URL = process.env.BIGSELLER_SALES_URL ?? 'https://www.bigseller.com/web/statis/items.htm';

const INVENTORY_HEADERS = [
  'sku', 'warehouse', 'area', 'position', 'positionType',
  'stockAtPosition', 'lockedStock', 'availableStock', 'unshelvedStock',
  'maxStock', 'minStock', 'sourceUpdatedAt', 'sourceUrl', 'runId',
] as const;

const SKU_INVENTORY_HEADERS = [
  'sku', 'warehouse', 'totalWarehouseStock', 'lockedWarehouseStock',
  'availableWarehouseStock', 'unshelvedWarehouseStock', 'sourceUpdatedAt', 'sourceUrl', 'runId',
] as const;

/** Row-count sanity check: refuse to write if the fresh scrape looks like a partial read. */
function assertReasonableRowCount(newCount: number, previousCount: number): void {
  if (previousCount > 0 && newCount < previousCount * 0.5) {
    throw new Error(
      `Sanity check failed: new row count (${newCount}) is less than half the previous snapshot's count (${previousCount}). ` +
        'Refusing to write to Google Sheets — this looks like a partial or broken scrape.',
    );
  }
}

export async function logError(entry: Omit<ErrorLogEntry, 'timestamp'>, sheetsClient: SheetsClient): Promise<void> {
  const fullEntry: ErrorLogEntry = { ...entry, timestamp: new Date().toISOString() };
  await logger.error(JSON.stringify(fullEntry));
  await sheetsClient.appendRows(SHEET_ERROR_LOG, [[
    fullEntry.timestamp, fullEntry.job, fullEntry.url, fullEntry.step, fullEntry.errorMessage, fullEntry.screenshotPath ?? '', fullEntry.runId ?? '',
  ]]);
}

async function logSync(entry: Omit<SyncLogEntry, 'timestamp'>, sheetsClient: SheetsClient): Promise<void> {
  const fullEntry: SyncLogEntry = { ...entry, timestamp: new Date().toISOString() };
  await logger.info(JSON.stringify(fullEntry));
  await sheetsClient.appendRows(SHEET_SYNC_LOG, [[
    fullEntry.timestamp, fullEntry.job, fullEntry.status, fullEntry.rowsProcessed, fullEntry.durationMs, fullEntry.message ?? '', fullEntry.runId ?? '',
  ]]);
}

/** One position-type export via the location-level page, with no Sheets writes — the shared building block for both `syncInventory` (pick positions only, for the existing employee-facing pipeline) and `syncLocationAllTypes` (every type, for the transfer-plan feature which needs storage positions as move sources). */
async function scrapeLocationRows(page: Page, warehouse: string, positionType: string): Promise<InventoryRow[]> {
  // ensureSessionValid (called by the caller) already navigated to INVENTORY_URL
  // as part of its check. Navigating to the identical URL again immediately can
  // race with BigSeller's client-side routing (observed live: intermittent
  // ERR_ABORTED / stray redirect to the login screen), so we call
  // ensureLocationView() instead of the full goto() — it just makes sure we're
  // on the right inventory sub-tab without a second page.goto().
  const inventoryPage = new BigSellerInventoryPage(page);
  await inventoryPage.ensureLocationView();
  await inventoryPage.selectWarehouse(warehouse);
  if (process.env.INVENTORY_AREA_NAME) {
    await inventoryPage.selectArea(process.env.INVENTORY_AREA_NAME);
  }
  await inventoryPage.selectPositionType(positionType);
  return inventoryPage.exportAllRows();
}

async function writeLocationRows(sheetsClient: SheetsClient, rows: InventoryRow[], runId: string): Promise<void> {
  const existingCurrent = await sheetsClient.readAll(SHEET_LOCATION_CURRENT).catch(() => []);
  assertReasonableRowCount(rows.length, Math.max(0, existingCurrent.length - 1));

  const snapshotDate = new Date().toISOString();
  const snapshotRows = rows.map((r) => [
    snapshotDate, r.sku, r.warehouse, r.area, r.position, r.positionType,
    r.stockAtPosition, r.lockedStock, r.availableStock, r.unshelvedStock,
    r.maxStock, r.minStock, r.sourceUpdatedAt, r.sourceUrl, runId,
  ]);
  // Snapshot MUST be written (append-only, never overwritten) before touching the current table.
  await sheetsClient.appendRows(SHEET_LOCATION_SNAPSHOT, snapshotRows);

  const currentRecords = rows.map((r) => ({ ...r, runId, key: inventoryRowKey(r) }));
  await sheetsClient.upsertRows(
    SHEET_LOCATION_CURRENT,
    currentRecords,
    { headers: [...INVENTORY_HEADERS], keyColumns: ['sku', 'warehouse', 'area', 'position', 'positionType'] },
  );
}

/**
 * Runs the location-level export for ONE position type (`INVENTORY_POSITION_TYPE_NAME`,
 * default "ตำแหน่งหยิบสินค้า" = pick positions) and stamps every row with
 * `runId` before writing. This is the original, standalone entry point — kept
 * for `npm run sync:inventory` and for the existing employee-facing pipeline,
 * which only ever wants pick positions.
 *
 * The transfer-plan feature needs BOTH pick and storage positions in the same
 * run (storage positions are the move sources), so {@link syncBigSeller} goes
 * through {@link syncLocationAllTypes} instead of this function.
 */
export async function syncInventory(page: Page, sheetsClient: SheetsClient, runId: string = generateRunId()): Promise<InventoryRow[]> {
  const start = Date.now();
  const warehouse = requireEnv('INVENTORY_WAREHOUSE_NAME');
  const positionType = process.env.INVENTORY_POSITION_TYPE_NAME ?? 'ตำแหน่งหยิบสินค้า';

  try {
    await ensureSessionValid(page, INVENTORY_URL);
    const rows = await scrapeLocationRows(page, warehouse, positionType);
    await writeLocationRows(sheetsClient, rows, runId);

    await logSync({ job: 'inventory', status: 'success', rowsProcessed: rows.length, durationMs: Date.now() - start, runId }, sheetsClient);
    return rows;
  } catch (error) {
    await handleFailure(page, 'inventory', INVENTORY_URL, 'syncInventory', error, sheetsClient, start, runId);
    throw error;
  }
}

const SOURCE_POSITION_TYPE_NAME = process.env.SOURCE_POSITION_TYPE_NAME ?? 'ตำแหน่งจัดเก็บสินค้า';

/** Location-level export covering both pick positions (replenishment targets) and storage positions (replenishment sources) — what Phase 1 of the transfer-plan workflow needs. */
export async function syncLocationAllTypes(page: Page, sheetsClient: SheetsClient, runId: string): Promise<InventoryRow[]> {
  const start = Date.now();
  const warehouse = requireEnv('INVENTORY_WAREHOUSE_NAME');
  const pickPositionType = process.env.INVENTORY_POSITION_TYPE_NAME ?? 'ตำแหน่งหยิบสินค้า';

  try {
    await ensureSessionValid(page, INVENTORY_URL);
    const pickRows = await scrapeLocationRows(page, warehouse, pickPositionType);
    const storageRows = await scrapeLocationRows(page, warehouse, SOURCE_POSITION_TYPE_NAME);
    const rows = [...pickRows, ...storageRows];

    await writeLocationRows(sheetsClient, rows, runId);
    await logSync({ job: 'bigseller-sync', status: 'success', rowsProcessed: rows.length, durationMs: Date.now() - start, runId, message: 'location (pick + storage)' }, sheetsClient);
    return rows;
  } catch (error) {
    await handleFailure(page, 'bigseller-sync', INVENTORY_URL, 'syncLocationAllTypes', error, sheetsClient, start, runId);
    throw error;
  }
}

/** SKU-level totals across the whole warehouse — see {@link BigSellerSkuInventoryPage} for why this needs its own page/export separate from the location-level one. */
export async function syncSkuInventory(page: Page, sheetsClient: SheetsClient, runId: string = generateRunId()): Promise<SkuInventoryRow[]> {
  const start = Date.now();
  const skuInventoryUrl = process.env.BIGSELLER_SKU_INVENTORY_URL ?? 'https://www.bigseller.com/web/inventory/index.htm';

  try {
    await ensureSessionValid(page, skuInventoryUrl);

    const warehouse = requireEnv('INVENTORY_WAREHOUSE_NAME');
    const skuPage = new BigSellerSkuInventoryPage(page);
    await skuPage.ensureView();
    await skuPage.selectWarehouse(warehouse);
    const rows = await skuPage.exportAllRows();

    const existingCurrent = await sheetsClient.readAll(SHEET_SKU_INVENTORY).catch(() => []);
    assertReasonableRowCount(rows.length, Math.max(0, existingCurrent.length - 1));

    const currentRecords = rows.map((r) => ({ ...r, runId, key: skuInventoryRowKey(r) }));
    await sheetsClient.upsertRows(
      SHEET_SKU_INVENTORY,
      currentRecords,
      { headers: [...SKU_INVENTORY_HEADERS], keyColumns: ['sku', 'warehouse'] },
    );

    await logSync({ job: 'bigseller-sync', status: 'success', rowsProcessed: rows.length, durationMs: Date.now() - start, runId, message: 'sku-inventory' }, sheetsClient);
    return rows;
  } catch (error) {
    await handleFailure(page, 'bigseller-sync', skuInventoryUrl, 'syncSkuInventory', error, sheetsClient, start, runId);
    throw error;
  }
}

/**
 * Phase 1 entry point: runs the location-level and SKU-totals exports under
 * ONE shared runId, so every downstream phase (validate, plan, export,
 * import) can prove its inputs came from the same sync. Never mix rows from
 * two different syncBigSeller() runs together.
 */
export async function syncBigSeller(page: Page, sheetsClient: SheetsClient): Promise<SyncRunResult> {
  const runId = generateRunId();
  const syncStartedAt = new Date().toISOString();
  const start = Date.now();

  try {
    const locationRows = await syncLocationAllTypes(page, sheetsClient, runId);
    const skuRows = await syncSkuInventory(page, sheetsClient, runId);
    const syncCompletedAt = new Date().toISOString();

    await logSync(
      { job: 'bigseller-sync', status: 'success', rowsProcessed: locationRows.length + skuRows.length, durationMs: Date.now() - start, runId, message: 'combined sync complete' },
      sheetsClient,
    );

    return { runId, syncStartedAt, syncCompletedAt, locationRows, skuRows };
  } catch (error) {
    await handleFailure(page, 'bigseller-sync', INVENTORY_URL, 'syncBigSeller', error, sheetsClient, start, runId);
    throw error;
  }
}

export async function syncSales(page: Page, sheetsClient: SheetsClient): Promise<void> {
  const start = Date.now();
  try {
    await ensureSessionValid(page, SALES_URL);

    const salesPage = new BigSellerSalesPage(page);
    await salesPage.goto();
    const filePath = await salesPage.exportReport();

    const rows = await readTabularFile(filePath);
    if (rows.length === 0) {
      throw new Error('Sales report parsed to 0 rows — refusing to write to Google Sheets.');
    }

    const snapshotDate = new Date().toISOString();
    const values = rows.map((row) => [snapshotDate, ...SALES_REPORT_EXPECTED_HEADERS.map((h) => row[h] ?? '')]);
    await sheetsClient.appendRows(SHEET_SALES_SNAPSHOT, values);

    await logSync({ job: 'sales', status: 'success', rowsProcessed: rows.length, durationMs: Date.now() - start }, sheetsClient);
  } catch (error) {
    await handleFailure(page, 'sales', SALES_URL, 'syncSales', error, sheetsClient, start);
    throw error;
  }
}

async function handleFailure(
  page: Page,
  job: ErrorLogEntry['job'],
  url: string,
  step: string,
  error: unknown,
  sheetsClient: SheetsClient,
  start: number,
  runId?: string,
): Promise<void> {
  const screenshotPath = path.join(LOG_DIR, `${job}-error-${Date.now()}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => undefined);

  await logError({ job, url, step, errorMessage: (error as Error).message, screenshotPath, runId }, sheetsClient).catch(() => undefined);
  await logSync(
    { job: job as SyncLogEntry['job'], status: 'failure', rowsProcessed: 0, durationMs: Date.now() - start, message: (error as Error).message, runId },
    sheetsClient,
  ).catch(() => undefined);
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}
