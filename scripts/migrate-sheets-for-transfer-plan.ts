import 'dotenv/config';
import { google, sheets_v4 } from 'googleapis';

/**
 * One-time migration for the transfer-plan feature. Safe to re-run (every step
 * checks current state first and skips if already applied) but is still a
 * structural edit to the live production spreadsheet, so it prints a summary
 * of every change it makes.
 *
 * Confirmed live (2026-08-25) before writing this: DB_LOCATION_CURRENT!N1:O1
 * carry the header labels "canReplenish"/"status" but every data cell below
 * them (N2:O onward) is completely empty — no ArrayFormula actually lives
 * there. EMPLOYEE_TASK_VIEW computes its own canReplenish/status locally from
 * columns A-M and never reads N/O. So this is dead, unused header labels, not
 * a live formula column — safe to just reclaim N for `runId` and leave O
 * untouched (its stale "status" label is harmless dead weight, left alone
 * rather than touched for no reason).
 */

const SHEET_LOCATION_CURRENT = process.env.SHEET_LOCATION_CURRENT ?? 'DB_LOCATION_CURRENT';
const SHEET_LOCATION_SNAPSHOT = process.env.SHEET_LOCATION_SNAPSHOT ?? 'DB_LOCATION_SNAPSHOT';
const SHEET_SKU_INVENTORY = 'DB_SKU_INVENTORY';
const SHEET_SYNC_LOG = process.env.SHEET_SYNC_LOG ?? 'SYNC_LOG';
const SHEET_ERROR_LOG = process.env.SHEET_ERROR_LOG ?? 'ERROR_LOG';
const SHEET_TRANSFER_PLAN = process.env.SHEET_TRANSFER_PLAN ?? 'DB_TRANSFER_PLAN';
const SHEET_TRANSFER_EXCEPTION = process.env.SHEET_TRANSFER_EXCEPTION ?? 'TRANSFER_EXCEPTION';
const SHEET_TRANSFER_NOTIFICATION_LOG = process.env.SHEET_TRANSFER_NOTIFICATION_LOG ?? 'TRANSFER_NOTIFICATION_LOG';
const SHEET_SKU_SALES = process.env.SHEET_SKU_SALES ?? 'DB_SKU_SALES';
const SHEET_SKU_CARTON_QTY = process.env.SHEET_SKU_CARTON_QTY ?? 'DB_SKU_CARTON_QTY';
const SHEET_EMPLOYEE_TASK_VIEW = process.env.SHEET_EMPLOYEE_TASK_VIEW ?? 'EMPLOYEE_TASK_VIEW';
const PICK_POSITION_TYPE_NAME = process.env.INVENTORY_POSITION_TYPE_NAME ?? 'ตำแหน่งหยิบสินค้า';

async function main() {
  const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
  if (!spreadsheetId) throw new Error('GOOGLE_SHEETS_SPREADSHEET_ID is not set in .env');

  const auth = new google.auth.GoogleAuth({ scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  const client = await auth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: client as never });

  const changes: string[] = [];

  await migrateLocationCurrent(sheets, spreadsheetId, changes);
  await migrateSkuInventory(sheets, spreadsheetId, changes);
  await addTrailingHeader(sheets, spreadsheetId, SHEET_LOCATION_SNAPSHOT, 'runId', changes);
  await addTrailingHeader(sheets, spreadsheetId, SHEET_SYNC_LOG, 'runId', changes);
  await addTrailingHeader(sheets, spreadsheetId, SHEET_ERROR_LOG, 'runId', changes);
  await createSheetIfMissing(sheets, spreadsheetId, SHEET_TRANSFER_PLAN, [
    'runId', 'sku', 'sourcePosition', 'targetPosition', 'sourceQty', 'targetQty', 'targetZone',
    'stockAtPosition', 'totalWarehouseStock', 'replenishableQty', 'moveQty', 'status', 'createdAt',
  ], changes);
  await createSheetIfMissing(sheets, spreadsheetId, SHEET_TRANSFER_EXCEPTION, [
    'runId', 'sku', 'targetPosition', 'replenishableQty', 'warehouseRemainingQty', 'reason', 'recordedAt',
  ], changes);
  await createSheetIfMissing(sheets, spreadsheetId, SHEET_TRANSFER_NOTIFICATION_LOG, [
    'runId', 'timestamp', 'billCount', 'skuCount', 'moveRowCount', 'totalMoveQty', 'lineStatus', 'lineRequestId', 'errorMessage',
  ], changes);
  await createSheetIfMissing(sheets, spreadsheetId, SHEET_SKU_SALES, [
    'sku', 'avgDailySales', 'runId', 'sourceUpdatedAt',
  ], changes);
  // Manually-maintained reference table (per user request, 2026-08-25) — NOT
  // synced from BigSeller (no such field was found there); someone fills this
  // in by hand per SKU. A SKU with no row here just keeps the normal
  // per-unit replenishment behavior, so leaving it empty is always safe.
  await createSheetIfMissing(sheets, spreadsheetId, SHEET_SKU_CARTON_QTY, [
    'sku', 'unitsPerCarton',
  ], changes);
  await restrictEmployeeTaskViewToPickPositions(sheets, spreadsheetId, changes);

  console.log(changes.length === 0 ? 'Nothing to do — migration already applied.' : 'Migration summary:');
  for (const line of changes) console.log(' -', line);
}

