import type { Page } from '@playwright/test';
import { BigSellerCancelledOrdersPage, CANCELLED_ORDERS_URL, isAtRiskStatus } from '../bigseller/cancelled-orders-page.js';
import { ensureSessionValid } from '../bigseller/auth.js';
import { SupabaseDbClient } from '../db/supabase-db-client.js';
import { logger } from '../utils/logger.js';

const TABLE = 'cancelled_after_pack';

/**
 * Syncs FEATURE-dashboard-home-page.md section 1c: today's cancelled orders
 * that were already packed/shipped before cancellation — the 3-step
 * checklist (shipped_out, received_back, shelved) staff work through.
 *
 * Supabase-only, upsert (not replaceAll) — same reasoning as
 * transfer-in-transit-service.ts: all three checklist columns are a manual
 * overlay set by staff through the GV Ops Console UI (via
 * mark_cancelled_after_pack_step()), and upsert only touches the columns
 * this sync actually passes in, so re-running it never blanks out staff
 * input. Unlike 1b, none of the three steps here are auto-detectable from
 * BigSeller — all three go through the checklist.
 */
export async function syncCancelledAfterPack(page: Page): Promise<void> {
  const start = Date.now();
  await ensureSessionValid(page, CANCELLED_ORDERS_URL);

  const ordersPage = new BigSellerCancelledOrdersPage(page);
  await ordersPage.goto();
  const todayRows = await ordersPage.fetchTodayCancelledRows();

  const atRiskRows = todayRows.filter((r) => isAtRiskStatus(r.statusBeforeCancel));

  await logger.info(
    `syncCancelledAfterPack: ${todayRows.length} order(s) cancelled today, ${atRiskRows.length} at-risk (already packed/shipped)`,
  );

  if (atRiskRows.length === 0) {
    await logger.info(`syncCancelledAfterPack: nothing to write, done in ${Date.now() - start}ms`);
    return;
  }

  const supabase = SupabaseDbClient.create();
  await supabase.upsertRows(
    TABLE,
    atRiskRows.map((r) => ({
      order_no: r.orderNo,
      cancel_time: r.cancelTime,
      status_before_cancel: r.statusBeforeCancel,
      status_before_cancel_label: r.statusBeforeCancelLabel,
      cancel_reason: r.cancelReason,
      source_url: r.sourceUrl,
      updated_at: new Date().toISOString(),
    })),
    ['order_no'],
  );

  await logger.info(`syncCancelledAfterPack: upserted ${atRiskRows.length} row(s), done in ${Date.now() - start}ms`);
}
