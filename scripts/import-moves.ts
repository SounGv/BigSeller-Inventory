import 'dotenv/config';
import { SheetsClient } from '../src/sheets/sheets-client.js';
import { getLatestSuccessfulRunId } from '../src/services/run-data.js';
import { exportMoveFiles } from '../src/services/move-export-service.js';
import { validateMoveFiles } from '../src/services/move-validation-service.js';
import { importFiles, updateTransferPlanStatus } from '../src/services/import-moves-service.js';
import { notifyTransferBillCreated } from '../src/services/line-notify-service.js';
import { logger } from '../src/utils/logger.js';

const WAREHOUSE_NAME = process.env.INVENTORY_WAREHOUSE_NAME ?? 'STOCK_5';

/**
 * Phase 9, real mode. Gated by `AUTO_IMPORT=true` — with it unset/false this
 * refuses to run at all. This is the one step in the whole pipeline that
 * creates real, live transfer documents in BigSeller with no undo through the
 * UI. The actual upload/remark/document-tracking logic lives in
 * src/services/import-moves-service.ts — shared with the LINE command-bot
 * (src/services/transfer-command-service.ts) so both entry points run the
 * exact same, live-debugged behavior.
 */
async function main() {
  const autoImport = (process.env.AUTO_IMPORT ?? 'false').toLowerCase() === 'true';
  if (!autoImport) {
    console.error('[REFUSED] AUTO_IMPORT ไม่ได้ตั้งเป็น true — จะไม่นำเข้าจริง ใช้ "npm run preview:moves" เพื่อดูตัวอย่างก่อน');
    process.exit(1);
  }

  const sheetsClient = await SheetsClient.create();
  const runId = await getLatestSuccessfulRunId(sheetsClient);
  const dateStamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');

  const allFiles = await exportMoveFiles(sheetsClient, runId, dateStamp);
  // Still validated as the FULL set (never validate only a subset) — a
  // problem in a zone you're not importing right now is still worth knowing
  // about before it's your turn to import it.
  const validation = await validateMoveFiles(allFiles);
  if (!validation.ok) {
    console.error('[REFUSED] ไฟล์ยังไม่ผ่านการตรวจสอบ — รัน "npm run validate:moves" เพื่อดูรายละเอียด');
    process.exit(1);
  }

  const zoneFilter = (process.env.MOVE_ZONE_FILTER ?? '').split(',').map((z) => z.trim()).filter(Boolean);
  const files = zoneFilter.length > 0 ? allFiles.filter((f) => zoneFilter.includes(f.zone)) : allFiles;
  if (zoneFilter.length > 0) {
    console.log(`MOVE_ZONE_FILTER=${zoneFilter.join(',')} — นำเข้าเฉพาะ ${files.length}/${allFiles.length} ไฟล์`);
    if (files.length === 0) {
      console.error(`[REFUSED] ไม่พบไฟล์โซนที่ตรงกับ MOVE_ZONE_FILTER (${zoneFilter.join(', ')})`);
      process.exit(1);
    }
  }

  const { results, documents } = await importFiles(sheetsClient, runId, files, WAREHOUSE_NAME);
  await updateTransferPlanStatus(sheetsClient, results);

  const failed = results.filter((r) => !r.ok);
  const succeededFiles = results.length - failed.length;
  console.log(`runId ${runId}: นำเข้าสำเร็จ ${succeededFiles}/${results.length} ไฟล์`);
  await logger.info(`import:moves complete for runId ${runId} — ${succeededFiles}/${results.length} succeeded`);

  // Notify only once real transfer documents actually exist to act on — never
  // tag the whole team over a run that created nothing. One message per
  // runId, not per document — see line-notify-service.ts for why.
  if (succeededFiles > 0) {
    const succeededRows = results.filter((r) => r.ok).flatMap((r) => r.rows);
    const skuCount = new Set(succeededRows.map((r) => r.sku)).size;
    const totalMoveQty = succeededRows.reduce((sum, r) => sum + r.moveQty, 0);
    const runDateTime = new Intl.DateTimeFormat('th-TH', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date());

    await notifyTransferBillCreated(sheetsClient, {
      runId,
      runDateTime,
      warehouse: WAREHOUSE_NAME,
      skuCount,
      moveRowCount: succeededRows.length,
      totalMoveQty,
      documents,
    });
  }

  if (failed.length > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
