import 'dotenv/config';
import { createServer } from 'node:http';
import {
  verifyStaffToken,
  runSync,
  runPlan,
  getPlan,
  getExceptions,
} from '../src/services/actions-api-service.js';
import { logger } from '../src/utils/logger.js';

/**
 * HTTP API letting authenticated staff on GV Ops Console (a separate,
 * publicly-hosted read-only reporting dashboard — see that repo's README)
 * trigger the read/plan/preview parts of this project's pipeline without
 * needing this AI/CLI tool or LINE. Deliberately v1-scoped to NOT expose the
 * live "create real transfer documents in BigSeller" step
 * (`runFullTransferPipeline`'s import stage, AUTO_IMPORT-gated) — that stays
 * LINE-bot-only. This process only ever reads BigSeller/Sheets data and
 * writes to Sheets, never to BigSeller's own live records.
 *
 * Same raw `http.createServer` style as `scripts/line-command-bot.ts` — no
 * new framework dependency. Must stay running continuously with a public
 * HTTPS URL pointed at it (e.g. a Cloudflare Tunnel) for the deployed
 * dashboard to reach it, and needs `scripts/session-keeper.ts` (`npm run
 * keep-alive`) running alongside it so the shared BigSeller browser session
 * (`playwright/.auth/bigseller.json`) stays valid.
 */
const PORT = Number(process.env.ACTIONS_API_PORT ?? 3002);
const ALLOWED_ORIGINS = new Set(
  (process.env.ACTIONS_API_ALLOWED_ORIGINS ?? 'http://localhost:5173,https://gv-ops-console.vercel.app')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean),
);

let actionInFlight = false;

function corsHeaders(origin: string | undefined): Record<string, string> {
  const allowOrigin = origin && ALLOWED_ORIGINS.has(origin) ? origin : '';
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    Vary: 'Origin',
  };
}

function sendJson(res: import('node:http').ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(payload);
}

async function readJsonBody(req: import('node:http').IncomingMessage): Promise<Record<string, unknown>> {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

const server = createServer(async (req, res) => {
  const origin = req.headers.origin;
  const headers = corsHeaders(origin);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, headers);
    res.end();
    return;
  }
  for (const [key, value] of Object.entries(headers)) res.setHeader(key, value);

  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);

  // Health check — no auth required, so a monitor/tunnel can confirm the
  // process is alive without needing a staff token.
  if (req.method === 'GET' && url.pathname === '/health') {
    sendJson(res, 200, { ok: true });
    return;
  }

  const auth = await verifyStaffToken(req.headers.authorization);
  if (!auth.ok) {
    await logger.info(`actions-api: rejected request to ${url.pathname} — ${auth.reason}`);
    sendJson(res, 401, { ok: false, message: auth.reason });
    return;
  }

  try {
    if (req.method === 'POST' && url.pathname === '/api/sync') {
      if (actionInFlight) {
        sendJson(res, 409, { ok: false, message: 'มีการดึงข้อมูล/สร้างแผนอื่นกำลังทำงานอยู่ กรุณารอสักครู่' });
        return;
      }
      actionInFlight = true;
      try {
        await logger.info(`actions-api: ${auth.email} triggered /api/sync`);
        const result = await runSync();
        sendJson(res, 200, { ok: true, ...result });
      } finally {
        actionInFlight = false;
      }
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/plan') {
      if (actionInFlight) {
        sendJson(res, 409, { ok: false, message: 'มีการดึงข้อมูล/สร้างแผนอื่นกำลังทำงานอยู่ กรุณารอสักครู่' });
        return;
      }
      actionInFlight = true;
      try {
        const body = await readJsonBody(req);
        const targetZonePrefix = typeof body.targetZonePrefix === 'string' ? body.targetZonePrefix : undefined;
        await logger.info(`actions-api: ${auth.email} triggered /api/plan${targetZonePrefix ? ` (zone=${targetZonePrefix})` : ''}`);
        const result = await runPlan(targetZonePrefix);
        sendJson(res, 200, { ok: true, ...result });
      } finally {
        actionInFlight = false;
      }
      return;
    }

    const planMatch = url.pathname.match(/^\/api\/plan\/([^/]+)$/);
    if (req.method === 'GET' && planMatch) {
      const plan = await getPlan(planMatch[1]);
      sendJson(res, 200, { ok: true, runId: planMatch[1], plan });
      return;
    }

    const exceptionsMatch = url.pathname.match(/^\/api\/exceptions\/([^/]+)$/);
    if (req.method === 'GET' && exceptionsMatch) {
      const exceptions = await getExceptions(exceptionsMatch[1]);
      sendJson(res, 200, { ok: true, runId: exceptionsMatch[1], exceptions });
      return;
    }

    sendJson(res, 404, { ok: false, message: 'not found' });
  } catch (error) {
    await logger.error(`actions-api: unhandled error on ${req.method} ${url.pathname}: ${(error as Error).message}`);
    sendJson(res, 500, { ok: false, message: (error as Error).message });
  }
});

server.listen(PORT, () => {
  console.log(`Actions API listening on http://localhost:${PORT}`);
  console.log(`Allowed origins: ${[...ALLOWED_ORIGINS].join(', ')}`);
  console.log('Point a Cloudflare Tunnel (or similar) at this port for GV Ops Console to reach it.');
});
