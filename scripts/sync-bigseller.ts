import 'dotenv/config';
import { withBigSellerPage } from '../src/utils/browser-runner.js';
import { syncBigSeller } from '../src/services/sync-service.js';
import { SheetsClient } from '../src/sheets/sheets-client.js';
import { logger } from '../src/utils/logger.js';
import { acquireBigSellerSessionLock } from '../src/utils/bigseller-session-lock.js';

async function main() {
  // The 10-minute shortage watch drives the same saved BigSeller session; wait for a round in progress instead of colliding with it.
  const release = await acquireBigSellerSessionLock('sync-bigseller', 6 * 60 * 1000);
  if (!release) {
    throw new Error('Another BigSeller job still holds the shared session after 6 minutes — not starting sync:bigseller');
  }
  try {
    const sheetsClient = await SheetsClient.create();
    const result = await withBigSellerPage('sync-bigseller', (page) => syncBigSeller(page, sheetsClient));
    await logger.info(
      `sync:bigseller complete — runId=${result.runId}, ${result.locationRows.length} location rows, ${result.skuRows.length} SKU rows`,
    );
    console.log(`runId: ${result.runId}`);
  } finally {
    release();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