async function migrateLocationCurrent(sheets: sheets_v4.Sheets, spreadsheetId: string, changes: string[]): Promise<void> {
  const header = await getValues(sheets, spreadsheetId, `${SHEET_LOCATION_CURRENT}!A1:O1`);
  const headerRow = header[0] ?? [];
  if (headerRow[13] === 'runId') {
    changes.push(`${SHEET_LOCATION_CURRENT}: runId column already present, skipped.`);
    return;
  }

  const dataUnderNO = await getValues(sheets, spreadsheetId, `${SHEET_LOCATION_CURRENT}!N2:O2`, 'FORMULA');
  if ((dataUnderNO[0] ?? []).some((cell) => cell)) {
    throw new Error(
      `${SHEET_LOCATION_CURRENT}!N2:O2 is not empty (found ${JSON.stringify(dataUnderNO[0])}) — ` +
        'refusing to overwrite the "runId" header there automatically. Inspect the sheet by hand.',
    );
  }

  await batchUpdateValues(sheets, spreadsheetId, [{ range: `${SHEET_LOCATION_CURRENT}!N1:N1`, values: [['runId']] }]);
  changes.push(`${SHEET_LOCATION_CURRENT}: relabeled the unused "canReplenish" header at N1 to "runId" (column O's stale "status" label left untouched, still unused).`);
}

async function migrateSkuInventory(sheets: sheets_v4.Sheets, spreadsheetId: string, changes: string[]): Promise<void> {
  const header = await getValues(sheets, spreadsheetId, `${SHEET_SKU_INVENTORY}!A1:I1`);
  const headerRow = header[0] ?? [];
  const renameMap: Record<string, string> = {
    totalStock: 'totalWarehouseStock',
    lockedStock: 'lockedWarehouseStock',
    availableStock: 'availableWarehouseStock',
    unshelvedStock: 'unshelvedWarehouseStock',
  };
  const renamed = headerRow.map((h: string) => renameMap[h] ?? h);
  if (JSON.stringify(renamed) !== JSON.stringify(headerRow)) {
    await batchUpdateValues(sheets, spreadsheetId, [
      { range: `${SHEET_SKU_INVENTORY}!A1:${columnLetter(renamed.length)}1`, values: [renamed] },
    ]);
    changes.push(`${SHEET_SKU_INVENTORY}: renamed headers to totalWarehouseStock/lockedWarehouseStock/availableWarehouseStock/unshelvedWarehouseStock.`);
  }
  await addTrailingHeader(sheets, spreadsheetId, SHEET_SKU_INVENTORY, 'runId', changes);
}

