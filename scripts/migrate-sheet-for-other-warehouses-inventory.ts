import 'dotenv/config';
import { google } from 'googleapis';

/**
 * One-time setup for the extra warehouses on the stock-value page (user request 2026-11-09):
 *  1. creates DB_SKU_INVENTORY_OTHER (same columns as DB_SKU_INVENTORY) if it is missing;
 *  2. rewrites STOCK_VALUE_BY_WAREHOUSE!A2 so its stacked QUERY also reads DB_SKU_INVENTORY_OTHER;
 *  3. grows STOCK_VALUE_BY_WAREHOUSE to enough rows for the longer list. A spilling formula that runs out of grid
 *     shows #REF! for the whole block, which would blank the web page.
 *
 * Prints the plan and changes nothing unless run with --apply. Safe to run twice: if A2 already mentions the OTHER
 * tab it is left alone.
 */

const APPLY = process.argv.includes('--apply');
const SHEET_STOCK_VALUE = process.env.SHEET_STOCK_VALUE_BY_WAREHOUSE ?? 'STOCK_VALUE_BY_WAREHOUSE';
const SHEET_SKU_INVENTORY = process.env.SHEET_SKU_INVENTORY ?? 'DB_SKU_INVENTORY';
const SHEET_SKU_INVENTORY_DECOY = process.env.SHEET_SKU_INVENTORY_DECOY ?? 'DB_SKU_INVENTORY_DECOY';
const SHEET_SKU_INVENTORY_OTHER = process.env.SHEET_SKU_INVENTORY_OTHER ?? 'DB_SKU_INVENTORY_OTHER';
const SHEET_STOCK_VALUE_REF = process.env.SHEET_STOCK_VALUE_BIGSELLER ?? 'DB_STOCK_VALUE_BIGSELLER';
const REF_HEADERS = ['warehouse', 'onHandUnits', 'bigsellerOnHandCost', 'inTransitUnits', 'bigsellerInTransitCost', 'skuRows', 'sourceUpdatedAt'];
const HEADERS = [
  'sku', 'warehouse', 'totalWarehouseStock', 'lockedWarehouseStock',
  'availableWarehouseStock', 'unshelvedWarehouseStock', 'sourceUpdatedAt', 'sourceUrl',
];
/** Rows the stacked list may reach: ~5,500 today (STOCK_5 1.6k + decoy 0.7k + other 3.2k) plus room to grow. */
const MIN_ROWS = 8000;

const q = (sheet: string) => `QUERY(${sheet}!A2:C, "select A, B, C where A is not null", 0)`;
const DETAIL_QUERY_FORMULA = `={${q(SHEET_SKU_INVENTORY)}; ${q(SHEET_SKU_INVENTORY_DECOY)}; ${q(SHEET_SKU_INVENTORY_OTHER)}}`;

async function main() {
  const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
  if (!spreadsheetId) throw new Error('GOOGLE_SHEETS_SPREADSHEET_ID is not set in .env');
  const auth = new google.auth.GoogleAuth({ scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  const sheets = google.sheets({ version: 'v4', auth: (await auth.getClient()) as never });

  const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties(sheetId,title,gridProperties)' });
  const byTitle = new Map((meta.data.sheets ?? []).map((s) => [s.properties?.title ?? '', s.properties]));
  const stockValue = byTitle.get(SHEET_STOCK_VALUE);
  if (!stockValue?.sheetId && stockValue?.sheetId !== 0) throw new Error(`${SHEET_STOCK_VALUE} not found — run migrate-sheet-for-stock-value.ts first`);

  const currentA2 = (
    await sheets.spreadsheets.values.get({ spreadsheetId, range: `${SHEET_STOCK_VALUE}!A2`, valueRenderOption: 'FORMULA' })
  ).data.values?.[0]?.[0] as string | undefined;

  const needTab = !byTitle.has(SHEET_SKU_INVENTORY_OTHER);
  const needRefTab = !byTitle.has(SHEET_STOCK_VALUE_REF);
  const needFormula = !currentA2?.includes(SHEET_SKU_INVENTORY_OTHER);
  const rowCount = stockValue.gridProperties?.rowCount ?? 0;
  const needRows = Math.max(0, MIN_ROWS - rowCount);

  console.log(JSON.stringify({ apply: APPLY, create_tab: needTab, create_reference_tab: needRefTab, rewrite_formula_A2: needFormula, add_rows: needRows, current_rows: rowCount }, null, 2));
  if (needFormula) console.log('new A2 formula:', DETAIL_QUERY_FORMULA);
  if (!APPLY) {
    console.log('Nothing changed. Re-run with --apply to make these changes.');
    return;
  }

  if (needTab) {
    await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests: [{ addSheet: { properties: { title: SHEET_SKU_INVENTORY_OTHER } } }] } });
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${SHEET_SKU_INVENTORY_OTHER}!A1:${String.fromCharCode(64 + HEADERS.length)}1`,
      valueInputOption: 'RAW',
      requestBody: { values: [HEADERS] },
    });
    console.log(`${SHEET_SKU_INVENTORY_OTHER}: created with header row.`);
  }
  if (needRefTab) {
    await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests: [{ addSheet: { properties: { title: SHEET_STOCK_VALUE_REF } } }] } });
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${SHEET_STOCK_VALUE_REF}!A1:${String.fromCharCode(64 + REF_HEADERS.length)}1`,
      valueInputOption: 'RAW',
      requestBody: { values: [REF_HEADERS] },
    });
    console.log(`${SHEET_STOCK_VALUE_REF}: created with header row.`);
  }
  if (needRows > 0) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ appendDimension: { sheetId: stockValue.sheetId, dimension: 'ROWS', length: needRows } }] },
    });
    console.log(`${SHEET_STOCK_VALUE}: added ${needRows} rows.`);
  }
  // An empty tab makes the stacked QUERY return nothing, which can break the whole spill — so the formula is only
  // rewritten once DB_SKU_INVENTORY_OTHER has at least one data row (run `npm run sync:other-warehouses-inventory`
  // with DRY_RUN=false first, then this script again).
  const otherHasData = !!(
    await sheets.spreadsheets.values.get({ spreadsheetId, range: `${SHEET_SKU_INVENTORY_OTHER}!A2` })
  ).data.values?.[0]?.[0];
  if (needFormula && !otherHasData) {
    console.log(`${SHEET_SKU_INVENTORY_OTHER} has no data rows yet — A2 left unchanged. Fill it, then run this script again.`);
  } else if (needFormula) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${SHEET_STOCK_VALUE}!A2`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[DETAIL_QUERY_FORMULA]] },
    });
    console.log(`${SHEET_STOCK_VALUE}!A2 rewritten.`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
