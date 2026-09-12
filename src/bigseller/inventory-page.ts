import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { validateReportFile, readTabularFile } from './extract-table.js';
import { clickThroughGuide } from './dismiss-language-guide.js';
import type { InventoryRow } from '../types.js';
import { logger } from '../utils/logger.js';
import { humanDelay } from '../utils/human-delay.js';

const INVENTORY_URL = process.env.BIGSELLER_INVENTORY_URL ?? 'https://www.bigseller.com/web/inventory/warehouseInventory.htm';
const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR ?? './tmp';

/** Header row confirmed from a real "ส่งออกทั้งหมด" (export all) download, 2026-08-24. */
export const INVENTORY_REPORT_EXPECTED_HEADERS = [
  'ชื่อSKU', 'หน่วย', 'ชื่อ SKU', 'ชื่อคลังสินค้า', 'พื้นที่คลัง', 'ตำแหน่ง', 'ประเภทตำแหน่ง',
  'สต็อกที่มีอยู่ของตำแหน่ง', 'ตำแหน่งถูกล็อคแล้ว', 'สต็อกพร้อมขายของตำแหน่ง',
  'สต็อกที่ยังไม่นำเข้าชั้นวาง', 'เติมสต็อกสูงสุด', 'เติมสต็อกต่ำสุด',
];

/**
 * Page Object for the BigSeller warehouse-inventory page.
 * All selectors for this page live here ONLY — do not duplicate them elsewhere.
 *
 * Extraction uses BigSeller's own "ส่งออก > ส่งออกทั้งหมด" export feature rather than
 * scraping the on-screen table page by page. Confirmed live (2026-08-24): for a
 * filtered view of 1,879 rows across 38 pages, one export click reliably returned
 * every row in a single .xlsx file — far more reliable than DOM pagination, and the
 * same pattern already used for the sales report (see sales-page.ts). The header
 * names above and the export button flow are confirmed from that real run.
 *
 * FILTER controls, also confirmed live (2026-08-24) by inspecting the real DOM:
 *  - คลังสินค้า (warehouse) is an Ant Design multi-select ("bs-antd_multiple_select"),
 *    opened by clicking its container, with each warehouse rendered as a real
 *    `checkbox` (role) inside the opened panel.
 *  - พื้นที่คลัง (area) is a single-select Ant Design dropdown ("ant-select"), opened
 *    by clicking its container, with each choice a real `option` (role).
 *  - ประเภทตำแหน่ง (position type) is a row of plain links.
 * Both dropdowns are anchored by locating their field-label wrapper (`.filter_type`)
 * rather than a hardcoded class name, since Ant Design appends a runtime-generated
 * numeric suffix to the multi-select's class (e.g. "multiple_select_1787555089670")
 * that is not stable across page loads.
 */
export class BigSellerInventoryPage {
  constructor(private readonly page: Page) {}

  // ---- Locators -----------------------------------------------------------

  private filterField(label: string) {
    return this.page.locator('.filter_type', { hasText: label });
  }

  private get warehouseFilterTrigger() {
    // BigSeller migrated this control's markup at some point after
    // 2026-08-24 (confirmed live 2026-09-02, while building the decoy-
    // warehouse reconciliation feature): the old `bs-antd_multiple_select`
    // class is gone from the live DOM, replaced by
    // `bs-new-select_multiple_select` (still with a runtime numeric suffix,
    // e.g. `bs-new-select-vue2-multiple-1788334863153-0`) — matches both so
    // this doesn't silently break again if BigSeller only partially rolls
    // the new component out, or reverts.
    return this.filterField('คลังสินค้า').locator('[class*="bs-antd_multiple_select"], [class*="bs-new-select_multiple_select"]');
  }

  private get areaFilterTrigger() {
    return this.filterField('พื้นที่คลัง').locator('.ant-select');
  }

  private get positionTypeLink() {
    // Confirmed: a row of plain links, e.g. "ทั้งหมด" | "ตำแหน่งหยิบสินค้า" | "ตำแหน่งจัดเก็บสินค้า" | "ตำแหน่งวางสินค้าชำรุด".
    return (name: string) => this.page.getByRole('link', { name, exact: true });
  }

  private get exportMenuButton() {
    // Confirmed: purple "ส่งออก" button with a dropdown caret, top-right of the table toolbar.
    return this.page.getByRole('button', { name: /ส่งออก/ }).first();
  }

  private get exportAllMenuItem() {
    // Confirmed: dropdown item "ส่งออกทั้งหมด" (export ALL filtered rows, not just the current page/selection).
    return this.page.getByText('ส่งออกทั้งหมด', { exact: true });
  }

  private get exportReadyDownloadLink() {
    // Confirmed: the export runs as an async job; this link appears once it reports "ส่งออกข้อมูลสำเร็จ".
    return this.page.getByRole('link', { name: /ดาวน์โหลด/ });
  }

  private get exportModalCloseButton() {
    return this.page.getByRole('button', { name: /^(ตกลง|ปิด)$/ });
  }

  private get positionStockNavLink() {
    // Left sidebar item under "การจัดการคลังสินค้า" for the location-level view, as
    // opposed to "รายการสินค้าคงคลัง" (SKU-level totals). Confirmed live (2026-08-24)
    // via a raw DOM dump of the actual page: this is a plain <span class="module_title
    // ..."> with NO ARIA role — not a real <a> link, so getByRole('link', ...) could
    // never match it regardless of the text. The text itself is also not standard
    // Thai spelling: BigSeller's own label literally uses "เเ" (two เ characters)
    // instead of the single "แ" vowel, and "๊" (mai tri) instead of "็" (mai
    // taikhu) — do not "correct" this string, it must match BigSeller's actual label
    // byte-for-byte or the locator silently matches nothing.
    return this.page.locator('span.module_title', { hasText: 'ตำเเหน่งสต๊อค' });
  }

