import type { Page } from '@playwright/test';
import { BigSellerSkuSalesReportPage } from '../bigseller/sku-sales-report-page.js';
import { ensureSessionValid } from '../bigseller/auth.js';
import { SheetsClient } from '../sheets/sheets-client.js';
import type { SkuSalesRow } from '../types.js';
import type { Priority } from './line-notify-service.js';
import { logger } from '../utils/logger.js';

const SHEET_SKU_SALES = process.env.SHEET_SKU_SALES ?? 'DB_SKU_SALES';
const SKU_SALES_URL = process.env.BIGSELLER_SKU_SALES_URL ?? 'https://www.bigseller.com/web/statis/warehouse/saleout.htm';
const SALES_WINDOW_LABEL = process.env.SKU_SALES_WINDOW_LABEL ?? '15 วัน';

const SKU_SALES_HEADERS = ['sku', 'avgDailySales', 'runId', 'sourceUpdatedAt'] as const;

/**
 * Phase 9 helper (per user request, 2026-08-25): pulls "รายงาน SKU Merchant"
 * so each transfer document's remark can flag which of its SKUs sell well.
 * Kept as its own sync (own sheet, own runId-stamped rows) rather than folded
 * into syncBigSeller — it answers a different question (sales velocity, not
 * stock position) and isn't required for the transfer-plan math itself, only
 * for the remark text.
 */
export async function syncSkuSales(page: Page, sheetsClient: SheetsClient, runId: string, warehouse: string): Promise<SkuSalesRow[]> {
  await ensureSessionValid(page, SKU_SALES_URL);

  const salesPage = new BigSellerSkuSalesReportPage(page);
  await salesPage.ensureView();
  await salesPage.selectWarehouse(warehouse);
  await salesPage.selectTimeWindow(SALES_WINDOW_LABEL);
  const rows = await salesPage.exportAllRows();

  const sourceUpdatedAt = new Date().toISOString();
  const records = rows.map((r) => ({ ...r, runId, sourceUpdatedAt, key: r.sku }));
  await sheetsClient.upsertRows(SHEET_SKU_SALES, records, { headers: [...SKU_SALES_HEADERS], keyColumns: ['sku'] });
  await logger.info(`syncSkuSales: ${rows.length} rows for runId ${runId}`);
  return rows;
}

const PRIORITY_REMARK_LABELS: Record<Exclude<Priority, 4>, string> = {
  1: '[P1 ทำก่อน] ขายดีมาก',
  2: '[P2 ทำถัดไป] ขายดี',
  3: '[P3 ทำตามคิว] มียอดขาย',
};

/**
 * Builds one remark line for a transfer document from its priority tier and
 * best-seller score (same `score` — the highest avgDailySales among the
 * document's SKUs — already computed for the LINE notification's per-run
 * ranking). Per explicit user request (2026-08-26), replacing the earlier
 * per-SKU list format: one short line per document, tagged with the SAME
 * P1-P4 tier the LINE notification will show for it (see
 * assignPriorities/PRIORITY_LABELS in line-notify-service.ts — `priority`
 * here MUST come from that same ranking, computed once over every file in
 * the run before the import loop starts, so a document's remark and its
 * LINE listing never disagree).
 *
 * The 15-day total is derived as avgDailySales * the configured window's day
 * count — the sales report only ever gave us a daily average, never a raw
 * period total, so this is the only number available to reconstruct it.
 */
export function buildPriorityRemark(priority: Priority, avgDailySales: number): string {
  if (priority === 4) {
    return `[P4 ทำหลัง] ไม่มียอดขาย ${SALES_WINDOW_LABEL}`;
  }
  const windowDays = Number(SALES_WINDOW_LABEL.match(/\d+/)?.[0] ?? 15);
  const windowNoSpace = SALES_WINDOW_LABEL.replace(/\s+/g, '');
  const total = Math.round(avgDailySales * windowDays);
  const avgText = Number.isInteger(avgDailySales) ? String(avgDailySales) : avgDailySales.toFixed(1);
  return `${PRIORITY_REMARK_LABELS[priority]} | ยอดขาย${windowNoSpace} ${total} ชิ้น | เฉลี่ย ${avgText}/วัน`;
}
