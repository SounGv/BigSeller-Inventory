import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { validateReportFile, readTabularFile } from './extract-table.js';
import { clickThroughGuide } from './dismiss-language-guide.js';
import type { SkuInventoryRow } from '../types.js';
import { logger } from '../utils/logger.js';
import { humanDelay } from '../utils/human-delay.js';

const SKU_INVENTORY_URL = process.env.BIGSELLER_SKU_INVENTORY_URL ?? 'https://www.bigseller.com/web/inventory/index.htm';
const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR ?? './tmp';

/**
 * Only the columns this sync actually depends on. Confirmed live (2026-08-25)
 * across two separate real exports: "สต็อกที่ยังไม่นำเข้าชั้นวางในคลัง" is
 * NOT always present — it seems to be an optional/conditional column on this
 * report (unlike the location-level export, where the equivalent field is
 * always there), so it is read defensively below (defaults to 0 when absent)
 * rather than required here. Failing the whole sync over one non-critical
 * informational field would be the wrong trade-off — nothing in the
 * transfer-plan formulas uses unshelvedWarehouseStock at all.
 */
export const SKU_INVENTORY_REPORT_EXPECTED_HEADERS = [
  'ชื่อSKU', 'ชื่อคลังสินค้า', 'สต็อกที่มีอยู่', 'คำสั่งซื้อที่ล็อคแล้ว', 'สต็อกพร้อมขายในคลัง',
];

/**
 * Page Object for BigSeller's SKU-level totals page ("รายการสินค้าคงคลัง") — a
 * DIFFERENT page from the location-level "ตำแหน่งสต๊อค" view handled by
 * `inventory-page.ts`. This one gives one row per SKU per warehouse (totals
 * across every position), which is what Phase 3's `warehouseRemainingQty`
 * check needs and the location-level export cannot provide on its own.
 *
 * Export flow confirmed live (2026-08-25): the toolbar button here is
 * "นำเข้า & ส่งออก" (a combined import/export dropdown, unlike the plain
 * "ส่งออก" button on the location-level page) — opening it reveals
 * "ส่งออกทั้งหมด" as a directly clickable item (no submenu hover needed). The
 * same async export-job pattern applies: click → wait for
 * "ส่งออกข้อมูลสำเร็จ" → click the resulting "ดาวน์โหลด" link.
 */
export class BigSellerSkuInventoryPage {
  constructor(private readonly page: Page) {}

  private get skuInventoryNavLink() {
    return this.page.locator('span.module_title', { hasText: 'รายการสินค้าคงคลัง' });
  }

  private get importExportMenuButton() {
    return this.page.getByRole('button', { name: 'นำเข้า & ส่งออก' });
  }

  private get exportAllMenuItem() {
    return this.page.getByText('ส่งออกทั้งหมด', { exact: true });
  }

  private get exportReadyDownloadLink() {
    return this.page.getByRole('link', { name: /ดาวน์โหลด/ });
  }

  private get exportModalCloseButton() {
    return this.page.getByRole('button', { name: /^(ตกลง|ปิด)$/ });
  }

  private get warehouseFilterTrigger() {
    // Confirmed live (2026-08-25): a multi-select with a runtime-generated
    // numeric suffix on its class, same pattern as the location-level page's
    // "bs-antd_multiple_select" (see inventory-page.ts) but with different
    // literal class names on this page — anchor by partial match, not the
    // full class string.
    return this.page.locator('[class*="select_multiple_box"]').first();
  }

  private get warehouseOptionGroup() {
    // Unlike the location-level page's dropdown (a separate floating panel),
    // this page's checkbox list renders INSIDE the trigger element itself
    // (`.option_box .option_list .ant-checkbox-group`) — confirmed live by
    // walking the real DOM. Scoping to this group is what keeps this query
    // from also matching the unrelated per-row selection checkboxes in the
    // SKU table below.
    return this.warehouseFilterTrigger.locator('.ant-checkbox-group');
  }

  private get warehouseConfirmButton() {
    return this.page.getByRole('button', { name: 'ยืนยัน', exact: true });
  }

  async goto(): Promise<void> {
    await this.page.goto(SKU_INVENTORY_URL, { waitUntil: 'domcontentloaded' });
    await humanDelay();
    await this.ensureView();
  }

  /** Same rationale as `ensureLocationView()` on the location-level page: clicks the sidebar link instead of navigating, so callers that already navigated (or are switching over from the location-level view in the same sync run) don't trigger a redundant `page.goto()` race. */
  async ensureView(): Promise<void> {
    await clickThroughGuide(this.page, this.skuInventoryNavLink);
    await humanDelay();
  }

