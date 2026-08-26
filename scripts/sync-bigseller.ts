import 'dotenv/config';
import { withBigSellerPage } from '../src/utils/browser-runner.js';
import { syncBigSeller } from '../src/services/sync-service.js';
import { SheetsClient } from '../src/sheets/sheets-client.js';
import { logger } from '../src/utils/logger.js';

async function main() {
  const sheetsClient = await SheetsClient.create();
  const result = await withBigSellerPage('sync-bigseller', (page) => syncBigSeller(page, sheetsClient));
  await logger.info(
    `sync:bigseller complete — runId=${result.runId}, ${result.locationRows.length} location rows, ${result.skuRows.length} SKU rows`,
  );
  console.log(`runId: ${result.runId}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
