# Handoff: BigSeller automated session gets kicked to login after ~30s

Paste this whole file as your first prompt to Cursor (or any AI coding assistant).
It has everything needed to pick up where I left off — no other context required.

## Project

TypeScript + Playwright automation that scrapes BigSeller (a Thai e-commerce ops
platform, `bigseller.com`) inventory/sales data and syncs it into Google Sheets.
Root: this repo. Key files:

- `src/bigseller/auth.ts` — session validity check, region-popup dismissal, stealth patches
- `src/bigseller/inventory-page.ts` — Page Object for the inventory location-list page
- `src/utils/browser-runner.ts` — launches the Playwright browser/context used by every sync script
- `scripts/login-bigseller.ts` — opens a headed browser for a human to log in manually; saves `playwright/.auth/bigseller.json`
- `scripts/sync-inventory.ts` → `src/services/sync-service.ts` → `syncInventory()` — the actual automated flow that's failing
- `logs/` — has several `sync-inventory-trace-*.zip` Playwright trace files and `inventory-error-*.png` screenshots from failed runs today (2026-08-24)

## The bug

Run:
```bash
npm run login:bigseller   # human logs in manually in the headed browser that opens
npm run sync:inventory    # this is what fails
```

Every single time, the sequence is:

1. `ensureSessionValid()` (in `auth.ts`) navigates to the inventory URL and confirms
   the session is valid (logs `"Session valid at ..."`) — this succeeds instantly,
   every time.
2. Immediately after, `syncInventory()` calls `inventoryPage.ensureLocationView()`,
   which just does `this.positionStockNavLink.click()` — clicking a sidebar link
   with the accessible name "ตำแหน่งสต็อค" (Thai for "stock by location").
3. That click never finds the element. After **exactly ~30 seconds** (the default
   Playwright locator timeout), the browser has navigated away to
   `https://www.bigseller.com/en_US/login.htm?redirect=...` — i.e. we got logged
   out — even though nothing we did should log us out, and step 1 just proved the
   session was fine.
4. This is 100% reproducible. It happened identically across many runs today,
   with headless and headed browsers, with and without various fixes (below).

**Key evidence it's a real server-side session behavior, not a selector bug:**
Playwright's own trace log records an actual browser navigation event to
`login.htm` — this isn't us timing out on a wrong selector while quietly still
being logged in; the browser genuinely navigated to the login page during a
30-second window where our code did nothing but wait for a locator.

## What's already been tried (don't repeat these — they didn't fix it, though some fixed OTHER real bugs along the way)

1. **Removed a double-navigation bug**: `ensureSessionValid` navigates once
   internally; the code used to also call `inventoryPage.goto()` right after,
   navigating to the identical URL again, which sometimes threw
   `net::ERR_ABORTED`. Fixed by adding `ensureLocationView()` (no `page.goto()`)
   as what callers use after `ensureSessionValid`. This was a real fix, keep it.

2. **Found and fixed a real "wrong page" bug**: BigSeller's SPA sometimes restores
   whatever inventory sub-tab (e.g. "รายการสินค้าคงคลัง", a totally different
   SKU-level report) was last active for the account, regardless of the literal
   URL navigated to. Fixed by explicitly clicking the "ตำแหน่งสต็อค" sidebar link
   after every navigation instead of trusting the URL. This was a real fix, keep
   it — but note this is the SAME locator that's now timing out in the bug above,
   so it's possible this fix is incomplete, or the two issues are related.

