import 'dotenv/config';
import { withBigSellerPage } from '../src/utils/browser-runner.js';
import { syncPurchaseOrderPending } from '../src/services/purchase-order-pending-service.js';
import { SheetsClient } from '../src/sheets/sheets-client.js';
import { logger } from '../src/utils/logger.js';

async function main() {
  const sheetsClient = await SheetsClient.create();
  await withBigSellerPage('sync-purchase-order-pending', (page) => syncPurchaseOrderPending(page, sheetsClient));
  await logger.info('sync:purchase-order-pending complete');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
