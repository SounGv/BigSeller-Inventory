import 'dotenv/config';
import { withBigSellerPage } from '../src/utils/browser-runner.js';
import { syncWarehouseBacklog } from '../src/services/warehouse-backlog-service.js';
import { logger } from '../src/utils/logger.js';

async function requireEnv(name: string): Promise<string> {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

async function main() {
  const warehouseName = await requireEnv('INVENTORY_WAREHOUSE_NAME');
  await withBigSellerPage('sync-warehouse-backlog', (page) => syncWarehouseBacklog(page, warehouseName));
  await logger.info('sync:warehouse-backlog complete');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
