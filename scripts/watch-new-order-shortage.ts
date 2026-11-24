import 'dotenv/config';
import { withBigSellerPage } from '../src/utils/browser-runner.js';
import { SessionExpiredError } from '../src/bigseller/auth.js';
import { NEW_ORDERS_URL } from '../src/bigseller/new-orders-page.js';
import { acquireBigSellerSessionLock } from '../src/utils/bigseller-session-lock.js';
import { isWithinWatchHours, runShortageWatchRound } from '../src/services/shortage-watch-service.js';
import { logger } from '../src/utils/logger.js';

/**
 * 10-minute pre-check: new unconfirmed orders vs. the pick-position stock of
 * STOCK_5, announced to the LINE group for urgent orders (see
 * src/services/shortage-watch-service.ts). Read-only on BigSeller, writes no
 * sheet. Scheduled by scripts/install-new-order-shortage-watch-task.ps1.
 *
 * FORCE_RUN=true skips the Mon–Sat 08:00–17:55 guard, for a manual DryRun at any hour.
 */
async function main() {
  const forced = (process.env.FORCE_RUN ?? 'false').toLowerCase() === 'true';
  if (!forced && !isWithinWatchHours(new Date(), process.env.WATCH_START, process.env.WATCH_END)) {
    await logger.info('shortage-watch: outside watch hours — skipping this round');
    return;
  }

  // waitMs 0: if the full sync (or a previous round) is using the shared BigSeller session, skip this round rather than collide.
  const release = await acquireBigSellerSessionLock('shortage-watch', 0);
  if (!release) return;

  try {
    // The watch only reads the new-orders page, so its session check uses that page too.
    await withBigSellerPage('shortage-watch', (page) => runShortageWatchRound(page), { preflightUrl: NEW_ORDERS_URL });
  } catch (error) {
    if (error instanceof SessionExpiredError) {
      // Logged only: the LINE group gets nothing but the pre-alert template (the older routine's rule).
      await logger.error('shortage-watch: BigSeller session expired — needs "npm run login:bigseller"');
      process.exitCode = 2;
      return;
    }
    throw error;
  } finally {
    release();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
