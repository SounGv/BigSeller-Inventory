import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test';
import {
  assertStorageStateExists,
  getStorageStatePath,
  installRegionRedirectAutoDismiss,
  installAutomationStealth,
  ensureSessionValid,
  SessionExpiredError,
} from '../bigseller/auth.js';
import { logger } from './logger.js';

const LOG_DIR = process.env.LOG_DIR ?? './logs';
const MAX_RETRIES = Number(process.env.MAX_RETRIES ?? 2);

// --start-maximized paired with viewport: null below (Playwright's documented
// pattern for this) makes the window actually fill the real screen instead of
// opening at a fixed content size that can be larger than the screen and get
// cut off — reported live (2026-08-25): on login and other headed runs, the
// window opened small/off-screen and parts of the page (e.g. an onboarding
// overlay near the top) were not visible at all.
const LAUNCH_ARGS = ['--disable-blink-features=AutomationControlled', '--start-maximized'];

/**
 * Deliberately does NOT set a custom `userAgent`. Confirmed live (2026-08-24) via
 * trace network headers: Playwright's `userAgent` context option only overwrites
 * the `User-Agent` string — it does not touch the Client Hints headers
 * (`sec-ch-ua` etc), which keep reporting the real bundled Chromium version. That
 * produced a self-contradictory browser on every single request (User-Agent said
 * "Chrome/128.0.0.0", sec-ch-ua said "Chromium";v="151") — sessions were getting
 * silently rejected (server minting a fresh anonymous JSESSIONID) even seconds
 * after a verified-fresh manual login, which a spoofed-but-inconsistent UA
 * explains far better than any timing race. Left unset, Playwright's real UA and
 * its Client Hints agree with each other, which is what a genuine browser sends.
 */
const CONTEXT_OPTIONS = {
  // null viewport (rather than a fixed size) is required for --start-maximized
  // above to actually take effect — Playwright otherwise resizes the page's
  // content area back down to a fixed size inside the maximized window.
  viewport: null,
  locale: 'th-TH',
  timezoneId: 'Asia/Bangkok',
} as const;

/**
 * Launches Chromium with the ONE browser fingerprint (launch args, viewport, UA,
 * locale, timezone, stealth patches) used everywhere this project talks to
 * BigSeller — the manual login script included.
 *
 * Root cause confirmed live (2026-08-24) via a Playwright trace's network tab: on
 * every automated run, BigSeller's server minted a brand-new anonymous JSESSIONID
 * on the very first API call (a fresh Set-Cookie on both getLang.json and
 * isLogin.json), then the page's own client-side JS redirected to login.htm well
 * under a second later — not the ~30s the click timeout made it look like. That
 * only happens when the server doesn't recognize the incoming JSESSIONID as a
 * live session at all. The saved cookies were previously replayed under a
 * completely different fingerprint than the one present when the human logged in
 * (login used Playwright's bare defaults; sync overrode UA/viewport/locale/
 * timezone and added navigator.webdriver spoofing on top) — consistent with
 * BigSeller binding the session to the login fingerprint (it does set a cookie
 * literally named `fingerPrint`) and rejecting replay under a different one.
 * Routing both the login script and the sync runner through this same function
 * closes that gap.
 */
export async function launchBigSellerBrowser(
  options: { headless: boolean; storageState?: string },
): Promise<{ browser: Browser; context: BrowserContext }> {
  const browser = await chromium.launch({ headless: options.headless, args: LAUNCH_ARGS });
  const context = await browser.newContext({
    ...CONTEXT_OPTIONS,
    ...(options.storageState ? { storageState: options.storageState } : {}),
  });
  await installRegionRedirectAutoDismiss(context);
  await installAutomationStealth(context);
  return { browser, context };
}

/**
 * Launches a Chromium browser using the saved BigSeller session, runs `fn(page)`,
 * and retries on failure (per project policy: retries are for transient page issues,
 * NOT for re-attempting login — SessionExpiredError from auth.ts is not swallowed
 * here, it always propagates immediately with no retry).
 *
 * Defaults to a HEADED browser, since this project runs on a staff member's own
 * desktop (see README) rather than a headless server — a visible browser window
 * during sync is an acceptable trade-off. Override with BIGSELLER_HEADLESS=true
 * only if you have separately verified your setup stays logged in that way.
 *
 * A trace is captured starting on the first retry, matching this project's
 * trace: 'on-first-retry' convention for the Playwright test runner.
 */
