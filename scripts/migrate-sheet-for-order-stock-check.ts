import 'dotenv/config';
import { google, sheets_v4 } from 'googleapis';
import { STOCK_CHECK_HEADERS } from '../src/services/order-stock-check-service.js';

/**
 * One-time migration for the morning order-vs-pick-position stock check
 * (2026-09-09) — creates EMPLOYEE_STOCK_CHECK_VIEW if missing, and sets up
 * the red/ส้ม conditional-formatting rules on the `status` column so the
 * sheet is visually scannable for staff (per explicit request: "รุ่นที่ไม่พอ
 * ต้องเติมก่อนใส่สีแดง ใกล้หมดใส่สีส้มหรือเหลือง"). Safe to re-run — skips sheet
 * creation if it already exists, and always clears+re-adds just these two
 * conditional-format rules first so re-running never stacks duplicates.
 *
 * Colors are applied to the WHOLE data row (not just the status cell) via a
 * CUSTOM_FORMULA rule referencing the status column, so the highlight is
 * visible at a glance without staff needing to read the status word itself.
 */

const SHEET_STOCK_CHECK_VIEW = process.env.SHEET_EMPLOYEE_STOCK_CHECK_VIEW ?? 'EMPLOYEE_STOCK_CHECK_VIEW';

async function main() {
  const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
  if (!spreadsheetId) throw new Error('GOOGLE_SHEETS_SPREADSHEET_ID is not set in .env');

  const auth = new google.auth.GoogleAuth({ scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  const client = await auth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: client as never });

  const headers = [...STOCK_CHECK_HEADERS];
  const sheetId = await ensureSheetExists(sheets, spreadsheetId, SHEET_STOCK_CHECK_VIEW, headers);
  await ensureStatusColorRules(sheets, spreadsheetId, sheetId, headers);
  await ensureBasicFilter(sheets, spreadsheetId, sheetId, headers);

  console.log(`${SHEET_STOCK_CHECK_VIEW}: ready (sheetId=${sheetId}), red/ส้ม row-highlight + header filter applied.`);
}

async function ensureSheetExists(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
  sheetName: string,
  headers: string[],
): Promise<number> {
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

  // Always (re)write the header row, even on an already-existing sheet — safe
  // no-op if headers haven't changed, and self-heals the sheet if
  // STOCK_CHECK_HEADERS gains/reorders a column after the sheet was first
  // created (as happened 2026-09-09 when `positions` was added).
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${sheetName}!A1:${columnLetter(headers.length)}1`,
    valueInputOption: 'RAW',
    requestBody: { values: [headers] },
  });
  console.log(existing ? `${sheetName}: sheet already existed, header row refreshed.` : `${sheetName}: created new sheet with header row.`);
  return sheetId;
}

async function ensureStatusColorRules(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
  sheetId: number,
  headers: string[],
): Promise<void> {
  const statusColIndex = headers.indexOf('status'); // 0-based
  const statusColLetter = columnLetter(statusColIndex + 1);

  // Clear any conditional-format rules already on this sheet first (only
  // this sheet's rules — deleteConditionalFormatRule is by sheetId+index, so
  // deleting index 0 repeatedly drains the whole list for this sheet without
  // touching any other sheet's rules).
  const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets(properties.sheetId,conditionalFormats)' });
  const thisSheet = (meta.data.sheets ?? []).find((s) => s.properties?.sheetId === sheetId);
  const existingRuleCount = thisSheet?.conditionalFormats?.length ?? 0;
  const deleteRequests = Array.from({ length: existingRuleCount }, () => ({
    deleteConditionalFormatRule: { sheetId, index: 0 },
  }));

  const range: sheets_v4.Schema$GridRange = { sheetId, startRowIndex: 1, startColumnIndex: 0, endColumnIndex: headers.length };

  const addRequests = [
    { color: { red: 0.96, green: 0.8, blue: 0.8 }, statusText: 'แดง' }, // red
    { color: { red: 1, green: 0.9, blue: 0.6 }, statusText: 'ส้ม' }, // orange
  ].map(({ color, statusText }, index) => ({
    addConditionalFormatRule: {
      rule: {
        ranges: [range],
        booleanRule: {
          condition: { type: 'CUSTOM_FORMULA', values: [{ userEnteredValue: `=$${statusColLetter}2="${statusText}"` }] },
          format: { backgroundColor: color },
        },
      },
      index,
    },
  }));

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests: [...deleteRequests, ...addRequests] },
  });
}

/**
 * Adds the standard Google Sheets header-row filter (the dropdown arrows for
 * sort/filter-by-value on every column) — per explicit user request
 * (2026-09-09): "ใส่ตัวกรอง เรียง sku หรือ ตำแหน่ง ถ้าจะให้หาง่ายๆ". Lets staff
 * sort/search by `sku`, `positions`, or `status` themselves in the sheet UI,
 * independent of whatever default sort order the sync script writes rows in.
 * `setBasicFilter` replaces any existing basic filter on the sheet, so this
 * is safe to re-run.
 */
async function ensureBasicFilter(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
  sheetId: number,
  headers: string[],
): Promise<void> {
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        {
          setBasicFilter: {
            filter: { range: { sheetId, startRowIndex: 0, startColumnIndex: 0, endColumnIndex: headers.length } },
          },
        },
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