async function addTrailingHeader(sheets: sheets_v4.Sheets, spreadsheetId: string, sheetName: string, headerName: string, changes: string[]): Promise<void> {
  const existing = await getValues(sheets, spreadsheetId, `${sheetName}!A1:Z1`);
  const headerRow = existing[0] ?? [];
  if (headerRow.includes(headerName)) {
    changes.push(`${sheetName}: "${headerName}" column already present, skipped.`);
    return;
  }
  const col = columnLetter(headerRow.length + 1);
  await batchUpdateValues(sheets, spreadsheetId, [{ range: `${sheetName}!${col}1`, values: [[headerName]] }]);
  changes.push(`${sheetName}: added "${headerName}" header at column ${col}.`);
}

/**
 * From this feature onward, DB_LOCATION_CURRENT starts holding BOTH pick
 * positions AND storage positions (the transfer-plan feature needs storage
 * rows as move sources — see `syncLocationAllTypes` in sync-service.ts).
 * EMPLOYEE_TASK_VIEW's QUERY previously had no positionType filter at all
 * because every row it ever saw was already pick-only; now it must filter
 * explicitly (column E = positionType) or staff would suddenly see storage
 * positions mixed into their pick list.
 */
async function restrictEmployeeTaskViewToPickPositions(sheets: sheets_v4.Sheets, spreadsheetId: string, changes: string[]): Promise<void> {
  const formulaRow = await getValues(sheets, spreadsheetId, `${SHEET_EMPLOYEE_TASK_VIEW}!A2:A2`, 'FORMULA');
  const formula = formulaRow[0]?.[0] ?? '';
  if (!formula) {
    changes.push(`${SHEET_EMPLOYEE_TASK_VIEW}: A2 is empty, skipped (nothing to update).`);
    return;
  }
  if (formula.includes(`E = '${PICK_POSITION_TYPE_NAME}'`)) {
    changes.push(`${SHEET_EMPLOYEE_TASK_VIEW}: pick-position filter already present, skipped.`);
    return;
  }
  const updated = formula.replace(/where A is not null and/g, `where A is not null and E = '${PICK_POSITION_TYPE_NAME}' and`);
  if (updated === formula) {
    throw new Error(`${SHEET_EMPLOYEE_TASK_VIEW}!A2's formula did not match the expected "where A is not null and ..." shape — refusing to edit it blind. Inspect by hand.`);
  }
  await batchUpdateValues(sheets, spreadsheetId, [{ range: `${SHEET_EMPLOYEE_TASK_VIEW}!A2`, values: [[updated]] }]);
  changes.push(`${SHEET_EMPLOYEE_TASK_VIEW}: added "positionType = '${PICK_POSITION_TYPE_NAME}'" filter to the QUERY so storage-position rows (now also synced) don't leak into the employee view.`);
}

async function createSheetIfMissing(sheets: sheets_v4.Sheets, spreadsheetId: string, sheetName: string, headers: string[], changes: string[]): Promise<void> {
  const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties.title' });
  const exists = (meta.data.sheets ?? []).some((s) => s.properties?.title === sheetName);
  if (exists) {
    changes.push(`${sheetName}: sheet already exists, skipped.`);
    return;
  }
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests: [{ addSheet: { properties: { title: sheetName } } }] },
  });
  await batchUpdateValues(sheets, spreadsheetId, [
    { range: `${sheetName}!A1:${columnLetter(headers.length)}1`, values: [headers] },
  ]);
  changes.push(`${sheetName}: created new sheet with header row.`);
}

async function getValues(sheets: sheets_v4.Sheets, spreadsheetId: string, range: string, valueRenderOption?: 'FORMULA'): Promise<string[][]> {
  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range, valueRenderOption });
  return (res.data.values as string[][]) ?? [];
}

// USER_ENTERED (not RAW) is deliberate here: this script writes formula strings
// (e.g. "=ARRAYFORMULA(...)") that must be interpreted as formulas, not literal text.
async function batchUpdateValues(sheets: sheets_v4.Sheets, spreadsheetId: string, data: { range: string; values: (string | number)[][] }[]): Promise<void> {
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: { valueInputOption: 'USER_ENTERED', data },
  });
}

function columnLetter(count: number): string {
  let n = count;
  let letters = '';
  while (n > 0) {
    const remainder = (n - 1) % 26;
    letters = String.fromCharCode(65 + remainder) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
