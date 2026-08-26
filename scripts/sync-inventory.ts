import 'dotenv/config';
import { withBigSellerPage } from '../src/utils/browser-runner.js';
import { syncInventory } from '../src/services/sync-service.js';
import { SheetsClient } from '../src/sheets/sheets-client.js';
import { logger } from '../src/utils/logger.js';

async function main() {
  const sheetsClient = await SheetsClient.create();
  const rows = await withBigSellerPage('sync-inventory', (page) => syncInventory(page, sheetsClient));
  await logger.info(`sync:inventory complete — ${rows.length} rows`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
