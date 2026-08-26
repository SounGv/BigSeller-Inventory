import type { ReplenishResult, ReplenishTransaction } from '../types.js';
import { SheetsClient } from '../sheets/sheets-client.js';

const SHEET_REPLENISH_TRANSACTION = process.env.SHEET_REPLENISH_TRANSACTION ?? 'DB_REPLENISH_TRANSACTION';

/**
 * เติมได้อีก = MAX(0, เติมสต็อกสูงสุด - สต็อกที่มีอยู่ของตำแหน่ง)
 *
 * สถานะ:
 * - currentStock < minStock            -> "ต้องเติมทันที"
 * - currentStock >= minStock && can > 0 -> "ยังเติมได้"
 * - currentStock >= maxStock            -> "เต็มแล้ว"
 */
export function calculateReplenishment(currentStock: number, minStock: number, maxStock: number): ReplenishResult {
  const canReplenish = Math.max(0, maxStock - currentStock);

  if (currentStock < minStock) {
    return { canReplenish, status: 'ต้องเติมทันที' };
  }
  if (currentStock >= maxStock) {
    return { canReplenish, status: 'เต็มแล้ว' };
  }
  return { canReplenish, status: 'ยังเติมได้' };
}

/** Records a physical replenishment done by staff. This is the ONLY writable stock-change path for employees. */
export async function recordReplenishTransaction(sheetsClient: SheetsClient, transaction: ReplenishTransaction): Promise<void> {
  await sheetsClient.appendRows(SHEET_REPLENISH_TRANSACTION, [
    [
      transaction.sku,
      transaction.warehouse,
      transaction.area,
      transaction.position,
      transaction.positionType,
      transaction.quantityAdded,
      transaction.employeeName,
      transaction.recordedAt,
    ],
  ]);
}
