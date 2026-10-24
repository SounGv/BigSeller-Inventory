import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { withBigSellerPage } from '../src/utils/browser-runner.js';
import { BigSellerProcessingOrdersPage, type ProcessingOrder } from '../src/bigseller/processing-orders-page.js';
import { logger } from '../src/utils/logger.js';

/**
 * Reads the processing orders of the stores that need carton labels and writes
 * them to a JSON file for the GV Catalog "ใบแปะลังจากออเดอร์" page to open.
 * Read-only on BigSeller; the file stays on this machine (output/ is
 * gitignored) because it holds customer names and PO numbers.
 *
 *   npm run export:processing-orders                 -> store "GV ส่งเอง"
 *   npm run export:processing-orders -- --store "COM 7"
 *   npm run export:processing-orders -- --out C:\\path\\orders.json
 */
const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

async function main() {
  const store = arg('--store') ?? 'GV ส่งเอง';
  const out = resolve(arg('--out') ?? 'output/processing-orders.json');

  const orders: ProcessingOrder[] = await withBigSellerPage('export-processing-orders', async (page) => {
    const processing = new BigSellerProcessingOrdersPage(page);
    await processing.goto();
    await processing.selectStore(store);
    return processing.readOrders(store);
  });

  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify({ exportedAt: new Date().toISOString(), store, orders }, null, 1), 'utf8');
  const lineCount = orders.reduce((n, o) => n + o.lines.length, 0);
  await logger.info(`export:processing-orders — ${orders.length} orders, ${lineCount} SKU lines (store "${store}") -> ${out}`);
  console.log(`\n${orders.length} ออเดอร์ / ${lineCount} รายการ SKU (ร้าน "${store}") -> ${out}`);
  if (orders.length === 0) console.log('ไม่พบออเดอร์ในแท็บ "พิมพ์ได้" ของร้านนี้ ตรวจที่ BigSeller ว่ามีออเดอร์ค้างพิมพ์อยู่หรือไม่');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
