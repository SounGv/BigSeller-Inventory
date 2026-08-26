import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { validateReportFile, readTabularFile } from './extract-table.js';
import { dismissLanguageSwitchGuideIfPresent, clickThroughGuide } from './dismiss-language-guide.js';
import type { SkuSalesRow } from '../types.js';
import { logger } from '../utils/logger.js';
import { humanDelay } from '../utils/human-delay.js';

const SKU_SALES_REPORT_URL = process.env.BIGSELLER_SKU_SALES_URL ?? 'https://www.bigseller.com/web/statis/warehouse/saleout.htm';
const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR ?? './tmp';

/**
 * Only the columns this feature actually depends on. The button is literally
 * labelled "ดาวน์โหลดรายงาน" but triggers the exact same async export-job
 * pattern as every other BigSeller report on this project ("ส่งออกข้อมูลสำเร็จ"
 * then a "ดาวน์โหลด" link), so this page object mirrors `inventory-page.ts` /
 * `sku-inventory-page.ts`.
 *
 * Confirmed live (2026-08-25) against a real downloaded file: the on-screen
 * column reads just "SKU", but the exported file's own header is "ชื่อSKU" —
 * same as `sku-inventory-page.ts`'s SKU column, and a different string from
 * what's shown on screen (the on-screen label was assumed correct without
 * checking the actual downloaded file first, which failed every real run).
 */
export const SKU_SALES_REPORT_EXPECTED_HEADERS = ['ชื่อSKU', 'เฉลี่ยรายวันการขาย Stock-Out'];

/**
 * Page Object for BigSeller's "รายงาน SKU Merchant" sales-analysis report —
 * used (2026-08-25, per user request) to identify which SKUs sell well
 * ("ขายดี") before writing a comparison note into each transfer document's
 * "หมายเหตุ" field. "เฉลี่ยรายวันการขาย Stock-Out" (average daily units sold)
 * is the chosen best-seller signal — the user confirmed the 15-day window
 * shown on screen; other columns on this report (gross profit, margin %) are
 * not used here but could be added later the same way.
 */
export class BigSellerSkuSalesReportPage {
  constructor(private readonly page: Page) {}

  private get salesReportNavLink() {
    return this.page.locator('span.module_title', { hasText: 'รายงาน SKU Merchant' });
  }

  /**
   * Confirmed live (2026-08-25) by dumping the real DOM: unlike the
   * location-level and SKU-inventory pages, this report has NO collapsible
   * "select multiple" trigger to click open — the warehouse checkboxes
   * (ทั้งหมด, STOCK_5, STOCK_1, ...) render directly inline in a plain
   * `<td class="filterTd">` next to a `<td>คลังสินค้า</td>` label, with no
   * separate confirm/apply button in that row. The earlier version of this
   * page object assumed the SKU-inventory page's dropdown mechanics by
   * analogy without checking — that assumption was wrong and caused every
   * click here to time out waiting for a trigger element that doesn't exist
   * on this page, which in turn (in `scripts/import-moves.ts`) left the
   * browser stuck on this URL and failed every subsequent transfer-document
   * import in the same run.
   */
  private get warehouseFilterRow() {
    return this.page.locator('tr', { has: this.page.locator('td', { hasText: 'คลังสินค้า' }) });
  }

  /**
   * Confirmed live (2026-08-25): the button itself is icon-only (`<i
   * class="bsicon_down">`, no text/aria-label) — "ดาวน์โหลดรายงาน" is only
   * present as a `title` attribute on the wrapping `<span
   * class="table_export_btn">`, so `getByRole('button', { name:
   * 'ดาวน์โหลดรายงาน' })` never matches it. Anchor on the wrapper's title
   * instead and click the button inside it.
   */
  private get downloadReportButton() {
    return this.page.locator('.table_export_btn[title="ดาวน์โหลดรายงาน"] button');
  }

  private get exportReadyDownloadLink() {
    return this.page.getByRole('link', { name: /ดาวน์โหลด/ });
  }

