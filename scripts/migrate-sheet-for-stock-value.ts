import 'dotenv/config';
import { google, sheets_v4 } from 'googleapis';

/**
 * One-time setup for "มูลค่าสินค้าแต่ละคลัง" (stock value per warehouse), per
 * explicit user request (2026-11-09).
 *
 * Creates:
 *  - `DB_SKU_COST` (plain data sheet — filled by scripts/import-sku-cost.ts
 *    from the SKU Merchant export, same way DB_SKU_CARTON_QTY already works)
 *  - `STOCK_VALUE_BY_WAREHOUSE` (live formula view, same technique as
 *    EMPLOYEE_INVENTORY_FULL_VIEW/EMPLOYEE_TASK_VIEW — a spilling QUERY
 *    stacking DB_SKU_INVENTORY and DB_SKU_INVENTORY_DECOY's sku/warehouse/qty
 *    columns, an ARRAYFORMULA VLOOKUP against DB_SKU_COST for unit cost, a
 *    computed value column, and a grouped per-warehouse total via QUERY's
 *    own "group by" — zero new sync code, always as fresh as whichever of
 *    DB_SKU_INVENTORY/DB_SKU_INVENTORY_DECOY/DB_SKU_COST last changed)
 *
 * "Value" here means COST value (qty × ราคาต้นทุน), the only price field the
 * SKU Merchant export carries — not retail/selling price.
 */

const SHEET_SKU_COST = process.env.SHEET_SKU_COST ?? 'DB_SKU_COST';
const SHEET_STOCK_VALUE = process.env.SHEET_STOCK_VALUE_BY_WAREHOUSE ?? 'STOCK_VALUE_BY_WAREHOUSE';
const SHEET_SKU_INVENTORY = process.env.SHEET_SKU_INVENTORY ?? 'DB_SKU_INVENTORY';
const SHEET_SKU_INVENTORY_DECOY = process.env.SHEET_SKU_INVENTORY_DECOY ?? 'DB_SKU_INVENTORY_DECOY';
const SHEET_SKU_INVENTORY_OTHER = process.env.SHEET_SKU_INVENTORY_OTHER ?? 'DB_SKU_INVENTORY_OTHER';

const DETAIL_HEADERS = ['sku', 'warehouse', 'qty', 'costPrice', 'stockValue'];
const SUMMARY_HEADERS = ['คลัง', 'มูลค่ารวม'];

// Kept in sync with the live formula (2026-11-09, added after this script's first run — a
// re-run of this migration used to regress the live cell back to 2 warehouses, since this
// constant wasn't updated when DB_SKU_INVENTORY_OTHER was added to the live sheet directly).
const DETAIL_QUERY_FORMULA =
  `={QUERY(${SHEET_SKU_INVENTORY}!A2:C, "select A, B, C where A is not null", 0); ` +
  `QUERY(${SHEET_SKU_INVENTORY_DECOY}!A2:C, "select A, B, C where A is not null", 0); ` +
  `QUERY(${SHEET_SKU_INVENTORY_OTHER}!A2:C, "select A, B, C where A is not null", 0)}`;
const COST_LOOKUP_FORMULA = `=ARRAYFORMULA(IF($A2:$A="","",IFERROR(VLOOKUP($A2:$A,${SHEET_SKU_COST}!$A:$B,2,FALSE),0)))`;
const VALUE_FORMULA = `=ARRAYFORMULA(IF($A2:$A="","",$C2:$C*$D2:$D))`;
const SUMMARY_FORMULA = `=QUERY(A2:E, "select B, sum(E) where A is not null group by B label sum(E) ''", 0)`;

async function main() {
  const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
  if (!spreadsheetId) throw new Error('GOOGLE_SHEETS_SPREADSHEET_ID is not set in .env');

  const auth = new google.auth.GoogleAuth({ scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  const client = await auth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: client as never });

  await ensureSheetExists(sheets, spreadsheetId, SHEET_SKU_COST, ['sku', 'costPrice', 'currency']);
  const stockValueSheetId = await ensureSheetExists(sheets, spreadsheetId, SHEET_STOCK_VALUE, [...DETAIL_HEADERS, '', ...SUMMARY_HEADERS]);

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${SHEET_STOCK_VALUE}!A2`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[DETAIL_QUERY_FORMULA]] },
  });
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${SHEET_STOCK_VALUE}!D2`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[COST_LOOKUP_FORMULA]] },
  });
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${SHEET_STOCK_VALUE}!E2`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[VALUE_FORMULA]] },
  });
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${SHEET_STOCK_VALUE}!G2`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[SUMMARY_FORMULA]] },
  });

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        { setBasicFilter: { filter: { range: { sheetId: stockValueSheetId, startRowIndex: 0, startColumnIndex: 0, endColumnIndex: DETAIL_HEADERS.length } } } },
      ],
    },
  });

  console.log(`${SHEET_SKU_COST} and ${SHEET_STOCK_VALUE} ready.`);
}

async function ensureSheetExists(sheets: sheets_v4.Sheets, spreadsheetId: string, sheetName: string, headers: string[]): Promise<number> {
  const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties' });
  const existing = (meta.data.sheets ?? []).find((s) => s.properties?.title === sheetName);
  const sheetId = existing
    ? existing.properties!.sheetId!
    : (
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId,
          requestBody: { requests: [{ addSheet: { properties: { title: sheetName } } }] },
        })
      ).data.replies![0].addSheet!.properties!.sheetId!;

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${sheetName}!A1:${columnLetter(headers.length)}1`,
    valueInputOption: 'RAW',
    requestBody: { values: [headers] },
  });
  console.log(existing ? `${sheetName}: already existed, header row refreshed.` : `${sheetName}: created new sheet.`);
  return sheetId;
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
