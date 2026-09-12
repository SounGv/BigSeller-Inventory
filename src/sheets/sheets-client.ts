import { google, sheets_v4 } from 'googleapis';
import { logger } from '../utils/logger.js';

const DRY_RUN = (process.env.DRY_RUN ?? 'true').toLowerCase() === 'true';

export interface UpsertOptions {
  headers: string[];
  keyColumns: string[];
}

/**
 * Thin wrapper around the Google Sheets API for this project's fixed set of tabs
 * (DB_LOCATION_SNAPSHOT, DB_LOCATION_CURRENT, SYNC_LOG, ERROR_LOG, DB_REPLENISH_TRANSACTION, ...).
 *
 * Auth is via a service-account JSON key referenced by GOOGLE_APPLICATION_CREDENTIALS.
 * No credentials are ever read from source code or command-line arguments.
 */
export class SheetsClient {
  private constructor(
    private readonly sheets: sheets_v4.Sheets,
    private readonly spreadsheetId: string,
  ) {}

  static async create(): Promise<SheetsClient> {
    const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
    if (!spreadsheetId) {
      throw new Error('GOOGLE_SHEETS_SPREADSHEET_ID is not set in .env');
    }

    const auth = new google.auth.GoogleAuth({
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    const client = await auth.getClient();
    const sheets = google.sheets({ version: 'v4', auth: client as never });
    return new SheetsClient(sheets, spreadsheetId);
  }

  /**
   * Appends rows to the end of a sheet's data (never touches existing data rows).
   *
   * Two easy-to-miss Sheets API pitfalls, both confirmed the hard way against a real
   * 1,879-row sync:
   *  1. An open-ended range like "A1" lets the API's table-detection consider ANY
   *     column with content — including formula columns further right (like
   *     DB_LOCATION_CURRENT's canReplenish/status) — when deciding where "the table"
   *     ends. That silently wiped the ArrayFormula cells sitting in columns N/O.
   *     Fix: bound the range to exactly the columns being written (e.g. "A1:M1").
   *  2. insertDataOption: 'INSERT_ROWS' performs a structural row-insert, which
   *     shifts any OTHER sheet's formula that references a row at/after the insert
   *     point (e.g. a cross-sheet QUERY anchored at "DB_LOCATION_CURRENT!A2:O" got
   *     silently rewritten to "A1881:O"). Fix: use 'OVERWRITE' — we are filling
   *     already-blank rows below the header, not inserting into occupied space, so
   *     no shifting is needed and no other formula gets its references rewritten.
   */
  async appendRows(sheetName: string, rows: (string | number)[][]): Promise<void> {
    if (rows.length === 0) return;

    if (DRY_RUN) {
      await logger.info(`[DRY_RUN] Would append ${rows.length} row(s) to ${sheetName}`);
      return;
    }

    const lastCol = columnLetter(rows[0].length);
    await this.sheets.spreadsheets.values.append({
      spreadsheetId: this.spreadsheetId,
      range: `${sheetName}!A1:${lastCol}1`,
      valueInputOption: 'RAW',
      insertDataOption: 'OVERWRITE',
      requestBody: { values: rows },
    });
    await logger.info(`Appended ${rows.length} row(s) to ${sheetName}`);
  }

  async readAll(sheetName: string): Promise<string[][]> {
    const res = await this.sheets.spreadsheets.values.get({
      spreadsheetId: this.spreadsheetId,
      range: `${sheetName}!A:ZZ`,
    });
    return (res.data.values as string[][]) ?? [];
  }

  /**
   * Upserts rows into `sheetName` keyed by `options.keyColumns` (matched against
   * `options.headers`). Existing rows for a known key are overwritten in place;
   * unseen keys are appended. Call this only AFTER a corresponding snapshot append
   * has succeeded — callers must not skip the snapshot step.
   */
  async upsertRows(sheetName: string, rows: Record<string, string | number>[], options: UpsertOptions): Promise<void> {
    if (rows.length === 0) return;

    if (DRY_RUN) {
      await logger.info(`[DRY_RUN] Would upsert ${rows.length} row(s) into ${sheetName}`);
      return;
    }

    const existing = await this.readAll(sheetName);
    const headerRow = existing[0] ?? options.headers;
    const keyIndexes = options.keyColumns.map((col) => headerRow.indexOf(col));
    if (keyIndexes.some((i) => i === -1)) {
      throw new Error(`Sheet "${sheetName}" is missing one or more key columns: ${options.keyColumns.join(', ')}`);
    }

    const keyToRowNumber = new Map<string, number>();
    existing.slice(1).forEach((row, idx) => {
      const key = keyIndexes.map((i) => row[i] ?? '').join('::');
      keyToRowNumber.set(key, idx + 2); // +2: 1-indexed sheet rows, plus header row
    });

    const updates: sheets_v4.Schema$ValueRange[] = [];
    const toAppend: (string | number)[][] = [];

    for (const row of rows) {
      const rowKey = options.keyColumns.map((col) => row[col] ?? '').join('::');
      const values = options.headers.map((h) => row[h] ?? '');
      const rowNumber = keyToRowNumber.get(rowKey);
      if (rowNumber) {
        const lastCol = columnLetter(values.length);
        updates.push({ range: `${sheetName}!A${rowNumber}:${lastCol}${rowNumber}`, values: [values] });
      } else {
        toAppend.push(values);
      }
    }

    if (updates.length > 0) {
      await this.sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: this.spreadsheetId,
        requestBody: { valueInputOption: 'RAW', data: updates },
      });
    }
    if (toAppend.length > 0) {
      await this.appendRows(sheetName, toAppend);
    }

    await logger.info(`Upserted into ${sheetName}: ${updates.length} updated, ${toAppend.length} inserted`);
  }

  /**
   * Clears every data row below the header and writes `rows` fresh — for a
   * sheet that must reflect current-state-at-sync-time rather than
   * accumulated history (e.g. DB_PENDING_ORDER_DEMAND, DB_OFFLINE_LOCK: a
   * closed/confirmed order must disappear on the next sync, which
   * {@link upsertRows} can never do since it only updates-or-appends and
   * never removes a key that stopped showing up). Writes the header row too
   * in case the sheet was ever completely empty. Uses `values.clear` (not
   * `values.update` with blank strings) so no stale formatting/formulas are
   * left dangling in rows past the new data.
   */
  async replaceAll(sheetName: string, headers: string[], rows: Record<string, string | number>[]): Promise<void> {
    if (DRY_RUN) {
      await logger.info(`[DRY_RUN] Would replace ${sheetName} with ${rows.length} row(s)`);
      return;
    }

    await this.sheets.spreadsheets.values.clear({
      spreadsheetId: this.spreadsheetId,
      range: `${sheetName}!A2:ZZ`,
    });

    const lastCol = columnLetter(headers.length);
    const values = [headers, ...rows.map((r) => headers.map((h) => r[h] ?? ''))];
    await this.sheets.spreadsheets.values.update({
      spreadsheetId: this.spreadsheetId,
      range: `${sheetName}!A1:${lastCol}${values.length}`,
      valueInputOption: 'RAW',
      requestBody: { values },
    });
    await logger.info(`Replaced ${sheetName}: ${rows.length} row(s) written`);
  }
}

/** Converts a 1-indexed column count to its A1-notation letter (13 -> "M", 27 -> "AA"). */
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
