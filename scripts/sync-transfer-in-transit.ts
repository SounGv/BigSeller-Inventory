import 'dotenv/config';
import { withBigSellerPage } from '../src/utils/browser-runner.js';
import { syncTransferInTransit } from '../src/services/transfer-in-transit-service.js';
import { SheetsClient } from '../src/sheets/sheets-client.js';
import { logger } from '../src/utils/logger.js';

async function main() {
  const sheetsClient = await SheetsClient.create();
  await withBigSellerPage('sync-transfer-in-transit', (page) => syncTransferInTransit(page, sheetsClient));
  await logger.info('sync:transfer-in-transit complete');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
