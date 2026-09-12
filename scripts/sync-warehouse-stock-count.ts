import 'dotenv/config';
import { syncWarehouseStockCount } from '../src/services/warehouse-stock-count-service.js';
import { logger } from '../src/utils/logger.js';

async function main() {
  await syncWarehouseStockCount();
  await logger.info('sync:warehouse-stock-count complete');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
