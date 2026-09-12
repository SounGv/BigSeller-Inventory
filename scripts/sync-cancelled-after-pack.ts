import 'dotenv/config';
import { withBigSellerPage } from '../src/utils/browser-runner.js';
import { syncCancelledAfterPack } from '../src/services/cancelled-after-pack-service.js';
import { logger } from '../src/utils/logger.js';

async function main() {
  await withBigSellerPage('sync-cancelled-after-pack', (page) => syncCancelledAfterPack(page));
  await logger.info('sync:cancelled-after-pack complete');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