  // ---- Actions -------------------------------------------------------------

  async goto(): Promise<void> {
    await this.page.goto(INVENTORY_URL, { waitUntil: 'domcontentloaded' });
    await humanDelay();
    await this.ensureLocationView();
  }

  /**
   * Confirmed live (2026-08-24): landing on INVENTORY_URL can put you on the wrong
   * inventory sub-page — BigSeller's SPA appears to restore whichever sub-tab (e.g.
   * "รายการสินค้าคงคลัง", the SKU-level totals view) was last active for the account,
   * regardless of the literal URL requested. Clicking the sidebar link explicitly
   * guarantees we're on the location-level (ตำแหน่งสต็อค) view before touching any
   * filters. This does NOT call page.goto() — calling goto() twice back-to-back to
   * the same URL was observed to race with BigSeller's client-side routing and
   * throw ERR_ABORTED, so callers that already navigated (e.g. ensureSessionValid)
   * should call this instead of goto() to avoid a redundant second navigation.
   */
  async ensureLocationView(): Promise<void> {
    await clickThroughGuide(this.page, this.positionStockNavLink);
    await humanDelay();
  }

  /**
   * Ensures `name` is checked in the warehouse multi-select and closes the panel.
   * Does not uncheck any other already-selected warehouse — if the account's
   * default view has more than one warehouse pre-selected, verify manually that
   * `name` is the only one checked before running an unattended sync.
   */
  async selectWarehouse(name: string): Promise<void> {
    await clickThroughGuide(this.page, this.warehouseFilterTrigger);
    await humanDelay(200, 500);
    const checkbox = this.page.getByRole('checkbox', { name, exact: true });
    await checkbox.waitFor({ state: 'visible' });
    if (!(await checkbox.isChecked())) {
      await clickThroughGuide(this.page, checkbox);
      await humanDelay(200, 500);
    }
    await this.page.keyboard.press('Escape');
    await humanDelay();
  }

  async selectArea(name: string): Promise<void> {
    await clickThroughGuide(this.page, this.areaFilterTrigger);
    await humanDelay(200, 500);
    await clickThroughGuide(this.page, this.page.getByRole('option', { name, exact: true }));
    await humanDelay();
  }

  async selectPositionType(name: string): Promise<void> {
    await clickThroughGuide(this.page, this.positionTypeLink(name));
    await this.page.waitForLoadState('networkidle');
    await humanDelay();
  }

  /**
   * Triggers "ส่งออก > ส่งออกทั้งหมด", waits for the async export job to finish,
   * downloads the resulting file, validates it, and parses it into InventoryRow[].
   * warehouse/area/positionType are read per-row from the export itself — BigSeller
   * repeats them as real columns, so there is no need to stamp filter values in.
   */
  async exportAllRows(): Promise<InventoryRow[]> {
    await this.exportMenuButton.click();
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
      throw new Error(`BigSeller inventory export failed: ${failure}`);
    }

    const filePath = path.join(DOWNLOAD_DIR, download.suggestedFilename());
    await download.saveAs(filePath);
    await validateReportFile(filePath, { expectedHeaders: INVENTORY_REPORT_EXPECTED_HEADERS });
    await logger.info(`Downloaded and validated inventory export: ${filePath}`);

    // Confirmed live (2026-08-25): this export-progress dialog is NOT scoped to
    // the current page — left open, it stayed pinned on top and blocked a
    // sidebar-link click on a LATER, unrelated page navigation (an export job
    // status widget the account carries across pages, not a per-page popup).
    // Close it explicitly rather than assuming it will go away on its own.
    await this.exportModalCloseButton.click().catch(() => undefined);

    const sourceUrl = this.page.url();
    const sourceUpdatedAt = new Date().toISOString();
    const rawRows = await readTabularFile(filePath);

    const rows: InventoryRow[] = rawRows.map((row) => ({
      sku: String(row['ชื่อSKU'] ?? '').trim(),
      warehouse: String(row['ชื่อคลังสินค้า'] ?? '').trim(),
      area: String(row['พื้นที่คลัง'] ?? '').trim(),
      position: String(row['ตำแหน่ง'] ?? '').trim(),
      positionType: String(row['ประเภทตำแหน่ง'] ?? '').trim(),
      stockAtPosition: toNumber(row['สต็อกที่มีอยู่ของตำแหน่ง']),
      lockedStock: toNumber(row['ตำแหน่งถูกล็อคแล้ว']),
      availableStock: toNumber(row['สต็อกพร้อมขายของตำแหน่ง']),
      unshelvedStock: toNumber(row['สต็อกที่ยังไม่นำเข้าชั้นวาง']),
      maxStock: toNumber(row['เติมสต็อกสูงสุด']),
      minStock: toNumber(row['เติมสต็อกต่ำสุด']),
      sourceUpdatedAt,
      sourceUrl,
    }));

    if (rows.length === 0) {
      throw new Error('Inventory export parsed to 0 rows — refusing to continue.');
    }

    await logger.info(`Inventory export: read ${rows.length} rows`);
    return rows;
  }
}

// `value` can come back as a genuine JS `number` for unformatted cells, not
// just a numeric-looking string (confirmed live 2026-08-25 on the sibling
// SKU-inventory report) — coerce through String() first so `.replace()` never
// gets called on a bare number.
function toNumber(value: string | number | undefined): number {
  const n = Number(String(value ?? '').replace(/[,\s]/g, ''));
  return Number.isFinite(n) ? n : 0;
}
