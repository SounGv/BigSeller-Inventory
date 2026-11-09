import 'dotenv/config';
import { withBigSellerPage } from '../src/utils/browser-runner.js';
import { syncOtherWarehousesInventory } from '../src/services/other-warehouses-inventory-service.js';
import { SheetsClient } from '../src/sheets/sheets-client.js';
import { logger } from '../src/utils/logger.js';

async function main() {
  const sheetsClient = await SheetsClient.create();
  const reports = await withBigSellerPage('sync-other-warehouses-inventory', (page) => syncOtherWarehousesInventory(page, sheetsClient));
  console.table(reports.map(({ sample: _sample, ...rest }) => rest));
  for (const report of reports) console.log(report.warehouse, 'sample:', JSON.stringify(report.sample));
  await logger.info('sync:other-warehouses-inventory complete');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
