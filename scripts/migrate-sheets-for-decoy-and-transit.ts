import 'dotenv/config';
import { google, sheets_v4 } from 'googleapis';

/**
 * One-time: creates DECOY_RECONCILIATION_EXCEPTIONS and DB_TRANSFER_IN_TRANSIT
 * if missing — both moved here from Supabase (2026-11-09, project deleted).
 * Same pattern as migrate-sheets-for-order-demand.ts.
 */

const SHEET_DECOY_RECONCILIATION_EXCEPTIONS = process.env.SHEET_DECOY_RECONCILIATION_EXCEPTIONS ?? 'DECOY_RECONCILIATION_EXCEPTIONS';
const SHEET_TRANSFER_IN_TRANSIT = process.env.SHEET_TRANSFER_IN_TRANSIT ?? 'DB_TRANSFER_IN_TRANSIT';

async function main() {
  const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
  if (!spreadsheetId) throw new Error('GOOGLE_SHEETS_SPREADSHEET_ID is not set in .env');

  const auth = new google.auth.GoogleAuth({ scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  const client = await auth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: client as never });

  const changes: string[] = [];
  await createSheetIfMissing(sheets, spreadsheetId, SHEET_DECOY_RECONCILIATION_EXCEPTIONS, [
    'sku', 'decoyQty', 'damagedPositionQty', 'discrepancy', 'detectedAt', 'sourceUrl',
  ], changes);
  await createSheetIfMissing(sheets, spreadsheetId, SHEET_TRANSFER_IN_TRANSIT, [
    'transferNo', 'sourceWarehouse', 'destWarehouse', 'bigsellerCreatedAt', 'estimatedArrival',
    'skuCount', 'qtyTotal', 'note', 'sourceUrl', 'receivedStatus', 'receivedAt',
    'shelvedStatus', 'shelvedBy', 'shelvedAt', 'updatedAt',
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
