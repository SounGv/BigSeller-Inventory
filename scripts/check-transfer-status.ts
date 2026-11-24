import 'dotenv/config';
import { withBigSellerPage } from '../src/utils/browser-runner.js';
import { checkTrackedDocuments } from '../src/services/transfer-status-check-service.js';
import { SheetsClient } from '../src/sheets/sheets-client.js';
import { logger } from '../src/utils/logger.js';

async function main() {
  const sheetsClient = await SheetsClient.create();
  const outcome = await withBigSellerPage('check-transfer-status', (page) => checkTrackedDocuments(page, sheetsClient));
  console.log(
    `checked ${outcome.checkedCount}, completed=${outcome.newlyCompleted.length}, cancelled=${outcome.newlyCancelled.length}, stuck=${outcome.stillStuck.length}, reported=${outcome.reported}`,
  );
  await logger.info('check:transfer-status complete');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