3. **Found and fixed a real popup-redirect bug**: BigSeller shows a "Warm Tips"
   modal ("if you're in mainland China, visit bigseller.pro") on some page loads.
   Left undismissed, it auto-redirects to a DIFFERENT domain (bigseller.pro),
   whose login page looks identical to bigseller.com's — this was actually
   confirmed happening in several early failed runs (screenshots showed the modal,
   or showed we'd landed on bigseller.pro/login.htm). Fixed with a
   `context.addInitScript()` MutationObserver that clicks "No Prompt" the instant
   the button appears in the DOM (polling for it was too slow — even a human
   watching the screen couldn't click it in time). See
   `installRegionRedirectAutoDismiss()` in `auth.ts`. **This fix is confirmed
   working** — later failure screenshots no longer show the modal — BUT the
   session-kick-to-login bug still happens even with the modal gone. So the modal
   was a real, separate bug, now fixed, but not the (or not the only) root cause.

4. **Tried headless vs headed**: no difference, bug happens both ways. (There's a
   `BIGSELLER_HEADLESS` env var; default is headed/false.)

5. **Tried anti-fingerprinting measures** (`installAutomationStealth()` in
   `auth.ts`): patches `navigator.webdriver`, `navigator.plugins`,
   `navigator.languages`, adds `window.chrome`, launches Chromium with
   `--disable-blink-features=AutomationControlled`, sets a real desktop Chrome
   user-agent string, `locale: 'th-TH'`, `timezoneId: 'Asia/Bangkok'`. No effect on
   the bug.

6. **Tried human-like pacing** (`src/utils/human-delay.ts`): added randomized
   300ms–1.2s delays between every click/navigation in `inventory-page.ts` (not
   instant automation-style clicking). No effect on the bug.

7. **Tried widening the viewport**: went from Playwright's default up to
   1920×1080 in case a narrower viewport was collapsing the sidebar into a
   hamburger menu (a genuine separate concern) — didn't fix this bug either,
   though it's still a reasonable thing to keep.

8. **Confirmed via manual cookie inspection** that the saved
   `playwright/.auth/bigseller.json` session's cookies (including the
   Spring-Boot-style `JSESSIONID`, which is a session-only cookie with no client-
   side expiry) were NOT expired by their stated `expires` timestamps at the time
   of failure. This is a Java/Spring Boot backend
   (`org.springframework.web.servlet.i18n.CookieLocaleResolver` cookie present).
   So the invalidation is happening server-side, not because a cookie's client-side
   expiry passed.

## What to investigate next (fresh ideas, not yet tried)

- **Open one of the `logs/sync-inventory-trace-*.zip` files in Playwright's trace
  viewer** (`npx playwright show-trace logs/sync-inventory-trace-<timestamp>.zip`)
  and look at the **Network tab** for the 30-second window between "session
  valid" and the navigation to login.htm. Specifically look for:
  - Any XHR/fetch call that returns `401`/`403`/`302` right before the
    navigation — this would tell us exactly which API call triggers the kick,
    which is the single most useful piece of missing information right now.
  - Whether `Set-Cookie` headers show the session cookie being rotated/cleared.
  - Whether there's a periodic "heartbeat"/keepalive call the real interactive
    site makes that our automated session never triggers (e.g. some SPAs ping a
    `/keepalive` or `/whoami` endpoint on an interval, and failing to do so within
    N seconds of page load causes a server-side session drop).
- **Compare against the working manual/interactive case**: earlier in this
  project, data WAS successfully pulled live via a human-in-the-loop browser
  session (Claude in Chrome) with no session-kick issue at all — same account,
  same site. Diffing what that session's network requests looked like vs. the
  automated Playwright session's requests (e.g. via the trace's Network tab, or
  by using `page.on('request')` / `page.on('response')` logging added to
  `browser-runner.ts` for one debug run) could reveal a missing header, cookie, or
  call.
- **Try `page.waitForTimeout` reduced test**: temporarily change
  `positionStockNavLink`'s click to have a very short timeout (e.g. 3s) and add
  `page.on('response', r => console.log(r.status(), r.url()))` right after
  `ensureSessionValid` succeeds, then let it run and capture full response logs for
  the ~30s window — cheaper than parsing a full trace file.
- **Check if BigSeller has a documented API / "open platform" / developer token**
  for this exact use case (inventory export). Many platforms like this offer a
  proper API specifically so customers don't need browser automation — worth
  asking their support team directly. This would sidestep the whole problem.
- **Consider whether this is a single-active-session policy**: test logging in via
  `npm run login:bigseller`, then WITHOUT running any sync script, open the
  BigSeller inventory page in a totally separate normal browser (not Playwright,
  not the login script's browser) and watch whether the Playwright-saved session
  gets invalidated by that separate interactive login. This was partially tested
  today (closing an unrelated browser tab on the same account did NOT fix it) but
  not exhaustively ruled out.

## How to test

```bash
npm install
npx playwright install chromium
cp .env.example .env   # fill in GOOGLE_SHEETS_SPREADSHEET_ID, GOOGLE_APPLICATION_CREDENTIALS,
                        # INVENTORY_WAREHOUSE_NAME (already has real values from today's session
                        # in the actual .env if it still exists — check before overwriting)
npm run login:bigseller   # human must complete this manually — do NOT try to script credentials in
npm run validate           # should print "[OK] BigSeller session ใช้งานได้" if session is fine
npm run sync:inventory     # reproduces the bug — watch the headed browser window live
```

`logs/scheduled-sync.log` also has historical output if you want more failure
samples without waiting for the retry loop.

## Non-negotiable constraint

Per this project's explicit design (see `README.md` and `.env.example`
comments): **no code may ever attempt to enter a username, password, OTP, or
CAPTCHA on BigSeller's behalf.** `npm run login:bigseller` opens a headed browser
specifically so a human completes that step. Do not try to "fix" the session bug
by scripting credential entry or automating 2FA/CAPTCHA — that would violate the
project's security policy regardless of whether it "worked" technically.
