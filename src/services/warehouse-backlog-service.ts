import type { Page } from '@playwright/test';
import { BigSellerWarehouseBacklogPage } from '../bigseller/warehouse-backlog-page.js';
import { ensureSessionValid } from '../bigseller/auth.js';
import { SupabaseDbClient } from '../db/supabase-db-client.js';
import { logger } from '../utils/logger.js';

const TABLE = 'warehouse_backlog';

/**
 * Syncs FEATURE-dashboard-home-page.md section 1d: current non-terminal
 * (not yet เสร็จเรียบร้อย/ยกเลิก) slips across "เติมสต็อกชั้นวาง" and
 * "ย้ายสินค้า" — routine daily ฝ่ายคลัง work, not an exception queue.
 *
 * Uses replaceAll (not upsert) — unlike 1b/1c this table has no manual
 * checklist overlay to preserve; every column comes straight from
 * BigSeller, and only fetches non-terminal rows in the first place, so a
 * slip that reaches "เสร็จเรียบร้อย" between syncs should simply disappear
 * from this table on the next run, exactly like DB_PENDING_ORDER_DEMAND /
 * DB_OFFLINE_LOCK.
 */
export async function syncWarehouseBacklog(page: Page, warehouseName: string): Promise<void> {
  const start = Date.now();
  await ensureSessionValid(page, 'https://www.bigseller.com/web/inventory/movingGoods/index.htm');

  const backlogPage = new BigSellerWarehouseBacklogPage(page);
  const movingRows = await backlogPage.fetchMovingBacklog(warehouseName);
  const replenishRows = await backlogPage.fetchReplenishmentBacklog(warehouseName);
  const allRows = [...movingRows, ...replenishRows];

  await logger.info(
    `syncWarehouseBacklog: ${movingRows.length} moving + ${replenishRows.length} replenishment = ${allRows.length} backlog row(s)`,
  );

  const supabase = SupabaseDbClient.create();
  await supabase.replaceAll(
    TABLE,
    allRows.map((r) => ({
      slip_no: r.slipNo,
      warehouse: r.warehouse,
      doc_type: r.docType,
      sku_count: r.skuCount,
      status_code: r.statusCode,
      creator: r.creator,
      operator: r.operator,
      bigseller_created_at: r.createdAt,
      bigseller_updated_at: r.updatedAt,
      source_url: r.sourceUrl,
      synced_at: new Date().toISOString(),
    })),
  );

  await logger.info(`syncWarehouseBacklog: done in ${Date.now() - start}ms`);
}
