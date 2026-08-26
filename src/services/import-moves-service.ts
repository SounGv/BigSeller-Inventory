import { SheetsClient } from '../sheets/sheets-client.js';
import { withBigSellerPage } from '../utils/browser-runner.js';
import { BigSellerMovingGoodsPage } from '../bigseller/moving-goods-page.js';
import { logError } from './sync-service.js';
import { assignPriorities, type DocumentInfo, type Priority } from './line-notify-service.js';
import { syncSkuSales, buildPriorityRemark } from './sku-sales-service.js';
import { logger } from '../utils/logger.js';
import { humanDelay } from '../utils/human-delay.js';
import type { ZoneFile } from './move-export-service.js';
import type { TransferPlanRow, TransferStatus } from '../types.js';

const SHEET_TRANSFER_PLAN = process.env.SHEET_TRANSFER_PLAN ?? 'DB_TRANSFER_PLAN';
const TRANSFER_PLAN_HEADERS = [
  'runId', 'sku', 'sourcePosition', 'targetPosition', 'sourceQty', 'targetQty', 'targetZone',
  'stockAtPosition', 'totalWarehouseStock', 'replenishableQty', 'moveQty', 'status', 'createdAt',
] as const;

export interface ImportFileResult {
  filePath: string;
  ok: boolean;
  message: string;
  rows: TransferPlanRow[];
}

export interface ImportFilesOutcome {
  results: ImportFileResult[];
  documents: DocumentInfo[];
}

/**
 * Phase 9, real mode — the actual "upload each zone file, wait for its
 * document number, set the sales remark" loop. Extracted out of
 * scripts/import-moves.ts so both the manual CLI script and the LINE
 * command-bot (src/services/transfer-command-service.ts) share the exact
 * same, carefully live-debugged logic instead of drifting apart — every
 * comment below documents a real bug fixed by watching a real run.
 */
