import 'dotenv/config';
import { launchBigSellerBrowser } from '../src/utils/browser-runner.js';
import { getStorageStatePath, assertStorageStateExists, checkIsLoggedIn } from '../src/bigseller/auth.js';
import { logger } from '../src/utils/logger.js';

const INTERVAL_MS = Number(process.env.SESSION_KEEPER_INTERVAL_MINUTES ?? 8) * 60 * 1000;
const URL = process.env.BIGSELLER_INVENTORY_URL ?? 'https://www.bigseller.com/web/inventory/warehouseInventory.htm';

/**
 * Long-running daemon, ported from the sibling BigSeller-Inventory project
 * (`scripts/session-keeper.ts` there) where this exact approach was confirmed
 * live (2026-08-29) to survive 64+ minutes with zero expiries, after repeated
 * short-lived-browser checks kept failing unpredictably within ~20-90 minutes.
 *
 * Root cause lead (see HANDOFF-SESSION-BUG.md): every script here launches a
 * brand-new Chromium process from the SAME static `playwright/.auth/bigseller.json`
 * snapshot and never writes back to it — so if BigSeller rotates the session
 * cookie during normal use (it does: `Set-Cookie: JSESSIONID` on most
 * authenticated responses), that rotation is only ever visible to whichever
 * short-lived browser happened to be open, then discarded when that process
 * exits. The next script then replays a now-stale cookie. Keeping ONE context
 * alive and re-saving `storageState` after every ping means every other
 * script in this project (they all read the file fresh on each run) sees
 * the latest rotated cookie instead of a stale snapshot.
 *
 * Run with `npm run keep-alive` during any extended BigSeller work session —
 * including while watching for the next occurrence of the session-kick bug,
 * since `ensureSessionValid` now logs network/cookie evidence on failure (see
 * auth.ts) that will finally say whether this alone fixes it. Stop with
 * Ctrl+C — there is no other "log out" command.
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
