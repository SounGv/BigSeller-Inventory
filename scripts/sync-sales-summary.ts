import 'dotenv/config';
import { withBigSellerPage } from '../src/utils/browser-runner.js';
import { syncSalesSummary } from '../src/services/sales-summary-service.js';
import { logger } from '../src/utils/logger.js';

async function main() {
  await withBigSellerPage('sync-sales-summary', (page) => syncSalesSummary(page));
  await logger.info('sync:sales-summary complete');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
