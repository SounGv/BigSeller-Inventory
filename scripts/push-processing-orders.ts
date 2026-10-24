import 'dotenv/config';
import { readProcessingOrders, PROCESSING_ORDER_STORES } from '../src/services/processing-orders-service.js';
import { logger } from '../src/utils/logger.js';

/**
 * Pushes the latest processing orders to GV Catalog so the carton-label page ("ซิงค์จาก BigSeller") can show them.
 * Outbound only: this machine posts to https://<GV_CATALOG_URL>/api/bigseller/orders/push with the shared key, so
 * no tunnel, no open port. Run every 10-15 minutes by Task Scheduler (install-push-orders-task.ps1) or by hand with
 * run-push-processing-orders.bat. Read-only on BigSeller.
 *
 * .env: PROCESSING_ORDERS_API_KEY (same value as in Vercel), GV_CATALOG_URL (default https://gv-catalog.vercel.app),
 *       PROCESSING_ORDER_STORES (default "GV ส่งเอง"), PUSH_ORDERS_HEADLESS (default true: no browser window every run).
 *
 * A failed read pushes nothing, so the page keeps showing the last good copy and its age.
 */
async function main() {
  const key = process.env.PROCESSING_ORDERS_API_KEY ?? '';
  if (key.length < 16) throw new Error('PROCESSING_ORDERS_API_KEY is missing or shorter than 16 characters in .env');
  const base = (process.env.GV_CATALOG_URL ?? 'https://gv-catalog.vercel.app').replace(/\/$/, '');
  process.env.BIGSELLER_HEADLESS = process.env.PUSH_ORDERS_HEADLESS ?? 'true';

  for (const store of PROCESSING_ORDER_STORES) {
    const result = await readProcessingOrders(store);
    const res = await fetch(`${base}/api/bigseller/orders/push`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-gv-orders-key': key },
      body: JSON.stringify(result),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`push failed for "${store}": HTTP ${res.status} ${text.slice(0, 200)}`);
    await logger.info(`push:processing-orders — "${store}" ${result.orders.length} orders pushed`);
    console.log(`${store}: ${result.orders.length} ออเดอร์ ส่งขึ้น GV Catalog แล้ว`);
  }
}

main().catch(async (error) => {
  await logger.error(`push:processing-orders failed: ${(error as Error).message}`);
  console.error(error);
  process.exit(1);
});
