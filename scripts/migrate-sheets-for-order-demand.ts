import 'dotenv/config';
import { google, sheets_v4 } from 'googleapis';

/**
 * One-time migration for FEATURE-pending-demand-and-offline-lock.md — creates
 * the two new sheets syncOrderDemand() writes to, if they don't already
 * exist. Safe to re-run (checks current state first). Same pattern as
 * migrate-sheets-for-transfer-plan.ts.
 */

const SHEET_PENDING_ORDER_DEMAND = process.env.SHEET_PENDING_ORDER_DEMAND ?? 'DB_PENDING_ORDER_DEMAND';
const SHEET_OFFLINE_LOCK = process.env.SHEET_OFFLINE_LOCK ?? 'DB_OFFLINE_LOCK';

async function main() {
  const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
  if (!spreadsheetId) throw new Error('GOOGLE_SHEETS_SPREADSHEET_ID is not set in .env');

  const auth = new google.auth.GoogleAuth({ scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  const client = await auth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: client as never });

  const changes: string[] = [];
  await createSheetIfMissing(sheets, spreadsheetId, SHEET_PENDING_ORDER_DEMAND, [
    'sku', 'qty', 'store', 'channel', 'orderTime', 'sourceUrl',
  ], changes);
  await createSheetIfMissing(sheets, spreadsheetId, SHEET_OFFLINE_LOCK, [
    'sku', 'qty', 'lockOrderNo', 'lockStatus', 'orderTime', 'sourceUrl',
  ], changes);

  console.log(changes.length === 0 ? 'Nothing to do — migration already applied.' : 'Migration summary:');
  for (const line of changes) console.log(' -', line);
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
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${sheetName}!A1:${columnLetter(headers.length)}1`,
    valueInputOption: 'RAW',
    requestBody: { values: [headers] },
  });
  changes.push(`${sheetName}: created new sheet with header row.`);
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