/**
 * Quick, invisible (always headless, regardless of BIGSELLER_HEADLESS) check for
 * whether the saved session is still good — used to decide whether it's worth
 * opening the real, visible browser at all.
 *
 * Added because the hourly scheduled sync opening a HEADED browser just to
 * immediately discover the session is dead (and close itself a couple of seconds
 * later) looked, to a person nearby, exactly like a login page flashing open and
 * disappearing too fast to type into — they'd try to race it and lose every time.
 * That flashing window was never meant to be logged into; `npm run login:bigseller`
 * is the dedicated flow for that, and stays open for up to 5 minutes. Failing this
 * pre-check silently (no visible window at all) removes the confusing prompt
 * entirely instead of just explaining it away.
 */
async function hasValidSession(url: string): Promise<boolean> {
  const { browser, context } = await launchBigSellerBrowser({
    headless: true,
    storageState: getStorageStatePath(),
  });
  try {
    const page = await context.newPage();
    return await ensureSessionValid(page, url)
      .then(() => true)
      .catch(() => false);
  } finally {
    await context.close();
    await browser.close();
  }
}

export async function withBigSellerPage<T>(jobName: string, fn: (page: Page) => Promise<T>): Promise<T> {
  assertStorageStateExists();

  const preflightUrl =
    process.env.BIGSELLER_INVENTORY_URL ?? 'https://www.bigseller.com/web/inventory/warehouseInventory.htm';
  if (!(await hasValidSession(preflightUrl))) {
    throw new SessionExpiredError(preflightUrl);
  }

  const headless = (process.env.BIGSELLER_HEADLESS ?? 'false').toLowerCase() === 'true';
  const { browser, context } = await launchBigSellerBrowser({
    headless,
    storageState: getStorageStatePath(),
  });
  const page = await context.newPage();

  let lastError: unknown;
  try {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const isRetry = attempt > 0;
      if (isRetry) {
        // A human would pause and look around before trying again, not
        // immediately repeat the exact same clicks — and hammering BigSeller
        // with back-to-back automated attempts risks tripping its own bot
        // detection independent of whatever caused the first failure.
        await new Promise((resolve) => setTimeout(resolve, 5000 * attempt));
        await context.tracing.start({ screenshots: true, snapshots: true });
        await logger.warn(`${jobName}: retry attempt ${attempt}/${MAX_RETRIES}`);
      }

      try {
        return await fn(page);
      } catch (error) {
        lastError = error;
        if (error instanceof Error && error.name === 'SessionExpiredError') {
          throw error; // never retried
        }
        // A TypeError/ReferenceError/etc. is a code bug (bad data shape, wrong
        // property access) that will fail identically on every attempt —
        // retrying it just repeats the same real clicks against BigSeller for
        // no benefit and adds exactly the kind of unnecessary automated load
        // that risks tripping bot detection. Confirmed live (2026-08-25): a
        // "(value ?? "").replace is not a function" bug retried 3 times in a
        // row right before the session got invalidated.
        if (isJavaScriptRuntimeError(error)) {
          throw error;
        }
        if (isRetry) {
          const tracePath = path.join(LOG_DIR, `${jobName}-trace-${Date.now()}.zip`);
          await context.tracing.stop({ path: tracePath }).catch(() => undefined);
          await logger.error(`${jobName}: saved trace to ${tracePath}`);
        }
      }
    }
    throw lastError;
  } finally {
    await context.close();
    await browser.close();
  }
}

/** True for JS built-in error types (TypeError, ReferenceError, RangeError, SyntaxError) that indicate a code bug rather than a flaky page interaction — these fail identically on every attempt, so retrying them is pure waste. */
function isJavaScriptRuntimeError(error: unknown): boolean {
  return (
    error instanceof TypeError ||
    error instanceof ReferenceError ||
    error instanceof RangeError ||
    error instanceof SyntaxError
  );
}
