import 'dotenv/config';
import { withBigSellerPage } from '../src/utils/browser-runner.js';
import { syncDecoyReconciliation } from '../src/services/decoy-reconciliation-service.js';
import { logger } from '../src/utils/logger.js';

async function main() {
  await withBigSellerPage('reconcile-decoy-warehouse', (page) => syncDecoyReconciliation(page));
  await logger.info('reconcile:decoy-warehouse complete');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
