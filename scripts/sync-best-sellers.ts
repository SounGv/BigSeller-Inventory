import 'dotenv/config';
import { withBigSellerPage } from '../src/utils/browser-runner.js';
import { syncBestSellers } from '../src/services/best-sellers-service.js';
import { logger } from '../src/utils/logger.js';

async function main() {
  await withBigSellerPage('sync-best-sellers', (page) => syncBestSellers(page));
  await logger.info('sync:best-sellers complete');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
