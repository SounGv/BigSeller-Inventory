import type { Locator, Page } from '@playwright/test';
import { humanDelay } from '../utils/human-delay.js';

/**
 * BigSeller shows an onboarding tour highlighting the language switcher,
 * rendered as a `<div class="language_switch_guide_mask">` overlay. Confirmed
 * live (2026-08-24) on the location-level page: left in place, it intercepts
 * pointer events for the whole nav, so a sidebar-link click retries for the
 * full 30s timeout without ever reaching the real element. Clicking the mask
 * itself (not anything under it) dismisses the tour with no side effects.
 *
 * Confirmed live again (2026-08-25), the hard way: this is NOT a once-per-
 * session thing — it can reappear multiple times within one sync run (after
 * ensureLocationView, again before selectPositionType), so every page object
 * that might hit it calls this right before the click it could block, not
 * just once up front. A single visibility-checked click per call, same as the
 * original proven version — an earlier attempt at a context-wide
 * MutationObserver that re-clicked on every DOM mutation ended up firing
 * multiple rapid clicks and landed one on the language dropdown underneath
 * once the tour was already gone, switching the account's UI to English by
 * accident. Do not reintroduce that pattern for this particular overlay.
 *
 * Confirmed live a third time (2026-08-25), during a real import:moves batch
 * run: clicking the mask reveals the actual `<ul class="language_switch_guide_menu">`
 * dropdown underneath it (the mask was pointing at it, not just covering the
 * page) — the dismiss click doesn't close it. Left open, that menu itself
 * then blocked an unrelated toolbar button click on a LATER page, which threw
 * out of a per-file import loop and (before that loop had its own try/catch)
 * caused a whole batch retry that resubmitted an already-successful file as a
 * real duplicate transfer document. Pressing Escape after the mask click
 * closes the revealed menu without touching any option inside it.
 */
export async function dismissLanguageSwitchGuideIfPresent(page: Page): Promise<void> {
  const mask = page.locator('.language_switch_guide_mask');
  if (await mask.first().isVisible({ timeout: 1000 }).catch(() => false)) {
    await mask.first().click();
    await humanDelay(200, 500);
  }

  const menu = page.locator('.language_switch_guide_menu');
  if (await menu.first().isVisible({ timeout: 500 }).catch(() => false)) {
    await page.keyboard.press('Escape').catch(() => undefined);
    await humanDelay(200, 500);
  }
}

/**
 * Confirmed live a fourth time (2026-08-25), on the SKU sales report page's
 * nav-menu click: a single dismiss-then-click can still lose the race,
 * because the guide can render a moment AFTER the dismiss check finds
 * nothing but BEFORE the click lands — and on this page it kept doing that
 * across all 3 of `withBigSellerPage`'s attempts (~90s total), never once
 * leaving a long enough gap for a single click to land. Use this instead of
 * a bare `.click()` for any click that could plausibly be on or near the top
 * nav: it re-dismisses before every attempt, so it survives the guide
 * reappearing between attempts rather than only tolerating one race.
 */
export async function clickThroughGuide(page: Page, locator: Locator, opts: { timeout?: number; maxAttempts?: number } = {}): Promise<void> {
  const timeout = opts.timeout ?? 3000;
  const maxAttempts = opts.maxAttempts ?? 8;
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await dismissLanguageSwitchGuideIfPresent(page);
    try {
      await locator.click({ timeout });
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}
