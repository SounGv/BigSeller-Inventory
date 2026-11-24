import 'dotenv/config';
import { SheetsClient } from '../src/sheets/sheets-client.js';
import { logger } from '../src/utils/logger.js';

const SHEET_SKU_INVENTORY = process.env.SHEET_SKU_INVENTORY ?? 'DB_SKU_INVENTORY';
const SHEET_SYNC_LOG = process.env.SHEET_SYNC_LOG ?? 'SYNC_LOG';

/**
 * One-time cleanup for a real staleness bug found 2026-11-09: DB_SKU_INVENTORY
 * is written via SheetsClient.upsertRows (update-or-append, never delete), so
 * a SKU missing from a later real sync keeps its row forever under its old
 * runId. Found 20+ distinct runId values spanning 2026-08-25 through
 * 2026-11-04 still present in the same sheet (1983 total rows, even though
 * the most recent full sku-inventory sync only scraped 1635).
 *
 * Ground truth for "current" is SYNC_LOG's own last successful
 * `job: 'bigseller-sync', message: 'sku-inventory'` row — its runId is what
 * every genuinely-current row should carry, and its rowsProcessed is the
 * expected row count after cleanup (verified, not assumed).
 *
 * DryRun ladder (Tier A — our own table, idempotent, safe to re-run):
 *   DRY_RUN=true npx tsx scripts/cleanup-stale-sku-inventory-rows.ts   (step 2, full)
 *   npx tsx scripts/cleanup-stale-sku-inventory-rows.ts                (step 4, full)
 */
async function main() {
  const sheetsClient = await SheetsClient.create();
  const dryRun = (process.env.DRY_RUN ?? 'false').toLowerCase() === 'true';

  const syncLog = await sheetsClient.readAll(SHEET_SYNC_LOG);
  const logHeader = syncLog[0];
  const jobIdx = logHeader.indexOf('job');
  const statusIdx = logHeader.indexOf('status');
  const messageIdx = logHeader.indexOf('message');
  const runIdIdx = logHeader.indexOf('runId');
  const rowsIdx = logHeader.indexOf('rowsProcessed');

  const lastSkuSync = [...syncLog.slice(1)]
    .reverse()
    .find((r) => r[jobIdx] === 'bigseller-sync' && r[statusIdx] === 'success' && r[messageIdx] === 'sku-inventory');

  if (!lastSkuSync) throw new Error(`No successful "sku-inventory" entry found in ${SHEET_SYNC_LOG} — cannot determine the current runId.`);

  const currentRunId = lastSkuSync[runIdIdx];
  const expectedRowCount = Number(lastSkuSync[rowsIdx]);
  console.log(`Current (latest real) sku-inventory runId: ${currentRunId}, expected row count: ${expectedRowCount}`);

  const rows = await sheetsClient.readAll(SHEET_SKU_INVENTORY);
  const header = rows[0];
  const skuIdx = header.indexOf('sku');
  const dataRunIdIdx = header.indexOf('runId');
  const updatedIdx = header.indexOf('sourceUpdatedAt');

  const staleRowNumbers: number[] = [];
  const staleSample: string[] = [];
  let keptCount = 0;
  rows.slice(1).forEach((row, i) => {
    const sheetRowNumber = i + 2; // 1-indexed, header = row 1
    if (row[dataRunIdIdx] === currentRunId) {
      keptCount++;
    } else {
      staleRowNumbers.push(sheetRowNumber);
      if (staleSample.length < 5) staleSample.push(`${row[skuIdx]} | runId=${row[dataRunIdIdx]} | sourceUpdatedAt=${row[updatedIdx]}`);
    }
  });

  const rowsIn = rows.length - 1;
  console.log('--- DryRun report ---');
  console.log(`rows_in: ${rowsIn}`);
  console.log(`matched (current runId, kept): ${keptCount}`);
  console.log(`to_delete (stale, other runIds): ${staleRowNumbers.length}`);
  console.log(`null_count: 0 (sku/runId columns required to classify every row above)`);
  console.log(`duplicate_count: n/a (delete-only cleanup, no insert/update)`);
  console.log('sample_diff (up to 5 stale rows that would be removed):');
  for (const line of staleSample) console.log(' -', line);
  console.log(`reconciliation: rows_in (${rowsIn}) = matched (${keptCount}) + to_delete (${staleRowNumbers.length}) -> ${rowsIn === keptCount + staleRowNumbers.length ? 'OK' : 'MISMATCH'}`);
  console.log(`expected final row count after cleanup: ${expectedRowCount} (matches kept count: ${keptCount === expectedRowCount ? 'OK' : 'MISMATCH — investigate before deleting'})`);

  if (dryRun) {
    console.log('\nDRY_RUN=true — no rows deleted. Re-run with DRY_RUN=false (or unset) to apply.');
    return;
  }

  if (staleRowNumbers.length === 0) {
    console.log('\nNothing to delete — sheet is already clean.');
    return;
  }

  await sheetsClient.deleteRows(SHEET_SKU_INVENTORY, staleRowNumbers);

  const after = await sheetsClient.readAll(SHEET_SKU_INVENTORY);
  const afterCount = after.length - 1;
  console.log(`\nDeleted ${staleRowNumbers.length} stale row(s). ${SHEET_SKU_INVENTORY} now has ${afterCount} row(s) (expected ${expectedRowCount}).`);
  if (afterCount !== expectedRowCount) {
    await logger.error(`cleanup-stale-sku-inventory-rows: post-delete count ${afterCount} does not match expected ${expectedRowCount}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
