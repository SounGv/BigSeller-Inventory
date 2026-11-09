import 'dotenv/config';
import { withBigSellerPage } from '../src/utils/browser-runner.js';
import { syncSkuInventory } from '../src/services/sync-service.js';
import { SheetsClient } from '../src/sheets/sheets-client.js';
import { logger } from '../src/utils/logger.js';

/**
 * Refreshes DB_SKU_INVENTORY (the INVENTORY_WAREHOUSE_NAME warehouse, STOCK_5) on its own. The same function is part of
 * `sync:bigseller`, which also exports locations for the transfer-plan workflow; the stock-value page only needs this
 * half, so the scheduled stock-value sync calls it directly.
 */
async function main() {
  const sheetsClient = await SheetsClient.create();
  const rows = await withBigSellerPage('sync-sku-inventory', (page) => syncSkuInventory(page, sheetsClient));
  await logger.info(`sync:sku-inventory complete — ${rows.length} rows`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
