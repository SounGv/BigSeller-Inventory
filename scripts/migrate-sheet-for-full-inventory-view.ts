import 'dotenv/config';
import { google, sheets_v4 } from 'googleapis';

/**
 * One-time setup for a complete stock-per-position view, per explicit user
 * request (2026-11-09): "รายการสินค้าคงคลังหมดทั้งนะ ทุกๆตำแหน่งเก็บ" — every
 * position, not just pick positions.
 *
 * Confirmed live (2026-11-09) that EMPLOYEE_TASK_VIEW already does exactly
 * this kind of thing for pick positions ONLY, via a single spilling QUERY()
 * formula reading DB_LOCATION_CURRENT — no sync script of its own, it just
 * stays live as that sheet refreshes. This sheet is the same mechanism
 * without the `positionType = 'ตำแหน่งหยิบสินค้า'` filter, so it covers both
 * ตำแหน่งหยิบสินค้า (pick) and ตำแหน่งเก็บสินค้า (storage) positions. Deliberately
 * drops EMPLOYEE_TASK_VIEW's "เติมได้อีก"/"สถานะ" replenishment-task columns —
 * those are meaningful only for a pick position's refill target, not for a
 * storage position, and showing them here would misleadingly suggest a
 * storage row "needs refilling" too.
 *
 * Zero new TypeScript/automation needed — this is a formula, so it is always
 * exactly as fresh as DB_LOCATION_CURRENT itself (kept current by the
 * existing inventory-sync schedule). Safe to re-run: skips sheet creation if
 * it exists, always rewrites the header+formula row and the basic filter.
 */

const SHEET_FULL_INVENTORY_VIEW = process.env.SHEET_EMPLOYEE_INVENTORY_FULL_VIEW ?? 'EMPLOYEE_INVENTORY_FULL_VIEW';

const HEADERS = [
  'ชื่อSKU', 'พื้นที่คลัง', 'ตำแหน่ง', 'ประเภทตำแหน่ง', 'สต็อกที่มีอยู่ของตำแหน่ง',
  'ตำแหน่งถูกล็อคแล้ว', 'สต็อกพร้อมขายของตำแหน่ง', 'เติมสต็อกสูงสุด', 'เติมสต็อกต่ำสุด',
  'คงเหลือทั้งหมดทั้งคลัง',
];

// Same QUERY shape as EMPLOYEE_TASK_VIEW (verified live via valueRenderOption:
// 'FORMULA' before writing this) — columns A,C,D,E,F,G,H,J,K of
// DB_LOCATION_CURRENT!A2:M map to sku, area, position, positionType,
// stockAtPosition, lockedStock, availableStock, maxStock, minStock. No
// positionType filter this time (that's the entire point of this sheet), and
// the same "ไม่มีตำแหน่ง" placeholder rows are still pushed to the end rather
// than dropped, for the same "stay complete, don't hide anything" reason.
const QUERY_FORMULA =
  `={QUERY(DB_LOCATION_CURRENT!A2:M, "select A, C, D, E, F, G, H, J, K where A is not null and not D contains 'ไม่มีตำแหน่ง' order by D", 0); ` +
  `QUERY(DB_LOCATION_CURRENT!A2:M, "select A, C, D, E, F, G, H, J, K where A is not null and D contains 'ไม่มีตำแหน่ง' order by D", 0)}`;

const TOTAL_STOCK_FORMULA = `=ARRAYFORMULA(IF($A2:$A="","",IFERROR(VLOOKUP($A2:$A,DB_SKU_INVENTORY!$A:$C,3,FALSE),0)))`;

async function main() {
  const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
  if (!spreadsheetId) throw new Error('GOOGLE_SHEETS_SPREADSHEET_ID is not set in .env');

  const auth = new google.auth.GoogleAuth({ scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  const client = await auth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: client as never });

  const sheetId = await ensureSheetExists(sheets, spreadsheetId, SHEET_FULL_INVENTORY_VIEW);
  await writeHeaderAndFormulas(sheets, spreadsheetId);
  await ensureBasicFilter(sheets, spreadsheetId, sheetId);

  console.log(`${SHEET_FULL_INVENTORY_VIEW}: ready (sheetId=${sheetId}) — live formula view, every position, header filter applied.`);
}

async function ensureSheetExists(sheets: sheets_v4.Sheets, spreadsheetId: string, sheetName: string): Promise<number> {
  const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties' });
  const existing = (meta.data.sheets ?? []).find((s) => s.properties?.title === sheetName);
  if (existing) {
    console.log(`${sheetName}: sheet already exists, reusing it.`);
    return existing.properties!.sheetId!;
  }

  const res = await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests: [{ addSheet: { properties: { title: sheetName } } }] },
  });
  console.log(`${sheetName}: created new sheet.`);
  return res.data.replies![0].addSheet!.properties!.sheetId!;
}

async function writeHeaderAndFormulas(sheets: sheets_v4.Sheets, spreadsheetId: string): Promise<void> {
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${SHEET_FULL_INVENTORY_VIEW}!A1:${columnLetter(HEADERS.length)}1`,
    valueInputOption: 'RAW',
    requestBody: { values: [HEADERS] },
  });
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${SHEET_FULL_INVENTORY_VIEW}!A2`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[QUERY_FORMULA]] },
  });
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${SHEET_FULL_INVENTORY_VIEW}!J2`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[TOTAL_STOCK_FORMULA]] },
  });
}

async function ensureBasicFilter(sheets: sheets_v4.Sheets, spreadsheetId: string, sheetId: number): Promise<void> {
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        { setBasicFilter: { filter: { range: { sheetId, startRowIndex: 0, startColumnIndex: 0, endColumnIndex: HEADERS.length } } } },
      ],
    },
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
