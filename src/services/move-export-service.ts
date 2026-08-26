import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import * as XLSX from 'xlsx';
import { SheetsClient } from '../sheets/sheets-client.js';
import type { TransferPlanRow } from '../types.js';
import { readRowsForRunId } from './run-data.js';
import { logger } from '../utils/logger.js';

const SHEET_TRANSFER_PLAN = process.env.SHEET_TRANSFER_PLAN ?? 'DB_TRANSFER_PLAN';
const WAREHOUSE_NAME = process.env.INVENTORY_WAREHOUSE_NAME ?? 'STOCK_5';
const OUTPUT_DIR = process.env.MOVE_OUTPUT_DIR ?? 'output/move-import';

// Confirmed byte-for-byte from the real template BigSeller itself serves
// (`/static/importTemplate/movingPlan/zone/นำเข้าเพื่อสร้างใบย้ายสินค้า_th.xlsx`,
// downloaded and inspected 2026-08-25). Hardcoded rather than reading the
// template file at runtime so this never risks touching — or breaking if
// someone moves/renames — the original template on disk.
export const MOVE_IMPORT_HEADERS = [
  '*เลข SKU (จำเป็นต้องกรอก)',
  '*ตำแหน่งที่ย้ายออก (จำเป็นต้องกรอก)',
  '*จำนวนสินค้าที่ย้ายออก (จำเป็นต้องกรอก)',
  '*ตำแหน่งที่ย้ายเข้า (จำเป็นต้องกรอก)',
  '*จำนวนสินค้าที่ย้ายเข้า (จำเป็นต้องกรอก)',
] as const;

/** BigSeller's own stated limit on the "ย้ายสินค้า" import modal, confirmed live 2026-08-25. */
export const MAX_ROWS_PER_IMPORT_FILE = 5000;

export interface ZoneFile {
  /** The grouping key for this file — the exact source position, e.g. "PC-006" (see groupBySourcePosition below). Kept as `zone` for minimal disruption to callers (DocumentInfo, LINE notification) that already expect this field name. */
  zone: string;
  sourceArea: string;
  filePath: string;
  rowCount: number;
  rows: TransferPlanRow[];
}

/**
 * Named physical storage buildings/floors, keyed by source-position prefix
 * (the part before the first hyphen, e.g. "PC" in "PC-019" — same
 * prefix-matching convention as CARTON_ZONE_PREFIXES in
 * transfer-plan-service.ts). Per explicit user request (2026-08-26):
 * "สร้างใบย้ายตำแหน่งจัดเก็บ แยก ย้ายออกตำแหน่ง คนละใบ เพื่อไม่ให้พนักงานเดินวน
 * เสียเวลา" (split transfer documents by storage source position — separate
 * documents — so staff don't have to walk back and forth) — every prefix NOT
 * listed here (3B, 01U, 02U, F01, F02, F03, CY, CB, CW, CR, and anything not
 * yet seen) falls into SOURCE_AREA_FALLBACK, confirmed with the user to be
 * treated as one combined group rather than one document per prefix.
 */
const SOURCE_AREA_BY_PREFIX: Record<string, string> = {
  PC: 'ชั้นลอย',
  ZZZ: 'ชั้นล่างสินค้าเข้าใหม่',
  PE: 'ตึกใหม่',
  PH: 'ชั้นล่าง',
  PA: 'ชั้น5',
};
const SOURCE_AREA_FALLBACK = 'ตำแหน่งหยิบ สินค้าขาย';

export function sourceAreaOf(sourcePosition: string): string {
  const prefix = sourcePosition.split('-')[0];
  return SOURCE_AREA_BY_PREFIX[prefix] ?? SOURCE_AREA_FALLBACK;
}

/**
 * Groups plan rows by the EXACT source position — per explicit follow-up
 * request (2026-08-26), replacing the earlier (targetZone, sourceArea)
 * grouping: "ถ้าตำแหน่งเก็บเดียวกันให้สร้างรวมใบเดียวกันได้ ... เพราะเวลาพนักงาน
 * เดินจัดของจะได้เดินไปทำทีละตำแหน่งจัดเก็บ" (if it's the same storage
 * position, combine into one document — staff walk to each storage position
 * one at a time and handle everything for it in one visit). Confirmed live:
 * two real documents both sourcing from PC-006 but going to different target
 * zones (3B-28, 3B-27) should have been ONE document, not two — grouping by
 * target zone was making staff revisit the same storage bin across separate
 * trips. A document can now legitimately carry more than one target
 * position/zone; that's fine, since staff are already standing at the one
 * source position gathering everything before heading out to drop it off.
 */
