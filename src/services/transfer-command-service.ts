import { SheetsClient } from '../sheets/sheets-client.js';
import { withBigSellerPage } from '../utils/browser-runner.js';
import { syncBigSeller } from './sync-service.js';
import { validateSync } from './validate-sync.js';
import { planMoves } from './transfer-plan-service.js';
import { exportMoveFiles } from './move-export-service.js';
import { validateMoveFiles } from './move-validation-service.js';
import { importFiles, updateTransferPlanStatus } from './import-moves-service.js';
import { notifyTransferBillCreated, type DocumentInfo } from './line-notify-service.js';
import { logger } from '../utils/logger.js';

const WAREHOUSE_NAME = process.env.INVENTORY_WAREHOUSE_NAME ?? 'STOCK_5';

export type PipelineStage = 'gate' | 'sync' | 'validate-sync' | 'plan' | 'export' | 'validate-moves' | 'import' | 'done';

export interface PipelineOutcome {
  ok: boolean;
  stage: PipelineStage;
  message: string;
  runId?: string;
  succeededFiles?: number;
  totalFiles?: number;
  documents?: DocumentInfo[];
}

function describeError(error: unknown): string {
  if (error instanceof Error && error.name === 'SessionExpiredError') {
    return 'BigSeller session หมดอายุระหว่างทำงาน — ต้องให้พนักงานที่มีสิทธิ์รัน "npm run login:bigseller" เพื่อล็อกอินใหม่ก่อน แล้วค่อยสั่งงานอีกครั้ง';
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * End-to-end Phase 1-9, run in one shot for the LINE command-bot
 * (scripts/line-command-bot.ts): sync -> validate -> plan -> export ->
 * validate -> import. Mirrors the sequence of the separate `npm run`
 * scripts exactly (see scripts/plan-moves.ts, export-moves.ts,
 * validate-moves.ts, import-moves.ts) so a staff member watching the Google
 * Sheet sees the identical trail either way — the only difference is that
 * here every phase runs inside one process instead of one per `npm run`
 * invocation, because a LINE command has to produce one final answer.
 *
 * Never throws — every failure mode returns a PipelineOutcome with ok:false
 * so the caller can always push a status message back to the group instead
 * of leaving staff wondering whether anything happened.
 */
export async function runFullTransferPipeline(sheetsClient: SheetsClient): Promise<PipelineOutcome> {
  const autoImport = (process.env.AUTO_IMPORT ?? 'false').toLowerCase() === 'true';
  if (!autoImport) {
    return {
      ok: false,
      stage: 'gate',
      message: 'ระบบปิดการนำเข้าอัตโนมัติอยู่ (AUTO_IMPORT=false) — ต้องให้แอดมินเปิดค่านี้ใน .env ก่อนจึงจะสั่งสร้างใบย้ายผ่าน LINE ได้',
    };
  }

  let runId: string;
  try {
    const syncResult = await withBigSellerPage('bigseller-sync', (page) => syncBigSeller(page, sheetsClient));
    runId = syncResult.runId;
  } catch (error) {
    return { ok: false, stage: 'sync', message: describeError(error) };
  }

  const validation = await validateSync(sheetsClient, runId).catch((error) => ({ ok: false as const, problems: [describeError(error)] }));
  if (!validation.ok) {
    return { ok: false, stage: 'validate-sync', runId, message: validation.problems.join('; ') };
  }

  let plan;
  try {
    ({ plan } = await planMoves(sheetsClient, runId));
  } catch (error) {
    return { ok: false, stage: 'plan', runId, message: describeError(error) };
  }
  if (plan.length === 0) {
    return { ok: true, stage: 'done', runId, succeededFiles: 0, totalFiles: 0, message: 'ตรวจสอบแล้ว — ไม่มีตำแหน่งที่ต้องเติมสต็อกในรอบนี้ ไม่ได้สร้างใบย้ายใดๆ' };
  }

  const dateStamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  let files;
  try {
    files = await exportMoveFiles(sheetsClient, runId, dateStamp);
  } catch (error) {
    return { ok: false, stage: 'export', runId, message: describeError(error) };
  }

  const moveValidation = await validateMoveFiles(files);
  if (!moveValidation.ok) {
    return { ok: false, stage: 'validate-moves', runId, message: moveValidation.problems.slice(0, 10).join('; ') };
  }

  let results, documents: DocumentInfo[];
  try {
    ({ results, documents } = await importFiles(sheetsClient, runId, files, WAREHOUSE_NAME));
  } catch (error) {
    return { ok: false, stage: 'import', runId, message: describeError(error) };
  }

  await updateTransferPlanStatus(sheetsClient, results);
  await logger.info(`line-command-bot: import complete for runId ${runId} — ${results.filter((r) => r.ok).length}/${results.length} succeeded`);

  const failed = results.filter((r) => !r.ok);
  const succeededFiles = results.length - failed.length;

  if (succeededFiles > 0) {
    const succeededRows = results.filter((r) => r.ok).flatMap((r) => r.rows);
    const skuCount = new Set(succeededRows.map((r) => r.sku)).size;
    const totalMoveQty = succeededRows.reduce((sum, r) => sum + r.moveQty, 0);
    const runDateTime = new Intl.DateTimeFormat('th-TH', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date());

    // This already pushes the full P1-P4 breakdown to the group — the
    // "แจ้งกลับในกลุ่มเมื่อทำเสร็จ" requirement for the success case is
    // satisfied here, not by a second message from the bot itself.
    await notifyTransferBillCreated(sheetsClient, {
      runId,
      runDateTime,
      warehouse: WAREHOUSE_NAME,
      skuCount,
      moveRowCount: succeededRows.length,
      totalMoveQty,
      documents,
    });

    return {
      ok: failed.length === 0,
      stage: 'done',
      runId,
      succeededFiles,
      totalFiles: results.length,
      documents,
      message: `นำเข้าสำเร็จ ${succeededFiles}/${results.length} ไฟล์`,
    };
  }

  return {
    ok: false,
    stage: 'import',
    runId,
    succeededFiles: 0,
    totalFiles: results.length,
    message: `นำเข้าไม่สำเร็จเลยทั้ง ${results.length} ไฟล์ — ดูรายละเอียดใน ERROR_LOG`,
  };
}