export async function importFiles(
  sheetsClient: SheetsClient,
  runId: string,
  files: ZoneFile[],
  warehouse: string,
): Promise<ImportFilesOutcome> {
  const results: ImportFileResult[] = [];
  const documents: DocumentInfo[] = [];
  const setSalesRemark = (process.env.SET_SALES_REMARK ?? 'true').toLowerCase() === 'true';

  await withBigSellerPage('import-moves', async (page) => {
    const movingGoodsPage = new BigSellerMovingGoodsPage(page);
    await movingGoodsPage.goto();
    await movingGoodsPage.selectWarehouse(warehouse);

    let salesBySku: Map<string, number> | null = null;
    if (setSalesRemark) {
      try {
        const salesRows = await syncSkuSales(page, sheetsClient, runId, warehouse);
        salesBySku = new Map(salesRows.map((r) => [r.sku, r.avgDailySales]));
      } catch (error) {
        await logger.error(`syncSkuSales failed — continuing without sales remarks: ${(error as Error).message}`);
      }
      // Always return to the moving-goods list after the sales-report detour —
      // confirmed live (2026-08-25): leaving `page` on the sales-report URL
      // made every file in the loop below fail waiting for a "นำเข้า" button
      // that doesn't exist on that page.
      await movingGoodsPage.goto();
      await movingGoodsPage.selectWarehouse(warehouse);
    }

    // Precomputed once, over every file in the run, BEFORE any document
    // exists — so a document's remark can carry its FINAL P1-P4 tier
    // immediately after creation instead of needing a slower second pass
    // once every document is known. Per explicit user request (2026-08-26):
    // the remark's tier must match the LINE notification's tier for the same
    // document, so this reuses the identical assignPriorities() ranking
    // (see line-notify-service.ts), just keyed by file path (a document's
    // real number isn't known yet at this point) instead of documentNumber.
    // One known, accepted gap: this ranks over ALL files about to be
    // attempted, while the LINE message ranks only the ones that actually
    // succeeded — a file that later fails to import very slightly shifts the
    // tier boundary for the survivors. Failures are rare and already
    // reported separately, so this trade-off was chosen over doubling every
    // document's popup-edit round trip just to close that edge case.
    const priorityByFilePath = new Map<string, Priority>();
    if (salesBySku) {
      const ranked = assignPriorities(
        files.map((f) => ({
          documentNumber: f.filePath,
          zone: f.zone,
          score: Math.max(0, ...f.rows.map((r) => salesBySku!.get(r.sku) ?? 0)),
        })),
      );
      for (const [filePath, priority] of ranked) priorityByFilePath.set(filePath, priority);
    }

    // Import in priority order — every P1 file first, then all of P2, then
    // P3, then P4 — per explicit user request (2026-08-26): "ตอนสร้างใบย้าย
    // ให้เริ่มเปิดจาก P1 ให้ครบก่อน ค่อยเปิดใบย้าย P2 ครบ ต่อ P3 ครบ P4" (when
    // creating transfer documents, finish all of P1 before starting P2, and
    // so on). `Array.prototype.sort` is stable, so within the same priority
    // tier files keep their original (source-position) order. A file with no
    // computed priority (salesBySku unavailable) sorts as P4 — lowest
    // urgency, not an error.
    const orderedFiles = [...files].sort(
      (a, b) => (priorityByFilePath.get(a.filePath) ?? 4) - (priorityByFilePath.get(b.filePath) ?? 4),
    );

    // Defense in depth against re-submitting an already-successful file: if
    // withBigSellerPage's outer retry ever re-enters this callback for any
    // reason, skip files `results` already has a success recorded for.
    const alreadySucceeded = new Set(results.filter((r) => r.ok).map((r) => r.filePath));

    // Tracks EVERY document number already seen this run — comparing only
    // against the immediately-previous document wasn't enough (BigSeller's
    // newest-first list sort flickered between two recently-created
    // documents at least twice, confirmed live 2026-08-25), which overwrote
    // a document's remark with a later document's and left that later one
    // with none.
    const seenDocNumbers = new Set<string>();
    const initialDocNumber = await movingGoodsPage.getMostRecentDocumentNumber().catch(() => null);
    if (initialDocNumber) seenDocNumbers.add(initialDocNumber);

    for (const file of orderedFiles) {
      if (alreadySucceeded.has(file.filePath)) {
        console.log(`[SKIP] ${file.filePath}: already succeeded in a previous attempt this run`);
        continue;
      }

      let result: { ok: boolean; message: string };
      try {
        result = await movingGoodsPage.importZoneFile(file.filePath);
      } catch (error) {
        // MUST NOT rethrow: withBigSellerPage retries this whole callback
        // from the top on any thrown error — confirmed live (2026-08-25) —
        // which re-ran the loop from file #1 and created a real duplicate
        // transfer document (REUJR3201414, caught and deleted by hand).
        result = { ok: false, message: (error as Error).message };
      }

      results.push({ filePath: file.filePath, ok: result.ok, message: result.message, rows: file.rows });
      console.log(`${result.ok ? '[OK]' : '[FAIL]'} ${file.filePath}: ${result.message}`);
      if (!result.ok) {
        await logError(
          { job: 'import-moves', url: page.url(), step: 'importZoneFile', errorMessage: `${file.filePath}: ${result.message}`, runId },
          sheetsClient,
        );
      } else {
        let docNumber: string | null = null;
        try {
          docNumber = await movingGoodsPage.waitForUnseenDocument(seenDocNumbers);
          if (docNumber) seenDocNumbers.add(docNumber);
          else await logger.error(`waitForUnseenDocument timed out for ${file.filePath} — document was created but its number is unknown`);
        } catch (error) {
          await logger.error(`waitForUnseenDocument failed for ${file.filePath}: ${(error as Error).message}`);
        }

        const score = salesBySku ? Math.max(0, ...file.rows.map((r) => salesBySku!.get(r.sku) ?? 0)) : 0;
        documents.push({ documentNumber: docNumber ?? 'ไม่ทราบเลขที่', zone: file.zone, score });

        if (salesBySku && docNumber) {
          try {
            const priority = priorityByFilePath.get(file.filePath) ?? 4;
            const remark = buildPriorityRemark(priority, score);
            await movingGoodsPage.setRemarkOnMostRecentDocument(remark);
          } catch (error) {
            await logger.error(`setRemarkOnMostRecentDocument failed for ${file.filePath}: ${(error as Error).message}`);
          }
        }
      }

      // Per user report (2026-08-25): on a slow/laggy connection, moving to
      // the next file's import immediately gave BigSeller's backend too
      // little time to finish saving/indexing the just-created document —
      // seen as waitForUnseenDocument timeouts. A short pause between files
      // gives a slow connection room to catch up.
      await humanDelay(800, 1500);
    }
  });

  return { results, documents };
}

/** Marks every planned row IMPORTED or FAILED depending on whether its zone file succeeded. */
export async function updateTransferPlanStatus(sheetsClient: SheetsClient, results: ImportFileResult[]): Promise<void> {
  const updates = results.flatMap(({ ok, rows }) =>
    rows.map((row) => ({ ...row, status: (ok ? 'IMPORTED' : 'FAILED') as TransferStatus })),
  );
  if (updates.length === 0) return;
  await sheetsClient.upsertRows(
    SHEET_TRANSFER_PLAN,
    updates.map((r) => ({ ...r, key: `${r.runId}::${r.sku}::${r.sourcePosition}::${r.targetPosition}` })),
    { headers: [...TRANSFER_PLAN_HEADERS], keyColumns: ['runId', 'sku', 'sourcePosition', 'targetPosition'] },
  );
}
