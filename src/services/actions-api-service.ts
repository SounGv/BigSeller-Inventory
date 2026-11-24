import { createClient } from '@supabase/supabase-js';
import { SheetsClient } from '../sheets/sheets-client.js';
import { syncBigSeller } from './sync-service.js';
import { planMoves } from './transfer-plan-service.js';
import { validateSync } from './validate-sync.js';
import { getLatestSuccessfulRunId, readRowsForRunId } from './run-data.js';
import { withBigSellerPage } from '../utils/browser-runner.js';
import { logger } from '../utils/logger.js';
import type { SyncRunResult, TransferPlanRow, TransferExceptionRow } from '../types.js';

const SHEET_TRANSFER_PLAN = process.env.SHEET_TRANSFER_PLAN ?? 'DB_TRANSFER_PLAN';
const SHEET_TRANSFER_EXCEPTION = process.env.SHEET_TRANSFER_EXCEPTION ?? 'TRANSFER_EXCEPTION';

const ALLOWED_EMAILS = new Set(
  (process.env.ACTIONS_API_ALLOWED_EMAILS ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean),
);

/**
 * Verifies a Supabase-issued access token (the JWT `supabase-js` hands the
 * GV Ops Console frontend after sign-in) and checks the resulting email
 * against `ACTIONS_API_ALLOWED_EMAILS` — the same defense-in-depth pattern as
 * the LINE bot's `LINE_COMMAND_ALLOWED_USER_IDS` (a valid login alone is not
 * enough; the account must also be explicitly allow-listed). Uses the
 * service-role key already in `.env` — `auth.getUser(token)` only validates
 * the token against Supabase Auth, it grants no elevated privilege here.
 */
export async function verifyStaffToken(authorizationHeader: string | undefined): Promise<{ ok: true; email: string } | { ok: false; reason: string }> {
  const token = authorizationHeader?.startsWith('Bearer ') ? authorizationHeader.slice('Bearer '.length) : undefined;
  if (!token) return { ok: false, reason: 'missing bearer token' };

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) return { ok: false, reason: 'server missing SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY' };

  const supabase = createClient(supabaseUrl, supabaseKey);
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user?.email) return { ok: false, reason: 'invalid or expired session' };

  const email = data.user.email.toLowerCase();
  if (ALLOWED_EMAILS.size === 0) return { ok: false, reason: 'ACTIONS_API_ALLOWED_EMAILS is empty — no one is authorized' };
  if (!ALLOWED_EMAILS.has(email)) return { ok: false, reason: `${email} is not in ACTIONS_API_ALLOWED_EMAILS` };

  return { ok: true, email };
}

export interface ActionSyncResult {
  runId: string;
  locationRowCount: number;
  skuRowCount: number;
}

/** POST /api/sync — pulls fresh stock + location data from BigSeller. Same operation as `npm run sync:bigseller`. */
export async function runSync(): Promise<ActionSyncResult> {
  const sheetsClient = await SheetsClient.create();
  const result: SyncRunResult = await withBigSellerPage('actions-api-sync', (page) => syncBigSeller(page, sheetsClient));
  await logger.info(`actions-api: sync complete — runId=${result.runId}, ${result.locationRows.length} location rows, ${result.skuRows.length} sku rows`);
  return {
    runId: result.runId,
    locationRowCount: result.locationRows.length,
    skuRowCount: result.skuRows.length,
  };
}

export interface ActionPlanResult {
  runId: string;
  plan: TransferPlanRow[];
  exceptions: TransferExceptionRow[];
}

/** POST /api/plan — builds a replenishment plan against the latest successful sync (or RUN_ID override). Same operation as `npm run plan:moves`. */
export async function runPlan(targetZonePrefix?: string): Promise<ActionPlanResult> {
  const sheetsClient = await SheetsClient.create();
  const runId = await getLatestSuccessfulRunId(sheetsClient);

  const validation = await validateSync(sheetsClient, runId);
  if (!validation.ok) {
    throw new Error(`runId ${runId} ไม่ผ่าน validate:sync — ${validation.problems.join('; ')}`);
  }

  const { plan, exceptions } = await planMoves(sheetsClient, runId, targetZonePrefix);
  await logger.info(`actions-api: plan complete — runId=${runId}, ${plan.length} plan rows, ${exceptions.length} exceptions`);
  return { runId, plan, exceptions };
}

/** GET /api/plan/:runId — the plan rows already written for a given runId (no recomputation). */
export async function getPlan(runId: string): Promise<TransferPlanRow[]> {
  const sheetsClient = await SheetsClient.create();
  const rows = await readRowsForRunId(sheetsClient, SHEET_TRANSFER_PLAN, runId);
  return rows.map((r) => ({
    runId: r.runId,
    sku: r.sku,
    sourcePosition: r.sourcePosition,
    targetPosition: r.targetPosition,
    sourceQty: Number(r.sourceQty),
    targetQty: Number(r.targetQty),
    targetZone: r.targetZone,
    stockAtPosition: Number(r.stockAtPosition),
    totalWarehouseStock: Number(r.totalWarehouseStock),
    replenishableQty: Number(r.replenishableQty),
    moveQty: Number(r.moveQty),
    status: r.status as TransferPlanRow['status'],
    createdAt: r.createdAt,
  }));
}

/** GET /api/exceptions/:runId — the exceptions already written for a given runId. */
export async function getExceptions(runId: string): Promise<TransferExceptionRow[]> {
  const sheetsClient = await SheetsClient.create();
  const rows = await readRowsForRunId(sheetsClient, SHEET_TRANSFER_EXCEPTION, runId);
  return rows.map((r) => ({
    runId: r.runId,
    sku: r.sku,
    targetPosition: r.targetPosition,
    replenishableQty: Number(r.replenishableQty),
    warehouseRemainingQty: Number(r.warehouseRemainingQty),
    reason: r.reason,
    recordedAt: r.recordedAt,
  }));
}
