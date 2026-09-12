import 'dotenv/config';
import { SheetsClient } from '../src/sheets/sheets-client.js';
import { getLatestSuccessfulRunId } from '../src/services/run-data.js';
import { validateSync } from '../src/services/validate-sync.js';
import { planMoves } from '../src/services/transfer-plan-service.js';
import { logger } from '../src/utils/logger.js';

/**
 * Optional manual override for one run — e.g. `TARGET_ZONE_FILTER=F npm run
 * plan:moves` plans only zone F (F01+F02+F03, prefix match). Same underlying
 * filter the LINE command-bot's per-zone trigger uses (see
 * computeReplenishmentCandidates in transfer-plan-service.ts); exposed here
 * too so a one-off/manual planning run doesn't need the LINE bot running.
 * Leave unset for normal use — every zone gets planned, same as before this
 * existed.
 */
const TARGET_ZONE_FILTER = process.env.TARGET_ZONE_FILTER?.trim() || undefined;

/** Phase 3+4+5. Re-validates the sync before planning — a plan must never be built from data that hasn't passed Phase 2. */
async function main() {
  const sheetsClient = await SheetsClient.create();
  const runId = await getLatestSuccessfulRunId(sheetsClient);

  const validation = await validateSync(sheetsClient, runId);
  if (!validation.ok) {
    console.error(`[FAIL] runId ${runId} ไม่ผ่าน validate:sync — รัน "npm run validate:sync" เพื่อดูรายละเอียด`);
    process.exit(1);
  }

  if (TARGET_ZONE_FILTER) {
    console.log(`TARGET_ZONE_FILTER=${TARGET_ZONE_FILTER} — วางแผนเฉพาะโซนนี้เท่านั้น`);
  }

  const { plan, exceptions } = await planMoves(sheetsClient, runId, TARGET_ZONE_FILTER);
  console.log(`runId ${runId}: สร้างแผนย้าย ${plan.length} รายการ, ข้อยกเว้น ${exceptions.length} รายการ`);
  await logger.info(`plan:moves complete for runId ${runId} — ${plan.length} plan rows, ${exceptions.length} exceptions${TARGET_ZONE_FILTER ? ` (TARGET_ZONE_FILTER=${TARGET_ZONE_FILTER})` : ''}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
