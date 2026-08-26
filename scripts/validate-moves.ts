import 'dotenv/config';
import { SheetsClient } from '../src/sheets/sheets-client.js';
import { getLatestSuccessfulRunId } from '../src/services/run-data.js';
import { exportMoveFiles } from '../src/services/move-export-service.js';
import { validateMoveFiles } from '../src/services/move-validation-service.js';
import { logError } from '../src/services/sync-service.js';
import { logger } from '../src/utils/logger.js';

/**
 * Phase 8. Re-derives the same zone files "npm run export:moves" would write
 * (same PLANNED rows in DB_TRANSFER_PLAN, same date stamp convention) rather
 * than trusting that a previous process's export is still what's on disk —
 * consistent with every other phase re-reading from Sheets instead of passing
 * state between separate `npm run` invocations.
 */
async function main() {
  const sheetsClient = await SheetsClient.create();
  const runId = await getLatestSuccessfulRunId(sheetsClient);
  const dateStamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');

  const files = await exportMoveFiles(sheetsClient, runId, dateStamp);
  const result = await validateMoveFiles(files);

  if (!result.ok) {
    for (const problem of result.problems) console.error(`[FAIL] ${problem}`);
    await logError(
      { job: 'validate-moves', url: '', step: 'validate-moves', errorMessage: result.problems.join('; '), runId },
      sheetsClient,
    );
    await logger.error(`validate:moves FAILED for runId ${runId}`);
    process.exit(1);
  }

  console.log(`[OK] runId ${runId}: ${files.length} ไฟล์ ผ่านการตรวจสอบทั้งหมด`);
  await logger.info(`validate:moves OK for runId ${runId}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
