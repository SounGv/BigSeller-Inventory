import 'dotenv/config';
import { launchBigSellerBrowser } from '../src/utils/browser-runner.js';
import { getStorageStatePath, assertStorageStateExists, checkIsLoggedIn } from '../src/bigseller/auth.js';
import { logger } from '../src/utils/logger.js';

const INTERVAL_MS = Number(process.env.SESSION_KEEPER_INTERVAL_MINUTES ?? 8) * 60 * 1000;
const URL = process.env.BIGSELLER_INVENTORY_URL ?? 'https://www.bigseller.com/web/inventory/warehouseInventory.htm';

/**
 * Long-running daemon (per user request 2026-08-29: "ล็อกอินทีเดียวจำไว้ตลอด
 * จนกว่าจะสั่งให้ออก" — log in once, stay logged in until told to stop) meant
 * to run continuously alongside the LINE command-bot / scheduled sync, not as
 * a one-shot script.
 *
 * The root cause of the recurring ~20-30min session expiry is still not
 * fully confirmed (see HANDOFF-SESSION-BUG.md and project memory), but a
 * live test on 2026-08-27/28 found a strong lead: EVERY other script in this
 * project launches a brand-new Chromium process from the SAME static
 * `playwright/.auth/bigseller.json` snapshot every single time, and never
 * writes back to it — so if BigSeller rotates any session cookie during
 * normal use (confirmed live: `Set-Cookie: JSESSIONID` appears on nearly
 * every authenticated response), that rotation is only ever visible to
 * whichever short-lived browser happened to be open at the time, then
 * thrown away when that process exits. A test that instead kept ONE context
 * alive and re-saved `storageState` after every check survived 5 consecutive
 * 8-minute pings (32+ minutes) past the point earlier tests reliably died —
 * promising, but the test was stopped early for real work before running
 * long enough to fully confirm it holds indefinitely.
 *
 * This script is the permanent version of that test: it keeps ONE headless
 * context open indefinitely, pings a real page every `SESSION_KEEPER_INTERVAL_MINUTES`
 * (default 8 — comfortably under every expiry window observed so far), and
 * re-saves storageState after every ping. Every other script in this project
 * already reads `playwright/.auth/bigseller.json` fresh on each run, so as
 * long as this keeps running, sync/import scripts should always see
 * whatever the live session's latest cookies are — no code change needed
 * anywhere else.
 *
 * Run with `npm run keep-alive`. Stop with Ctrl+C (or close the terminal) —
 * there is no other "log out" command; the session file on disk is left as
 * whatever it last was, exactly like today's `login:bigseller` behavior.
 */
async function main() {
  assertStorageStateExists();
  console.log(`session-keeper: pinging every ${INTERVAL_MS / 60000} min. Press Ctrl+C to stop.`);
  await logger.info(`session-keeper: started, interval=${INTERVAL_MS / 60000}min`);

  const { browser, context } = await launchBigSellerBrowser({ headless: true, storageState: getStorageStatePath() });
  const page = await context.newPage();
  await page.goto(URL, { waitUntil: 'domcontentloaded' });

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    console.log('\nsession-keeper: stopping...');
    await logger.info('session-keeper: stopped by signal');
    await context.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  while (!stopping) {
    await new Promise((resolve) => setTimeout(resolve, INTERVAL_MS));
    if (stopping) break;

    try {
      const valid = await checkIsLoggedIn(page);
      if (!valid) {
        console.log(`[${new Date().toISOString()}] session EXPIRED — a human must run "npm run login:bigseller", then restart this.`);
        await logger.error('session-keeper: session expired — stopping (needs manual re-login)');
        await stop();
        break;
      }
      await context.storageState({ path: getStorageStatePath() });
      console.log(`[${new Date().toISOString()}] ping ok, session valid, storageState refreshed`);
    } catch (error) {
      console.log(`[${new Date().toISOString()}] ping failed (will retry next interval): ${(error as Error).message}`);
      await logger.error(`session-keeper: ping failed: ${(error as Error).message}`);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
