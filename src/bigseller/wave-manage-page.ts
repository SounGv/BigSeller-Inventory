import type { Page } from '@playwright/test';
import { dismissOrderPageOverlays } from './order-page-overlays.js';
import { dismissLanguageSwitchGuideIfPresent, clickThroughGuide } from './dismiss-language-guide.js';
import { humanDelay } from '../utils/human-delay.js';

export const WAVE_MANAGE_URL = process.env.BIGSELLER_WAVE_MANAGE_URL ?? 'https://www.bigseller.com/web/waveShip/wave/waveManage.htm';

/**
 * Page Object for WMS → การจัดการ Wave → รายการ Wave
 * (`waveShip/wave/waveManage.htm`) — where staff already create Waves
 * themselves (one Wave per COM 7 branch batch, "ประเภท Wave" =
 * "สร้างด้วยตนเอง", confirmed live 2026-09-09) and print shipping labels for
 * a picking wave.
 *
 * Per the user's own description of today's real workflow — "พนักงานยืนยัน
 * ออเดอร์แล้ว สร้าง wave แล้วปริ้น" (staff confirm orders, create the Wave,
 * then print) — this repo automates ONLY the last step (select every listed
 * Wave, print labels for all of them at once). Wave creation and order
 * confirmation stay manual, on purpose (see FEATURE-branch-grouped-batch-print.md's
 * open questions — confirmed 2026-09-09: don't fold order confirmation into
 * an unattended script, that's a business decision, not a print-formatting fix).
 *
 * `ร้านค้า` filter here uses BigSeller's newer custom select widget
 * (`bs-new-select_*` classes, no `role=option` at all) — same markup family
 * already fixed once this session on the moving-goods page
 * (`moving-goods-page.ts`'s `warehouseOption`) — reuse the same dual
 * role=option/class-based locator for resilience.
 */
export class BigSellerWaveManagePage {
  constructor(private readonly page: Page) {}

  async goto(): Promise<void> {
    await this.page.goto(WAVE_MANAGE_URL, { waitUntil: 'domcontentloaded' });
    await this.page.waitForTimeout(2500);
    await dismissOrderPageOverlays(this.page);
    await this.page.keyboard.press('Escape').catch(() => undefined);
  }

  /**
   * This filter is actually TWO side-by-side controls, confirmed live
   * 2026-09-09 via a raw DOM dump — easy to miss since only one is visible
   * as "ร้านค้า" text:
   *   1. A `bs-new-select_normal_select` TYPE-selector (options: "ร้านค้า" /
   *      "กลุ่มร้านค้า" — store vs. store-GROUP), which is what displays the
   *      literal text "ร้านค้า" when nothing else has been touched. This is
   *      NOT the store-value picker — an earlier version of this method
   *      wrongly opened THIS one and then couldn't find "COM 7" among its
   *      only 2 options ("ร้านค้า"/"กลุ่มร้านค้า"), timing out.
   *   2. The REAL value-picker, a `bs-new-select_multiple_select` (checkbox
   *      multi-select, `hascheckall="true"`) immediately after #1 in the DOM,
   *      showing "ทั้งหมด" by default — this is where "COM 7" actually lives
   *      as one of 37 real store options (confirmed via live dump).
   * Scoped via the shared `.flex` row wrapping both, then picks the
   * `_multiple_select` one specifically to disambiguate from #1.
   */
  private get storeValuePicker() {
    return this.page
      .locator('div.flex', { has: this.page.locator('[title="ร้านค้า"]') })
      .locator('.bs-new-select_multiple_select .inp_box')
      .first();
  }

  private storeOption(name: string) {
    return this.page.locator(`[role="option"]:text-is("${name}"), .bs-new-select_select_option_title_text:text-is("${name}")`);
  }

  async selectStoreFilter(name: string): Promise<void> {
    await dismissLanguageSwitchGuideIfPresent(this.page);
    await clickThroughGuide(this.page, this.storeValuePicker);
    await humanDelay(300, 600);
    await clickThroughGuide(this.page, this.storeOption(name));
    await humanDelay(200, 400);

    // Confirmed live 2026-09-09: this multi-select checkbox dropdown does
    // NOT reliably close on Escape alone (a screenshot right after Escape
    // still showed the option panel open, overlapping the wave table below
    // it) — a stray-open panel here previously caused selectAllWaves()'s
    // header-checkbox click to silently select nothing. Click the filter
    // section's own "ตัวกรองอื่นๆ" label (a neutral, always-present target
    // with no click handler of its own) to force focus away, THEN Escape as
    // a second measure, and positively wait for the option panel to be
    // gone rather than assuming either one worked.
    await this.page.getByText('ตัวกรองอื่นๆ', { exact: true }).click({ timeout: 2000 }).catch(() => undefined);
    await this.page.keyboard.press('Escape').catch(() => undefined);
    await this.storeOption(name).first().waitFor({ state: 'hidden', timeout: 3000 }).catch(() => undefined);
    await humanDelay();
  }

