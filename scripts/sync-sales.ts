import 'dotenv/config';
import { withBigSellerPage } from '../src/utils/browser-runner.js';
import { syncSales } from '../src/services/sync-service.js';
import { SheetsClient } from '../src/sheets/sheets-client.js';
import { logger } from '../src/utils/logger.js';

async function main() {
  const sheetsClient = await SheetsClient.create();
  await withBigSellerPage('sync-sales', (page) => syncSales(page, sheetsClient));
  await logger.info('sync:sales complete');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
