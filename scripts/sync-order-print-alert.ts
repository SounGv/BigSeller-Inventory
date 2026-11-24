import 'dotenv/config';
import { withBigSellerPage } from '../src/utils/browser-runner.js';
import { syncOrderPrintAlert } from '../src/services/order-print-alert-service.js';
import { SheetsClient } from '../src/sheets/sheets-client.js';
import { logger } from '../src/utils/logger.js';

async function main() {
  const sheetsClient = await SheetsClient.create();
  await withBigSellerPage('sync-order-print-alert', (page) => syncOrderPrintAlert(page, sheetsClient));
  await logger.info('sync:order-print-alert complete');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
