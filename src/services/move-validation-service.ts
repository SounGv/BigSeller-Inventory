import type { ZoneFile } from './move-export-service.js';
import { MOVE_IMPORT_HEADERS } from './move-export-service.js';
import { readTabularFile } from '../bigseller/extract-table.js';

export interface MoveValidationResult {
  ok: boolean;
  problems: string[];
}

/** Phase 8: every row of every exported zone file must pass before any of them may be uploaded to BigSeller. */
export async function validateMoveFiles(files: ZoneFile[]): Promise<MoveValidationResult> {
  const problems: string[] = [];

  for (const file of files) {
    for (const [index, row] of file.rows.entries()) {
      const label = `${file.filePath} แถวที่ ${index + 2}`; // +2: header row + 1-index

      if (!row.sku) problems.push(`${label}: SKU ว่าง`);
      if (!row.sourcePosition) problems.push(`${label}: ตำแหน่งต้นทางว่าง`);
      if (!row.targetPosition) problems.push(`${label}: ตำแหน่งปลายทางว่าง`);
      if (row.sourceQty <= 0) problems.push(`${label}: จำนวนย้ายออก (${row.sourceQty}) ต้องมากกว่า 0`);
      if (row.targetQty !== row.sourceQty) problems.push(`${label}: จำนวนย้ายเข้า (${row.targetQty}) ไม่เท่ากับจำนวนย้ายออก (${row.sourceQty})`);
      if (row.sourcePosition && row.sourcePosition === row.targetPosition) problems.push(`${label}: ตำแหน่งต้นทางและปลายทางเป็นตำแหน่งเดียวกัน (${row.sourcePosition})`);
      if (row.moveQty > row.replenishableQty) problems.push(`${label}: จำนวนย้าย (${row.moveQty}) เกินจำนวนที่เติมได้อีก (${row.replenishableQty})`);
    }

    const fileCheck = await validateWrittenFile(file);
    if (fileCheck) problems.push(fileCheck);
  }

  return { ok: problems.length === 0, problems };
}

/** Re-reads the file actually written to disk to catch writer bugs the in-memory check above can't see (wrong headers, row count mismatch, stray sample data). */
async function validateWrittenFile(file: ZoneFile): Promise<string | null> {
  const rows = await readTabularFile(file.filePath);
  const actualHeaders = rows.length > 0 ? Object.keys(rows[0]) : [];
  const expectedHeaders = [...MOVE_IMPORT_HEADERS];
  if (JSON.stringify(actualHeaders) !== JSON.stringify(expectedHeaders)) {
    return `${file.filePath}: หัวตารางไม่ตรงกับ template (พบ ${JSON.stringify(actualHeaders)})`;
  }
  if (rows.length !== file.rowCount) {
    return `${file.filePath}: จำนวนแถวในไฟล์ (${rows.length}) ไม่ตรงกับที่คาดไว้ (${file.rowCount})`;
  }
  const sampleLike = rows.find((r) => Object.values(r).some((v) => String(v).includes('ตัวอย่าง') || String(v).includes('จำเป็นต้องกรอก')));
  if (sampleLike) {
    return `${file.filePath}: พบข้อมูลที่ดูเหมือนข้อความตัวอย่าง/คำแนะนำหลุดเข้ามาในแถวข้อมูล`;
  }
  return null;
}
