import { SheetsClient } from '../sheets/sheets-client.js';

const SHEET_SYNC_LOG = process.env.SHEET_SYNC_LOG ?? 'SYNC_LOG';

/**
 * Reads SYNC_LOG for the most recent row logged by `syncBigSeller()`'s own
 * "combined sync complete" marker (job=bigseller-sync, status=success) and
 * returns its runId. Each Phase 2-9 script is a separate `npm run` process
 * (per the project's CLI design), so this is how they agree on which sync run
 * to validate/plan/export/import without the caller having to pass a runId by
 * hand — set the `RUN_ID` environment variable to override for a specific run.
 */
export async function getLatestSuccessfulRunId(sheetsClient: SheetsClient): Promise<string> {
  if (process.env.RUN_ID) return process.env.RUN_ID;

  const rows = await sheetsClient.readAll(SHEET_SYNC_LOG);
  const header = rows[0] ?? [];
  const jobIdx = header.indexOf('job');
  const statusIdx = header.indexOf('status');
  const messageIdx = header.indexOf('message');
  const runIdIdx = header.indexOf('runId');
  if ([jobIdx, statusIdx, messageIdx, runIdIdx].some((i) => i === -1)) {
    throw new Error(`${SHEET_SYNC_LOG} is missing one of the expected columns (job, status, message, runId).`);
  }

  for (let i = rows.length - 1; i >= 1; i--) {
    const row = rows[i];
    if (row[jobIdx] === 'bigseller-sync' && row[statusIdx] === 'success' && row[messageIdx] === 'combined sync complete' && row[runIdIdx]) {
      return row[runIdIdx];
    }
  }
  throw new Error(`No successful "combined sync complete" run found in ${SHEET_SYNC_LOG}. Run "npm run sync:bigseller" first.`);
}

/** Reads `sheetName`, requires a `runId` column, and returns only the rows matching `runId` as header-keyed objects. */
export async function readRowsForRunId(sheetsClient: SheetsClient, sheetName: string, runId: string): Promise<Record<string, string>[]> {
  const rows = await sheetsClient.readAll(sheetName);
  const header = rows[0] ?? [];
  const runIdIdx = header.indexOf('runId');
  if (runIdIdx === -1) {
    throw new Error(`${sheetName} is missing the "runId" column — run scripts/migrate-sheets-for-transfer-plan.ts first.`);
  }
  return rows
    .slice(1)
    .filter((row) => row[runIdIdx] === runId)
    .map((row) => Object.fromEntries(header.map((h, i) => [h, row[i] ?? ''])));
}
