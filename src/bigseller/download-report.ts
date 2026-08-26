import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { validateReportFile } from './extract-table.js';
import { logger } from '../utils/logger.js';

const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR ?? './tmp';

export interface DownloadReportOptions {
  exportTrigger: Locator;
  expectedHeaders: string[];
  allowedExtensions?: string[];
}

/**
 * Clicks the export/download trigger, saves the resulting file, and validates it
 * before returning. Throws instead of returning a partially-checked file so callers
 * never write unverified data to Google Sheets.
 */
export async function downloadReport(page: Page, options: DownloadReportOptions): Promise<string> {
  const downloadPromise = page.waitForEvent('download');
  await options.exportTrigger.click();
  const download = await downloadPromise;

  const failure = await download.failure();
  if (failure) {
    throw new Error(`BigSeller download failed: ${failure}`);
  }

  await mkdir(DOWNLOAD_DIR, { recursive: true });
  const filePath = path.join(DOWNLOAD_DIR, download.suggestedFilename());
  await download.saveAs(filePath);

  await validateReportFile(filePath, {
    expectedHeaders: options.expectedHeaders,
    allowedExtensions: options.allowedExtensions,
  });

  await logger.info(`Downloaded and validated report: ${filePath}`);
  return filePath;
}
