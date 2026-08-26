import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import * as XLSX from 'xlsx';

export class ReportValidationError extends Error {}

export interface ReportValidationOptions {
  expectedHeaders: string[];
  allowedExtensions?: string[];
}

/** Validates a downloaded report file before it is ever read into memory for sheet writes. */
export async function validateReportFile(filePath: string, options: ReportValidationOptions): Promise<void> {
  const allowedExtensions = options.allowedExtensions ?? ['.xlsx', '.csv'];
  const ext = path.extname(filePath).toLowerCase();

  const stats = await stat(filePath).catch(() => null);
  if (!stats) {
    throw new ReportValidationError(`Downloaded file does not exist: ${filePath}`);
  }
  if (stats.size === 0) {
    throw new ReportValidationError(`Downloaded file is empty (0 bytes): ${filePath}`);
  }
  if (!allowedExtensions.includes(ext)) {
    throw new ReportValidationError(`Unexpected file extension "${ext}" for ${filePath}. Expected one of ${allowedExtensions.join(', ')}`);
  }

  const rows = await readTabularFile(filePath);
  if (rows.length === 0) {
    throw new ReportValidationError(`Downloaded file has no data rows: ${filePath}`);
  }

  const actualHeaders = Object.keys(rows[0]);
  const missing = options.expectedHeaders.filter((h) => !actualHeaders.includes(h));
  if (missing.length > 0) {
    throw new ReportValidationError(
      `Downloaded file is missing expected headers [${missing.join(', ')}]. Actual headers: [${actualHeaders.join(', ')}]`,
    );
  }
}

/** Reads an .xlsx or .csv file into an array of plain row objects keyed by header. */
export async function readTabularFile(filePath: string): Promise<Record<string, string>[]> {
  const ext = path.extname(filePath).toLowerCase();

  if (ext === '.csv') {
    const content = await readFile(filePath, 'utf8');
    const workbook = XLSX.read(content, { type: 'string' });
    return sheetToRows(workbook);
  }

  const buffer = await readFile(filePath);
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  return sheetToRows(workbook);
}

function sheetToRows(workbook: XLSX.WorkBook): Record<string, string>[] {
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  return XLSX.utils.sheet_to_json<Record<string, string>>(sheet, { defval: '' });
}
