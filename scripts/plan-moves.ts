import 'dotenv/config';
import { SheetsClient } from '../src/sheets/sheets-client.js';
import { getLatestSuccessfulRunId } from '../src/services/run-data.js';
import { validateSync } from '../src/services/validate-sync.js';
import { planMoves } from '../src/services/transfer-plan-service.js';
import { logger } from '../src/utils/logger.js';

/** Phase 3+4+5. Re-validates the sync before planning — a plan must never be built from data that hasn't passed Phase 2. */
async function main() {
  const sheetsClient = await SheetsClient.create();
  const runId = await getLatestSuccessfulRunId(sheetsClient);

  const validation = await validateSync(sheetsClient, runId);
  if (!validation.ok) {
    console.error(`[FAIL] runId ${runId} ไม่ผ่าน validate:sync — รัน "npm run validate:sync" เพื่อดูรายละเอียด`);
    process.exit(1);
  }

  const { plan, exceptions } = await planMoves(sheetsClient, runId);
  console.log(`runId ${runId}: สร้างแผนย้าย ${plan.length} รายการ, ข้อยกเว้น ${exceptions.length} รายการ`);
  await logger.info(`plan:moves complete for runId ${runId} — ${plan.length} plan rows, ${exceptions.length} exceptions`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
