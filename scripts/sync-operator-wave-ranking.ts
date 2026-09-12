import 'dotenv/config';
import { withBigSellerPage } from '../src/utils/browser-runner.js';
import { syncOperatorWaveRanking } from '../src/services/operator-wave-ranking-service.js';
import { logger } from '../src/utils/logger.js';

async function main() {
  await withBigSellerPage('sync-operator-wave-ranking', (page) => syncOperatorWaveRanking(page));
  await logger.info('sync:operator-wave-ranking complete');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
