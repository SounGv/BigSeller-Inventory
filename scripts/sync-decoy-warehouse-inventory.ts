import 'dotenv/config';
import { withBigSellerPage } from '../src/utils/browser-runner.js';
import { syncDecoyWarehouseInventory } from '../src/services/decoy-warehouse-inventory-service.js';
import { SheetsClient } from '../src/sheets/sheets-client.js';
import { logger } from '../src/utils/logger.js';

async function main() {
  const sheetsClient = await SheetsClient.create();
  await withBigSellerPage('sync-decoy-warehouse-inventory', (page) => syncDecoyWarehouseInventory(page, sheetsClient));
  await logger.info('sync:decoy-warehouse-inventory complete');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
