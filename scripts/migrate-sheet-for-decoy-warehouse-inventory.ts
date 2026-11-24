import 'dotenv/config';
import { google, sheets_v4 } from 'googleapis';

/** One-time: creates DB_SKU_INVENTORY_DECOY if missing. Same pattern as migrate-sheets-for-order-demand.ts. */

const SHEET_SKU_INVENTORY_DECOY = process.env.SHEET_SKU_INVENTORY_DECOY ?? 'DB_SKU_INVENTORY_DECOY';
const HEADERS = [
  'sku', 'warehouse', 'totalWarehouseStock', 'lockedWarehouseStock',
  'availableWarehouseStock', 'unshelvedWarehouseStock', 'sourceUpdatedAt', 'sourceUrl',
];

async function main() {
  const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
  if (!spreadsheetId) throw new Error('GOOGLE_SHEETS_SPREADSHEET_ID is not set in .env');

  const auth = new google.auth.GoogleAuth({ scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  const client = await auth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: client as never });

  const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties.title' });
  const exists = (meta.data.sheets ?? []).some((s) => s.properties?.title === SHEET_SKU_INVENTORY_DECOY);
  if (exists) {
    console.log(`${SHEET_SKU_INVENTORY_DECOY}: already exists, skipped.`);
    return;
  }

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests: [{ addSheet: { properties: { title: SHEET_SKU_INVENTORY_DECOY } } }] },
  });
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${SHEET_SKU_INVENTORY_DECOY}!A1:${columnLetter(HEADERS.length)}1`,
    valueInputOption: 'RAW',
    requestBody: { values: [HEADERS] },
  });
  console.log(`${SHEET_SKU_INVENTORY_DECOY}: created new sheet with header row.`);
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
