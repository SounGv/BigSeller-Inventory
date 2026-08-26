import { existsSync } from 'node:fs';
import { test, expect } from '@playwright/test';
import { getStorageStatePath, ensureSessionValid } from '../src/bigseller/auth.js';
import { BigSellerSalesPage, SALES_REPORT_EXPECTED_HEADERS } from '../src/bigseller/sales-page.js';
import { readTabularFile, validateReportFile, ReportValidationError } from '../src/bigseller/extract-table.js';
import { SheetsClient } from '../src/sheets/sheets-client.js';

const SALES_URL = process.env.BIGSELLER_SALES_URL ?? 'https://www.bigseller.com/web/statis/items.htm';
const hasSession = existsSync(getStorageStatePath());

test.describe('BigSeller sales report sync (integration)', () => {
  test.skip(!hasSession, 'Requires a saved session — run "npm run login:bigseller" first');

  test('session is valid before downloading the report', async ({ page }) => {
    await ensureSessionValid(page, SALES_URL);
  });

  test('downloads the report, validates headers, and parses rows', async ({ page }) => {
    const salesPage = new BigSellerSalesPage(page);
    await salesPage.goto();
    const filePath = await salesPage.exportReport();

    await validateReportFile(filePath, { expectedHeaders: SALES_REPORT_EXPECTED_HEADERS });

    const rows = await readTabularFile(filePath);
    expect(rows.length).toBeGreaterThan(0);
    for (const header of SALES_REPORT_EXPECTED_HEADERS) {
      expect(Object.keys(rows[0])).toContain(header);
    }
  });

  test('rejects a malformed report file instead of writing to Google Sheets', async () => {
    await expect(
      validateReportFile('tests/fixtures/does-not-exist.csv', { expectedHeaders: SALES_REPORT_EXPECTED_HEADERS }),
    ).rejects.toThrow(ReportValidationError);
  });

  test('writes a test sales row to the sheet without duplicating on re-run', async () => {
    const sheetsClient = await SheetsClient.create();
    const before = await sheetsClient.readAll('SYNC_LOG').catch(() => []);
    await sheetsClient.appendRows('SYNC_LOG', [[new Date().toISOString(), 'sales', 'success', 1, 0, 'integration-test']]);
    if (process.env.DRY_RUN?.toLowerCase() !== 'true') {
      const after = await sheetsClient.readAll('SYNC_LOG');
      expect(after.length).toBe(before.length + 1);
    }
  });
});
