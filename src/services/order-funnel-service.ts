import type { Page } from '@playwright/test';
import { BigSellerCancelledOrdersPage, CANCELLED_ORDERS_URL, fetchTotalOrdersToday } from '../bigseller/cancelled-orders-page.js';
import { ensureSessionValid } from '../bigseller/auth.js';
import { SupabaseDbClient } from '../db/supabase-db-client.js';
import { logger } from '../utils/logger.js';

const TABLE = 'order_funnel_summary';

function formatLocalDate(d: Date): string {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * "ยอดสั่งซื้อจริง เทียบ ยกเลิก" per user request 2026-09-02: today's total
 * order count vs today's cancelled order count (ALL cancellations, not just
 * the at-risk-after-pack subset 1c tracks). One row per day, upserted so a
 * same-day re-run just refreshes the count as more orders/cancellations
 * accumulate through the day — `is_provisional: true` while it's still
 * today, matching the sales_summary/best_sellers convention.
 */
export async function syncOrderFunnel(page: Page): Promise<void> {
  const start = Date.now();
  await ensureSessionValid(page, CANCELLED_ORDERS_URL);

  const ordersPage = new BigSellerCancelledOrdersPage(page);
  await ordersPage.goto();

  const totalToday = await fetchTotalOrdersToday(page);
  const cancelledToday = await ordersPage.fetchTodayCancelledRows();

  const cancelRatePct = totalToday > 0 ? (cancelledToday.length / totalToday) * 100 : 0;
  const date = formatLocalDate(new Date());

  await logger.info(`syncOrderFunnel: ${date} — ${totalToday} order(s) created, ${cancelledToday.length} cancelled (${cancelRatePct.toFixed(1)}%)`);

  const supabase = SupabaseDbClient.create();
  await supabase.upsertRows(
    TABLE,
    [
      {
        date,
        orders_created_count: totalToday,
        orders_cancelled_count: cancelledToday.length,
        cancel_rate_pct: Math.round(cancelRatePct * 10) / 10,
        is_provisional: true,
        source_url: CANCELLED_ORDERS_URL,
        synced_at: new Date().toISOString(),
      },
    ],
    ['date'],
  );

  await logger.info(`syncOrderFunnel: done in ${Date.now() - start}ms`);
}
