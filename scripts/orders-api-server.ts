import 'dotenv/config';
import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readProcessingOrders, PROCESSING_ORDER_STORES } from '../src/services/processing-orders-service.js';
import { logger } from '../src/utils/logger.js';

/**
 * Tiny local API behind a tunnel: the GV Catalog carton-label page ("ซิงค์จาก BigSeller" button) reaches it through
 * its own Vercel route, never from the browser. One route, read-only on BigSeller, one job at a time.
 *
 *   GET /health                           -> { ok: true }
 *   GET /api/processing-orders?store=...  -> { ok, exportedAt, store, orders }   (header X-GV-Orders-Key)
 *
 * Needs PROCESSING_ORDERS_API_KEY (16+ chars) in .env. Fail closed: with no key nobody gets in. The key is
 * compared in constant time. Needs a valid BigSeller session (`npm run login:bigseller`, `npm run keep-alive`).
 */
const PORT = Number(process.env.ORDERS_API_PORT ?? 3003);
let inFlight = false;

const send = (res: import('node:http').ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
};

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true });
  if (req.method !== 'GET' || url.pathname !== '/api/processing-orders') return send(res, 404, { ok: false, message: 'not found' });

  const expected = process.env.PROCESSING_ORDERS_API_KEY ?? '';
  const given = String(req.headers['x-gv-orders-key'] ?? '');
  const same = expected.length >= 16 && given.length === expected.length && timingSafeEqual(Buffer.from(given), Buffer.from(expected));
  if (!same) {
    await logger.info('orders-api: rejected — bad or missing X-GV-Orders-Key');
    return send(res, 401, { ok: false, message: 'unauthorized' });
  }
  if (inFlight) return send(res, 409, { ok: false, message: 'กำลังดึงข้อมูลอยู่ กรุณารอสักครู่' });

  inFlight = true;
  try {
    const store = url.searchParams.get('store') ?? PROCESSING_ORDER_STORES[0];
    send(res, 200, { ok: true, ...(await readProcessingOrders(store)) });
  } catch (error) {
    await logger.error(`orders-api: failed: ${(error as Error).message}`);
    send(res, 500, { ok: false, message: (error as Error).message });
  } finally {
    inFlight = false;
  }
}).listen(PORT, () => {
  console.log(`Orders API listening on http://localhost:${PORT} (stores: ${PROCESSING_ORDER_STORES.join(', ')})`);
  console.log('Point a Cloudflare Tunnel at this port. Set PROCESSING_ORDERS_API_KEY in .env first.');
});
