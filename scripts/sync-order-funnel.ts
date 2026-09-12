import 'dotenv/config';
import { withBigSellerPage } from '../src/utils/browser-runner.js';
import { syncOrderFunnel } from '../src/services/order-funnel-service.js';
import { logger } from '../src/utils/logger.js';

async function main() {
  await withBigSellerPage('sync-order-funnel', (page) => syncOrderFunnel(page));
  await logger.info('sync:order-funnel complete');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