  /**
   * Checks `name` and unchecks every other warehouse in the multi-select,
   * then confirms. NOT optional — confirmed live (2026-08-25) the hard way: a
   * sync ran to completion against warehouse "STOCK_13 FBS" instead of
   * STOCK_5 (217 rows instead of the expected ~2,000+) because this page's
   * warehouse filter has its own state, independent of whatever is selected
   * on the location-level page, and nothing was ever setting it. Always call
   * this before `exportAllRows()` — never assume the account's current
   * default is the right one.
   */
  async selectWarehouse(name: string): Promise<void> {
    await clickThroughGuide(this.page, this.warehouseFilterTrigger);
    await humanDelay(200, 500);
    await this.warehouseOptionGroup.waitFor({ state: 'visible' });

    const labels = this.warehouseOptionGroup.locator('label.ant-checkbox-wrapper');
    const count = await labels.count();
    for (let i = 0; i < count; i++) {
      const label = labels.nth(i);
      const text = (await label.textContent())?.trim();
      const isChecked = ((await label.getAttribute('class')) ?? '').includes('ant-checkbox-wrapper-checked');
      if (text === name && !isChecked) {
        await clickThroughGuide(this.page, label);
        await humanDelay(100, 300);
      } else if (text !== name && isChecked) {
        await clickThroughGuide(this.page, label);
        await humanDelay(100, 300);
      }
    }

    await clickThroughGuide(this.page, this.warehouseConfirmButton);
    await humanDelay();
  }

  async exportAllRows(): Promise<SkuInventoryRow[]> {
    await this.importExportMenuButton.click();
    await this.exportAllMenuItem.waitFor({ state: 'visible' });
    await humanDelay(200, 500);
    await this.exportAllMenuItem.click();
    await this.exportReadyDownloadLink.waitFor({ state: 'visible', timeout: 60_000 });

    await mkdir(DOWNLOAD_DIR, { recursive: true });
    const downloadPromise = this.page.waitForEvent('download');
    await this.exportReadyDownloadLink.click();
    const download = await downloadPromise;

    const failure = await download.failure();
    if (failure) {
      throw new Error(`BigSeller SKU-inventory export failed: ${failure}`);
    }

    const filePath = path.join(DOWNLOAD_DIR, download.suggestedFilename());
    await download.saveAs(filePath);
    await validateReportFile(filePath, { expectedHeaders: SKU_INVENTORY_REPORT_EXPECTED_HEADERS });
    await logger.info(`Downloaded and validated SKU-inventory export: ${filePath}`);

    // Confirmed live (2026-08-25): unlike the location-level export dialog
    // (which this page has no equivalent problem with — see inventory-page.ts),
    // this modal stays open after the download click. Left open, it can block
    // a later click on a retry that reuses the same page. Close it explicitly.
    await this.exportModalCloseButton.click().catch(() => undefined);

    const sourceUrl = this.page.url();
    const sourceUpdatedAt = new Date().toISOString();
    const rawRows = await readTabularFile(filePath);

    if (rawRows.length > 0 && !('สต็อกที่ยังไม่นำเข้าชั้นวางในคลัง' in rawRows[0])) {
      await logger.info('SKU-inventory export: "สต็อกที่ยังไม่นำเข้าชั้นวางในคลัง" column absent this run — unshelvedWarehouseStock will default to 0.');
    }

    const rows: SkuInventoryRow[] = rawRows.map((row) => ({
      sku: String(row['ชื่อSKU'] ?? '').trim(),
      warehouse: String(row['ชื่อคลังสินค้า'] ?? '').trim(),
      totalWarehouseStock: toNumber(row['สต็อกที่มีอยู่']),
      lockedWarehouseStock: toNumber(row['คำสั่งซื้อที่ล็อคแล้ว']),
      availableWarehouseStock: toNumber(row['สต็อกพร้อมขายในคลัง']),
      unshelvedWarehouseStock: toNumber(row['สต็อกที่ยังไม่นำเข้าชั้นวางในคลัง']),
      sourceUpdatedAt,
      sourceUrl,
    }));

    if (rows.length === 0) {
      throw new Error('SKU-inventory export parsed to 0 rows — refusing to continue.');
    }

    await logger.info(`SKU-inventory export: read ${rows.length} rows`);
    return rows;
  }
}

// `value` can be a genuine JS `number` (not just a numeric-looking string) —
// confirmed live (2026-08-25): unlike the location-level export, this
// report's stock columns come back from `xlsx` already typed as numbers for
// unformatted cells, and `.replace()` on a bare number throws.
function toNumber(value: string | number | undefined): number {
  const n = Number(String(value ?? '').replace(/[,\s]/g, ''));
  return Number.isFinite(n) ? n : 0;
}