  /**
   * "รอหยิบสินค้า" (waiting to pick) is the default landing tab and the one
   * that matters for a pre-pick-wave print run — a Wave that's already
   * packed/completed has nothing left to print for this purpose. Exposed as
   * a parameter (not hardcoded) in case a future need also wants to
   * re-print e.g. "รอบรรจุสินค้า".
   */
  async selectTab(tabName: string): Promise<void> {
    await dismissOrderPageOverlays(this.page);
    await clickThroughGuide(this.page, this.page.getByText(tabName, { exact: true }).first());
    await humanDelay();
  }

  /**
   * The header "select all" checkbox — matched by its `title` attribute
   * (confirmed live 2026-09-09: `title="เลือกทั้งหมด / ยกเลิก"`), not a CSS
   * class, since this vxe-table grid's class names are generic/reused.
   * Confirmed live this matches 3 elements on the page (likely hidden
   * duplicate table instances for other tabs) — `.first()` is the visible
   * one, same reasoning as the duplicate `.pagination` bar handled in
   * new-orders-page.ts.
   */
  async selectAllWaves(): Promise<void> {
    await dismissOrderPageOverlays(this.page);
    // `title="เลือกทั้งหมด / ยกเลิก"` sits on the OUTER `<span
    // class="vxe-cell--checkbox">` wrapper, confirmed live 2026-09-09 to be
    // clickable without error but NOT toggle anything — this vxe-table
    // widget's actual click handler is bound to the INNER
    // `.vxe-checkbox--icon` span, not the title-bearing wrapper (a
    // screenshot after clicking the wrapper showed the checkbox still
    // empty and "จำนวน Wave ที่เลือก: 0" unchanged). `:visible` still
    // matters first — this title matches 3 elements, only one of which is
    // the active "รอหยิบสินค้า" tab's on-screen table (same duplicate-
    // hidden-element issue as the pagination bar in new-orders-page.ts).
    await clickThroughGuide(this.page, this.page.locator('[title="เลือกทั้งหมด / ยกเลิก"]:visible .vxe-checkbox--icon').first());
    await humanDelay();
  }

  /** Reads "จำนวน Wave ที่เลือก: N จำนวนพัสดุ: M" — the page's own live confirmation of what's currently selected, used to verify selectAllWaves() actually took effect before printing. */
  async getSelectionSummary(): Promise<{ waveCount: number; parcelCount: number }> {
    const text = (await this.page.locator('text=จำนวน Wave ที่เลือก').first().textContent()) ?? '';
    const waveMatch = text.match(/จำนวน Wave ที่เลือก\s*[:：]\s*(\d+)/);
    const parcelMatch = text.match(/จำนวนพัสดุ\s*[:：]\s*(\d+)/);
    return {
      waveCount: waveMatch ? Number(waveMatch[1]) : 0,
      parcelCount: parcelMatch ? Number(parcelMatch[1]) : 0,
    };
  }

  private get printShippingLabelsButton() {
    return this.page.getByRole('button', { name: 'พิมพ์ใบปะหน้าพัสดุ', exact: true });
  }

  /**
   * Clicks "พิมพ์ใบปะหน้าพัสดุ" for whatever Waves are currently selected.
   * NOT confirmed live yet what this produces (new tab with a PDF? direct
   * download? in-page modal?) — first real call should be watched manually
   * and this comment updated once confirmed, same as every other real
   * BigSeller action this project has automated. Returns whatever new page
   * opened, if any, so the caller can inspect/close it.
   */
  async printShippingLabels(): Promise<{ newPage: Page | null }> {
    await dismissOrderPageOverlays(this.page);
    const popupPromise = this.page.context().waitForEvent('page', { timeout: 5000 }).catch(() => null);
    await clickThroughGuide(this.page, this.printShippingLabelsButton);
    const newPage = await popupPromise;
    if (newPage) await newPage.waitForLoadState('domcontentloaded').catch(() => undefined);
    return { newPage };
  }
}
