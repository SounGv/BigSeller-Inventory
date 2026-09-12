import type { Page } from '@playwright/test';
import { BigSellerWaveManagePage } from '../bigseller/wave-manage-page.js';
import { logger } from '../utils/logger.js';

const STORE_NAME = process.env.WAVE_PRINT_STORE_NAME ?? 'COM 7';
const TAB_NAME = process.env.WAVE_PRINT_TAB_NAME ?? 'รอหยิบสินค้า';

export interface WavePrintResult {
  waveCount: number;
  parcelCount: number;
  printed: boolean;
}

/**
 * Automates only the LAST step of today's real workflow — confirmed with
 * the user 2026-09-09: "พนักงานยืนยันออเดอร์แล้ว สร้าง wave แล้วปริ้น" (staff
 * already confirm orders and create the Wave by hand; this just selects
 * every already-created Wave for `STORE_NAME` and prints shipping labels for
 * all of them in one action). Order confirmation and Wave creation are
 * deliberately NOT automated (see FEATURE-branch-grouped-batch-print.md's
 * open questions — confirmed: don't fold a business decision like order
 * confirmation into an unattended script).
 *
 * Gated by `AUTO_PRINT_WAVES`, same pattern as `AUTO_IMPORT` for
 * import-moves-service.ts — this is the one real, hard-to-undo action here
 * (clicking BigSeller's own print button), so a dry run (default) only
 * selects the Waves and reports what WOULD be printed, without ever
 * clicking "พิมพ์ใบปะหน้าพัสดุ".
 */
export async function printWaveShippingLabels(page: Page): Promise<WavePrintResult> {
  const autoPrint = (process.env.AUTO_PRINT_WAVES ?? 'false').toLowerCase() === 'true';

  const wavePage = new BigSellerWaveManagePage(page);
  await wavePage.goto();
  await wavePage.selectTab(TAB_NAME);
  await wavePage.selectStoreFilter(STORE_NAME);
  await wavePage.selectAllWaves();

  const { waveCount, parcelCount } = await wavePage.getSelectionSummary();
  await logger.info(`printWaveShippingLabels: ${waveCount} wave(s) / ${parcelCount} parcel(s) selected for "${STORE_NAME}" (tab "${TAB_NAME}")`);

  if (waveCount === 0) {
    await logger.info('printWaveShippingLabels: nothing selected, nothing to print');
    return { waveCount, parcelCount, printed: false };
  }

  if (!autoPrint) {
    await logger.info(`printWaveShippingLabels: [DRY RUN] AUTO_PRINT_WAVES is not true — would print ${waveCount} wave(s) / ${parcelCount} parcel(s) now, but did not click "พิมพ์ใบปะหน้าพัสดุ"`);
    return { waveCount, parcelCount, printed: false };
  }

  const { newPage } = await wavePage.printShippingLabels();
  await logger.info(`printWaveShippingLabels: clicked "พิมพ์ใบปะหน้าพัสดุ" for ${waveCount} wave(s) / ${parcelCount} parcel(s)${newPage ? ` — opened new tab: ${newPage.url()}` : ' — no new tab detected within 5s'}`);

  return { waveCount, parcelCount, printed: true };
}