export function groupBySourcePosition(plan: TransferPlanRow[]): Map<string, { sourcePosition: string; sourceArea: string; rows: TransferPlanRow[] }> {
  const groups = new Map<string, { sourcePosition: string; sourceArea: string; rows: TransferPlanRow[] }>();
  for (const row of plan) {
    const group = groups.get(row.sourcePosition) ?? {
      sourcePosition: row.sourcePosition,
      sourceArea: sourceAreaOf(row.sourcePosition),
      rows: [],
    };
    group.rows.push(row);
    groups.set(row.sourcePosition, group);
  }
  return groups;
}

/** Splits `rows` into chunks no larger than {@link MAX_ROWS_PER_IMPORT_FILE}. */
export function chunkRows<T>(rows: T[], maxSize: number = MAX_ROWS_PER_IMPORT_FILE): T[][] {
  if (rows.length <= maxSize) return [rows];
  const chunks: T[][] = [];
  for (let i = 0; i < rows.length; i += maxSize) chunks.push(rows.slice(i, i + maxSize));
  return chunks;
}

function toImportRow(row: TransferPlanRow): (string | number)[] {
  return [row.sku, row.sourcePosition, row.sourceQty, row.targetPosition, row.targetQty];
}

function writeXlsx(filePath: string, rows: TransferPlanRow[]): void {
  const sheet = XLSX.utils.aoa_to_sheet([[...MOVE_IMPORT_HEADERS], ...rows.map(toImportRow)]);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, 'SKU');
  XLSX.writeFile(workbook, filePath);
}

/** Phase 6+7: reads the PLANNED rows for `runId`, groups by zone, chunks at the 5,000-row platform limit, and writes one .xlsx per (zone, chunk). */
export async function exportMoveFiles(sheetsClient: SheetsClient, runId: string, dateStamp: string): Promise<ZoneFile[]> {
  const rawRows = await readRowsForRunId(sheetsClient, SHEET_TRANSFER_PLAN, runId);
  const plan: TransferPlanRow[] = rawRows
    .filter((r) => r.status === 'PLANNED')
    .map((r) => ({
      runId: r.runId,
      sku: r.sku,
      sourcePosition: r.sourcePosition,
      targetPosition: r.targetPosition,
      sourceQty: Number(r.sourceQty),
      targetQty: Number(r.targetQty),
      targetZone: r.targetZone,
      stockAtPosition: Number(r.stockAtPosition),
      totalWarehouseStock: Number(r.totalWarehouseStock),
      replenishableQty: Number(r.replenishableQty),
      moveQty: Number(r.moveQty),
      status: 'PLANNED',
      createdAt: r.createdAt,
    }));

  if (plan.length === 0) {
    throw new Error(`No PLANNED rows in ${SHEET_TRANSFER_PLAN} for runId ${runId} — run "npm run plan:moves" first.`);
  }

  const outDir = path.join(OUTPUT_DIR, runId);
  await mkdir(outDir, { recursive: true });

  const files: ZoneFile[] = [];
  for (const { sourcePosition, sourceArea, rows: groupRows } of groupBySourcePosition(plan).values()) {
    const chunks = chunkRows(groupRows);
    chunks.forEach((chunk, i) => {
      const partSuffix = chunks.length > 1 ? `_part${i + 1}` : '';
      const safePosition = sourcePosition.replace(/[\\/:*?"<>|]/g, '_');
      const safeArea = sourceArea.replace(/[\\/:*?"<>|]/g, '_');
      const filePath = path.join(outDir, `MOVE_${WAREHOUSE_NAME}_${safeArea}_${safePosition}_${dateStamp}${partSuffix}.xlsx`);
      writeXlsx(filePath, chunk);
      files.push({ zone: sourcePosition, sourceArea, filePath, rowCount: chunk.length, rows: chunk });
    });
  }

  await logger.info(`Exported ${files.length} zone file(s) for runId ${runId} to ${outDir}`);
  return files;
}
