import 'dotenv/config';
import { withBigSellerPage } from '../src/utils/browser-runner.js';
import { syncOrderDemand } from '../src/services/order-demand-service.js';
import { SheetsClient } from '../src/sheets/sheets-client.js';
import { generateRunId } from '../src/types.js';
import { logger } from '../src/utils/logger.js';

async function main() {
  const sheetsClient = await SheetsClient.create();
  const runId = generateRunId();
  await withBigSellerPage('sync-order-demand', (page) => syncOrderDemand(page, sheetsClient, runId));
  await logger.info('sync:order-demand complete');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
