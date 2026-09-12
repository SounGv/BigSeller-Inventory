import type { Page } from '@playwright/test';

/**
 * Two popups confirmed live (2026-08-31) on `order/index.htm?status=new`,
 * neither documented before this feature — both block clicks underneath them:
 *
 * 1. A ROTATING marketing/notice modal (`.ant-modal-wrap.notice_dashboard`)
 *    whose content lives inside an `<iframe id="noticeContent">` and changes
 *    between visits — different promos seen the same session had different
 *    dismiss-button labels ("ต่อไป" for a multi-step promo, "ปิด" for a
 *    single announcement). A locator scoped to the wrapper div does NOT reach
 *    inside the iframe; the bare page-level `getByRole` does (Playwright
 *    pierces same-origin iframes for these page-level locators).
 * 2. A separate onboarding-tour card ("ยินดีต้อนรับเข้าสู่คู่มือปฏิบัติการ...")
 *    with "ข้าม" (skip) / "เริ่ม" (start) buttons — a different modal system
 *    than notice_dashboard (no iframe, plain rounded card).
 *
 * Both can appear on a fresh page load and/or reappear after a filter click
 * navigates the SPA. Call this before every click that could plausibly land
 * near the top of this page, same convention as clickThroughGuide() for the
 * language-switch guide on the inventory page.
 */
export async function dismissOrderPageOverlays(page: Page): Promise<void> {
  // Stop ant tooltips from eating clicks meant for the filter pills.
  //
  // Done in the LIVE page rather than through an init script: this SPA swaps
  // its document around, and a style installed at context creation was still
  // not in effect when it mattered. Confirmed live 2026-09-12 — the
  // "ตั้งค่าการคัดกรอง" bubble sat over the platform row and beat all five
  // retries of a reset to ทั้งหมด ("ant-tooltip-inner ... intercepts pointer
  // events"), which left the page filtered to one platform and made the
  // morning read as empty. The bubbles stay visible; they just stop
  // intercepting.
  await page
    .evaluate(() => {
      const id = 'wave-engine-tooltip-passthrough';
      if (document.getElementById(id)) return;
      const style = document.createElement('style');
      style.id = id;
      style.textContent = '.ant-tooltip,.ant-tooltip-inner,.ant-tooltip-arrow{pointer-events:none !important;}';
      (document.head ?? document.documentElement).appendChild(style);
    })
    .catch(() => undefined);

  for (let attempt = 0; attempt < 5; attempt++) {
    const noticeVisible = await page
      .locator('.ant-modal-wrap.notice_dashboard')
      .isVisible({ timeout: 1000 })
      .catch(() => false);
    if (noticeVisible) {
      const clicked = await page
        .getByRole('button', { name: /^(ปิด|ต่อไป|ตกลง|Close)$/ })
        .first()
        .click({ timeout: 2000 })
        .then(() => true)
        .catch(() => false);
      if (!clicked) {
        await page.keyboard.press('Escape').catch(() => undefined);
      }
      await page.waitForTimeout(600);
    }

    const skipBtn = page.getByRole('button', { name: 'ข้าม' });
    const skipVisible = await skipBtn.isVisible({ timeout: 1000 }).catch(() => false);
    if (skipVisible) {
      await skipBtn.click({ timeout: 2000 }).catch(() => undefined);
      await page.waitForTimeout(600);
    }

    if (!noticeVisible && !skipVisible) return;
  }
}
