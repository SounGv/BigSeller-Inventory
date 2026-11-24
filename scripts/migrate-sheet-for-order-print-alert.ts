import 'dotenv/config';
import { google, sheets_v4 } from 'googleapis';

/** One-time: creates DB_ORDER_PRINT_ALERT if missing. Same pattern as migrate-sheet-for-purchase-order-pending.ts. */

const SHEET_ORDER_PRINT_ALERT = process.env.SHEET_ORDER_PRINT_ALERT ?? 'DB_ORDER_PRINT_ALERT';
const HEADERS = [
  'packageNo', 'orderNo', 'store', 'platform', 'buyer', 'status', 'warehouse',
  'printNum', 'printTimes', 'orderCreatedAt', 'trackingNo', 'sourceUpdatedAt',
];

async function main() {
  const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
  if (!spreadsheetId) throw new Error('GOOGLE_SHEETS_SPREADSHEET_ID is not set in .env');

  const auth = new google.auth.GoogleAuth({ scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  const client = await auth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: client as never });

  const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties.title' });
  const exists = (meta.data.sheets ?? []).some((s) => s.properties?.title === SHEET_ORDER_PRINT_ALERT);
  if (exists) {
    console.log(`${SHEET_ORDER_PRINT_ALERT}: already exists, skipped.`);
    return;
  }

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests: [{ addSheet: { properties: { title: SHEET_ORDER_PRINT_ALERT } } }] },
  });
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${SHEET_ORDER_PRINT_ALERT}!A1:${columnLetter(HEADERS.length)}1`,
    valueInputOption: 'RAW',
    requestBody: { values: [HEADERS] },
  });
  console.log(`${SHEET_ORDER_PRINT_ALERT}: created new sheet with header row.`);
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
