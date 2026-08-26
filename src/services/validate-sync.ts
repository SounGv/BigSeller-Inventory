import { SheetsClient } from '../sheets/sheets-client.js';
import { inventoryRowKey, skuInventoryRowKey } from '../types.js';
import { readRowsForRunId } from './run-data.js';

const SHEET_LOCATION_CURRENT = process.env.SHEET_LOCATION_CURRENT ?? 'DB_LOCATION_CURRENT';
const SHEET_SKU_INVENTORY = process.env.SHEET_SKU_INVENTORY ?? 'DB_SKU_INVENTORY';

export interface SyncValidationResult {
  ok: boolean;
  runId: string;
  locationRowCount: number;
  skuRowCount: number;
  problems: string[];
}

/**
 * Phase 2: re-reads DB_LOCATION_CURRENT and DB_SKU_INVENTORY straight from
 * Sheets (this runs as its own process, separate from the sync step) and
 * checks every condition the workflow spec requires before any transfer plan
 * may be built from this data.
 */
export async function validateSync(sheetsClient: SheetsClient, runId: string): Promise<SyncValidationResult> {
  const problems: string[] = [];

  const locationRows = await readRowsForRunId(sheetsClient, SHEET_LOCATION_CURRENT, runId);
  const skuRows = await readRowsForRunId(sheetsClient, SHEET_SKU_INVENTORY, runId);

  if (locationRows.length === 0) problems.push('ไม่มีข้อมูลตำแหน่ง (DB_LOCATION_CURRENT) สำหรับ runId นี้');
  if (skuRows.length === 0) problems.push('ไม่มีข้อมูลสต็อกรวม (DB_SKU_INVENTORY) สำหรับ runId นี้');

  const missingSku = locationRows.filter((r) => !r.sku).length;
  if (missingSku > 0) problems.push(`พบแถวตำแหน่งที่ไม่มี SKU จำนวน ${missingSku} แถว`);

  const locationKeys = locationRows.map((r) => inventoryRowKey(r as never));
  const duplicateLocationKeys = locationKeys.length - new Set(locationKeys).size;
  if (duplicateLocationKeys > 0) problems.push(`พบข้อมูลตำแหน่งซ้ำ ${duplicateLocationKeys} แถว (sku+warehouse+area+position+positionType ซ้ำกัน)`);

  const skuKeys = skuRows.map((r) => skuInventoryRowKey(r as never));
  const duplicateSkuKeys = skuKeys.length - new Set(skuKeys).size;
  if (duplicateSkuKeys > 0) problems.push(`พบข้อมูลสต็อกรวมซ้ำ ${duplicateSkuKeys} แถว (sku+warehouse ซ้ำกัน)`);

  return {
    ok: problems.length === 0,
    runId,
    locationRowCount: locationRows.length,
    skuRowCount: skuRows.length,
    problems,
  };
}
