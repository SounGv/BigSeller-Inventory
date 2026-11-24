import 'dotenv/config';
import { withBigSellerPage } from '../src/utils/browser-runner.js';
import { SessionExpiredError } from '../src/bigseller/auth.js';
import { SheetsClient } from '../src/sheets/sheets-client.js';
import { acquireBigSellerSessionLock } from '../src/utils/bigseller-session-lock.js';
import {
  announceSessionExpiredOncePerDay,
  isWithinWatchHours,
  runShortageWatchRound,
} from '../src/services/shortage-watch-service.js';
import { logger } from '../src/utils/logger.js';

/**
 * 10-minute watch: new unconfirmed orders vs. what sits at the pick position,
 * announced to the LINE group when a SKU newly becomes short (see
 * src/services/shortage-watch-service.ts). Scheduled by
 * scripts/install-new-order-shortage-watch-task.ps1.
 *
 * FORCE_RUN=true skips the Mon–Sat 08:30–18:30 guard, for a manual DryRun at any hour.
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
    const sheetsClient = await SheetsClient.create();
    await withBigSellerPage('shortage-watch', (page) => runShortageWatchRound(page, sheetsClient));
  } catch (error) {
    if (error instanceof SessionExpiredError) {
      await logger.error('shortage-watch: BigSeller session expired — needs "npm run login:bigseller"');
      await announceSessionExpiredOncePerDay();
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
