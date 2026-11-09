import 'dotenv/config';
import { withBigSellerPage } from '../src/utils/browser-runner.js';
import { syncStockValueReference } from '../src/services/stock-value-reference-service.js';
import { SheetsClient } from '../src/sheets/sheets-client.js';
import { logger } from '../src/utils/logger.js';

async function main() {
  const sheetsClient = await SheetsClient.create();
  const results = await withBigSellerPage('sync-stock-value-reference', (page) => syncStockValueReference(page, sheetsClient));
  console.table(results.map(({ sourceUpdatedAt: _at, ...rest }) => rest));
  await logger.info('sync:stock-value-reference complete');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
