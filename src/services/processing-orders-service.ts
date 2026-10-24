import { withBigSellerPage } from '../utils/browser-runner.js';
import { BigSellerProcessingOrdersPage, type ProcessingOrder } from '../bigseller/processing-orders-page.js';
import { logger } from '../utils/logger.js';

/** Stores the carton-label page may read; anything else is refused so the API cannot be pointed at online-store orders. */
export const PROCESSING_ORDER_STORES = (process.env.PROCESSING_ORDER_STORES ?? 'GV ส่งเอง')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

export interface ProcessingOrdersResult {
  exportedAt: string;
  store: string;
  orders: ProcessingOrder[];
}

/** Same read as `scripts/export-processing-orders.ts`, returned instead of written to a file. Read-only on BigSeller. */
export async function readProcessingOrders(store: string): Promise<ProcessingOrdersResult> {
  if (!PROCESSING_ORDER_STORES.includes(store)) throw new Error(`store "${store}" is not in PROCESSING_ORDER_STORES`);
  const orders = await withBigSellerPage('actions-api-processing-orders', async (page) => {
    const processing = new BigSellerProcessingOrdersPage(page);
    await processing.goto();
    await processing.selectStore(store);
    return processing.readOrders(store);
  });
  await logger.info(`actions-api: processing orders — ${orders.length} orders (store "${store}")`);
  return { exportedAt: new Date().toISOString(), store, orders };
}
