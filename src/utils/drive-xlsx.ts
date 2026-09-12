import { google } from 'googleapis';
import * as XLSX from 'xlsx';

/**
 * Downloads a raw .xlsx file from Google Drive and parses it — for files
 * that are NOT native Google Sheets (SheetsClient/the Sheets API can't read
 * those, confirmed live 2026-09-02: "This operation is not supported for
 * this document. The document must not be an Office file."). Needs the
 * Drive API enabled on this GCP project (separate from the Sheets API) and
 * the file individually shared with the service account — being shared on
 * GOOGLE_SHEETS_SPREADSHEET_ID's file does nothing for a different file id.
 */
export async function downloadXlsxWorkbook(fileId: string): Promise<XLSX.WorkBook> {
  const auth = new google.auth.GoogleAuth({ scopes: ['https://www.googleapis.com/auth/drive.readonly'] });
  const client = await auth.getClient();
  const drive = google.drive({ version: 'v3', auth: client as never });
  const res = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'arraybuffer' });
  const buf = Buffer.from(res.data as ArrayBuffer);
  return XLSX.read(buf, { type: 'buffer' });
}

/** Reads a tab as an array of rows (each row an array of cells), `null` for empty cells — mirrors XLSX.utils.sheet_to_json's `header: 1` shape. */
export function readSheetRows(workbook: XLSX.WorkBook, sheetName: string): unknown[][] {
  const ws = workbook.Sheets[sheetName];
  if (!ws) throw new Error(`Sheet tab "${sheetName}" not found in workbook`);
  return XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null }) as unknown[][];
}
