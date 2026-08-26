import 'dotenv/config';
import { SheetsClient } from '../src/sheets/sheets-client.js';
import { getLatestSuccessfulRunId } from '../src/services/run-data.js';
import { validateSync } from '../src/services/validate-sync.js';
import { logError } from '../src/services/sync-service.js';
import { logger } from '../src/utils/logger.js';

/** Phase 2. Never skip this — nothing downstream (plan/export/import) may run against a runId this script has not passed. */
async function main() {
  const sheetsClient = await SheetsClient.create();
  const runId = await getLatestSuccessfulRunId(sheetsClient);
  const result = await validateSync(sheetsClient, runId);

  if (!result.ok) {
    for (const problem of result.problems) console.error(`[FAIL] ${problem}`);
    await logError(
      { job: 'validate-sync', url: '', step: 'validate-sync', errorMessage: result.problems.join('; '), runId },
      sheetsClient,
    );
    await logger.error(`validate:sync FAILED for runId ${runId}: ${result.problems.join('; ')}`);
    process.exit(1);
  }

  console.log(`[OK] runId ${runId}: ${result.locationRowCount} location rows, ${result.skuRowCount} SKU rows — ผ่านการตรวจสอบ`);
  await logger.info(`validate:sync OK for runId ${runId}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
