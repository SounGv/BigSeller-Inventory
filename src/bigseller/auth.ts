import { existsSync } from 'node:fs';
import type { BrowserContext, Page } from '@playwright/test';
import { logger } from '../utils/logger.js';

export class SessionExpiredError extends Error {
  constructor(url: string) {
    super(
      `BigSeller session is expired or invalid at ${url}. ` +
        'Automated re-login is disabled by policy. ' +
        'Please ask an authorized staff member to run "npm run login:bigseller" to sign in manually.',
    );
    this.name = 'SessionExpiredError';
  }
}

export function getStorageStatePath(): string {
  return process.env.BIGSELLER_AUTH_STATE_PATH ?? 'playwright/.auth/bigseller.json';
}

/** Must be called before any scraping run. Throws SessionExpiredError instead of retrying credentials. */
export function assertStorageStateExists(): void {
  const storagePath = getStorageStatePath();
  if (!existsSync(storagePath)) {
    throw new SessionExpiredError(storagePath);
  }
}

/**
 * BigSeller shows a "Warm Tips" modal on some page loads suggesting mainland-China
 * users jump to the bigseller.pro mirror. Confirmed live (2026-08-24): if left
 * undismissed, this auto-redirects the page to bigseller.pro's login screen — a
 * DIFFERENT domain than bigseller.com, so none of our saved cookies apply there,
 * which looks exactly like an expired session even though the real .com session
 * was still fine. Dismissing it with "No Prompt" keeps us on .com.
 *
 * The button's label follows the browser's `locale` context option, not a fixed
 * language: with `locale: 'th-TH'` (set in browser-runner.ts to fix a separate
 * fingerprint-mismatch bug) BigSeller renders this button as "ไม่เตือน" instead of
 * "No Prompt". Match both so this doesn't silently break again if the locale or
 * BigSeller's i18n strings change.
 */
export async function dismissRegionRedirectPrompt(page: Page): Promise<void> {
  const noPromptButton = page.getByRole('button', { name: /^(No Prompt|ไม่เตือน)$/ });
  if (await noPromptButton.isVisible({ timeout: 3000 }).catch(() => false)) {
    await noPromptButton.click();
    await logger.info('Dismissed the bigseller.pro region-redirect prompt');
  }
}

/**
 * Installs a context-wide init script (runs before any page JS, on every
 * navigation) that clicks "No Prompt" the instant it appears in the DOM.
 *
 * Confirmed live (2026-08-24): the region-redirect prompt's auto-redirect timer is
 * fast enough that polling for it — even from our own Playwright code every few
 * seconds, and even a human manually watching the screen — consistently lost the
 * race and got bounced to bigseller.pro's login page. A MutationObserver installed
 * before the page's own scripts run is the only approach that reacted in time.
 * Call this once per BrowserContext (covers every page/navigation in it), before
 * any navigation happens — including the one in login-bigseller.ts, since the
 * prompt can interfere with a human's manual login too.
 *
 * Same locale caveat as {@link dismissRegionRedirectPrompt}: with `locale: 'th-TH'`
 * the button text is "ไม่เตือน", not "No Prompt" — match both labels here too.
 */
export async function installRegionRedirectAutoDismiss(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const DISMISS_LABELS = ['No Prompt', 'ไม่เตือน']; // English + Thai (locale: th-TH)
    const clickNoPromptIfPresent = (): boolean => {
      const button = Array.from(document.querySelectorAll('button')).find((el) =>
        DISMISS_LABELS.includes(el.textContent?.trim() ?? ''),
      );
      if (button) {
        (button as HTMLButtonElement).click();
        return true;
      }
      return false;
    };
    if (clickNoPromptIfPresent()) return;
    const observer = new MutationObserver(() => {
      if (clickNoPromptIfPresent()) observer.disconnect();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  });
}