  private get exportModalCloseButton() {
    return this.page.getByRole('button', { name: /^(ตกลง|ปิด)$/ });
  }

  async ensureView(): Promise<void> {
    // Confirmed live (2026-08-25): a plain dismiss-then-click lost the race
    // against the onboarding guide on this page across all 3 retry attempts
    // — see `clickThroughGuide`'s doc comment for why a single dismiss isn't
    // enough here specifically.
    await clickThroughGuide(this.page, this.salesReportNavLink);
    await humanDelay();
  }

  /** Toggles the inline checkboxes in the "คลังสินค้า" filter row directly — see `warehouseFilterRow` above for why this differs from the other page objects' dropdown pattern. No confirm/apply button exists in this row; checking a box takes effect immediately. */
  async selectWarehouse(name: string): Promise<void> {
    await dismissLanguageSwitchGuideIfPresent(this.page);

    const labels = this.warehouseFilterRow.locator('label.ant-checkbox-wrapper');
    const count = await labels.count();
    for (let i = 0; i < count; i++) {
      const label = labels.nth(i);
      const text = (await label.textContent())?.trim();
      if (text === 'ทั้งหมด') continue; // the "select all" meta-checkbox, not a real warehouse
      const isChecked = ((await label.getAttribute('class')) ?? '').includes('ant-checkbox-wrapper-checked');
      if (text === name && !isChecked) {
        await clickThroughGuide(this.page, label);
        await humanDelay(200, 500);
      } else if (text !== name && isChecked) {
        await clickThroughGuide(this.page, label);
        await humanDelay(200, 500);
      }
    }
  }

  async selectTimeWindow(label: string): Promise<void> {
    // Confirmed live (2026-08-25): the onboarding guide reappeared and
    // blocked this click too, on a run where ensureView/selectWarehouse had
    // already gotten past it — it recurs on this page throughout the
    // session, not just once at load, so every click here goes through
    // clickThroughGuide rather than only the first one.
    await clickThroughGuide(this.page, this.page.getByRole('link', { name: label, exact: true }));
    await humanDelay();
  }

  async exportAllRows(): Promise<SkuSalesRow[]> {
    await clickThroughGuide(this.page, this.downloadReportButton);
    await this.exportReadyDownloadLink.waitFor({ state: 'visible', timeout: 60_000 });

    await mkdir(DOWNLOAD_DIR, { recursive: true });
    const downloadPromise = this.page.waitForEvent('download');
    await clickThroughGuide(this.page, this.exportReadyDownloadLink);
    const download = await downloadPromise;

    const failure = await download.failure();
    if (failure) {
      throw new Error(`BigSeller SKU sales report export failed: ${failure}`);
    }

    const filePath = path.join(DOWNLOAD_DIR, download.suggestedFilename());
    await download.saveAs(filePath);
    await validateReportFile(filePath, { expectedHeaders: SKU_SALES_REPORT_EXPECTED_HEADERS });
    await logger.info(`Downloaded and validated SKU sales report: ${filePath}`);

    await this.exportModalCloseButton.click().catch(() => undefined);

    const rawRows = await readTabularFile(filePath);
    const rows: SkuSalesRow[] = rawRows
      .map((row) => ({
        sku: String(row['ชื่อSKU'] ?? '').trim(),
        avgDailySales: toNumber(row['เฉลี่ยรายวันการขาย Stock-Out']),
      }))
      .filter((row) => row.sku !== '' && row.sku !== 'ทั้งหมด'); // "ทั้งหมด" ("all") is the report's own totals-row placeholder — confirmed live (2026-08-25) against a real downloaded file; the previous "--" guess never matched anything real here

    await logger.info(`SKU sales report: read ${rows.length} rows`);
    return rows;
  }
}

function toNumber(value: string | number | undefined): number {
  const n = Number(String(value ?? '').replace(/[,\s]/g, ''));
  return Number.isFinite(n) ? n : 0;
}
