import 'dotenv/config';
import { SheetsClient } from '../src/sheets/sheets-client.js';
import { getLatestSuccessfulRunId } from '../src/services/run-data.js';
import { exportMoveFiles } from '../src/services/move-export-service.js';
import { logger } from '../src/utils/logger.js';

/** Phase 6+7: writes one .xlsx per (zone, 5,000-row chunk) for the current runId's PLANNED transfer-plan rows. */
async function main() {
  const sheetsClient = await SheetsClient.create();
  const runId = await getLatestSuccessfulRunId(sheetsClient);
  const dateStamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');

  const files = await exportMoveFiles(sheetsClient, runId, dateStamp);
  for (const file of files) console.log(`${file.filePath} (${file.rowCount} แถว)`);
  console.log(`runId ${runId}: สร้างไฟล์ทั้งหมด ${files.length} ไฟล์`);
  await logger.info(`export:moves complete for runId ${runId} — ${files.length} file(s)`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