/**
 * Hides BigSeller's language-switcher onboarding tour outright, instead of
 * dismissing it by clicking.
 *
 * The account is already set to Thai, so this tour has nothing to offer and
 * reappears on run after run (reported 2026-09-11 with a screenshot showing it
 * open yet again, language submenu and all). Clicking it was never free: the
 * mask sits ON TOP of the real language dropdown, so the dismiss click reveals
 * that menu, and dismiss-language-guide.ts records a previous version of this
 * code landing a stray click inside it and switching the whole account's UI to
 * English — which would silently break every Thai selector in this repo.
 *
 * `display: none` also removes the mask's pointer interception, which is the
 * only reason the click-to-dismiss existed. Matched on a class PREFIX so a
 * renamed variant (`..._tip`, `..._menu`) is covered too.
 *
 * dismissLanguageSwitchGuideIfPresent stays in place as a fallback and simply
 * finds nothing to do: a display:none element is never `isVisible()`.
 */
export async function installLanguageGuideSuppressor(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const style = document.createElement('style');
    style.textContent = '[class*="language_switch_guide"]{display:none !important;}';
    document.documentElement.appendChild(style);
  });
}

/**
 * Patches over the most common automated-browser fingerprints (navigator.webdriver,
 * empty plugins/languages, missing window.chrome) that anti-bot/WAF layers commonly
 * check. Investigating a real issue (2026-08-24): the saved session passed an
 * initial page load but got silently redirected to the login screen within ~30s of
 * any further interaction, which is the classic signature of a WAF allowing a first
 * page load through and then challenging subsequent requests once it fingerprints
 * the browser as automated. This is a mitigation to try, not a confirmed fix.
 */
export async function installAutomationStealth(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'languages', { get: () => ['th-TH', 'th', 'en-US', 'en'] });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    // @ts-expect-error -- window.chrome is a non-standard Chrome-only global, intentionally untyped here.
    if (!window.chrome) window.chrome = { runtime: {} };
  });
}

/**
 * Asks BigSeller's own `/api/v1/isLogin.json` endpoint whether the CURRENT page's
 * session is authenticated — this is the same call BigSeller's own SPA makes on
 * every page load to decide whether to redirect to the login page. Does not
 * navigate; the page must already be on a bigseller.com origin.
 *
 * Confirmed live (2026-08-24) via Playwright trace network capture: an earlier
 * DOM-heuristic version of this check (looking for a login button/password field,
 * or a "/login" URL) ran immediately after `domcontentloaded` — before the SPA's
 * own async call to this exact endpoint had resolved and (if unauthenticated)
 * triggered its client-side redirect to login.htm, which trace evidence showed
 * happening ~300-500ms later. That race meant the check could report "valid" on
 * a session `isLogin.json` itself was about to report `data: false` for.
 *
 * Calls the endpoint via `page.evaluate` + `fetch` (not Playwright's separate
 * `page.request` API context) so the call goes out with the exact same Referer,
 * sec-fetch, and cookie handling a real in-page XHR gets — `page.request` is a
 * side-channel HTTP client that does not replicate that automatically, and a
 * fully manual, human-completed login still measured `data: false` through it.
 */
export async function checkIsLoggedIn(page: Page): Promise<boolean> {
  const data = await page.evaluate(async () => {
    const res = await fetch('/api/v1/isLogin.json', {
      headers: { clienttype: '1' },
      credentials: 'include',
    });
    if (!res.ok) return null;
    const body = await res.json().catch(() => null);
    return body?.data ?? null;
  });

  return data === true;
}

/**
 * Navigates to `url`, then checks {@link checkIsLoggedIn}. Only for callers that
 * genuinely need a fresh navigation first (e.g. verifying a saved session from a
 * cold start) — NOT for polling while a human is mid-login: confirmed live
 * (2026-08-24) that re-navigating on every poll tick reloads the page out from
 * under the human, wiping in-progress form input/OTP/CAPTCHA before they can
 * finish. Polling loops should call {@link checkIsLoggedIn} directly instead.
 */
export async function isSessionValid(page: Page, url: string): Promise<boolean> {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  return checkIsLoggedIn(page);
}

export async function ensureSessionValid(page: Page, url: string): Promise<void> {
  assertStorageStateExists();
  const valid = await isSessionValid(page, url);
  if (!valid) {
    await logger.error(`Session check failed at ${url}`);
    throw new SessionExpiredError(url);
  }
  await logger.info(`Session valid at ${url}`);
}
