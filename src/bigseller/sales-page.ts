import type { Page } from '@playwright/test';
import { downloadReport } from './download-report.js';

const SALES_URL = process.env.BIGSELLER_SALES_URL ?? 'https://www.bigseller.com/web/statis/items.htm';

export const SALES_REPORT_EXPECTED_HEADERS = [
  // TODO: verify — must match the header row of the file BigSeller actually exports.
  'SKU',
  'สินค้า',
  'จำนวนที่ขาย',
  'ยอดขาย',
];

/**
 * Page Object for the BigSeller sales-report page.
 * All selectors for this page live here ONLY — do not duplicate them elsewhere.
 *
 * NOTE: exact label text/roles below are best-effort placeholders — verify with
 * `npx playwright codegen` against the live page before production use.
 */
export class BigSellerSalesPage {
  constructor(private readonly page: Page) {}

  private get exportButton() {
    // TODO: verify — the export/download trigger for the sales report
    return this.page.getByRole('button', { name: /ส่งออก|export/i });
  }

  async goto(): Promise<void> {
    await this.page.goto(SALES_URL, { waitUntil: 'domcontentloaded' });
  }

  /** Downloads and validates the sales report file, returning its local path. */
  async exportReport(): Promise<string> {
    return downloadReport(this.page, {
      exportTrigger: this.exportButton,
      expectedHeaders: SALES_REPORT_EXPECTED_HEADERS,
      allowedExtensions: ['.xlsx', '.csv'],
    });
  }
}
