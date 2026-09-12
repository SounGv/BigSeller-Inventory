import type { Page } from '@playwright/test';
import { BigSellerSalesItemsReportPage, SALES_ITEMS_URL } from '../bigseller/sales-items-report-page.js';
import { ensureSessionValid } from '../bigseller/auth.js';
import { SupabaseDbClient } from '../db/supabase-db-client.js';
import { logger } from '../utils/logger.js';

const TABLE = 'best_sellers';
const LIMIT = 10;

function formatLocalDate(d: Date): string {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * "รุ่นที่ขายดี" per user request 2026-09-02 — top 10 SKUs by effective
 * (post-cancellation) sales value, `all_excl_lockstock` channel (overall,
 * not split online/offline — keeps this simple; per-channel best-sellers
 * would need 2x the calls for a metric that wasn't explicitly asked to be
 * split). Syncs today + yesterday, same is_provisional convention as
 * sales_summary — today is near-certain to come back empty (BigSeller's
 * analytics doesn't populate "today" until some point later, confirmed
 * building sales_summary), fetched anyway so this self-corrects once it
 * does.
 */
export async function syncBestSellers(page: Page): Promise<void> {
  const start = Date.now();
  await ensureSessionValid(page, SALES_ITEMS_URL);
  await page.goto(SALES_ITEMS_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);

  const reportPage = new BigSellerSalesItemsReportPage(page);
  const today = formatLocalDate(new Date());
  const yesterday = formatLocalDate(new Date(Date.now() - 86400000));

  const rows: ReturnType<typeof toDbRow>[] = [];
  for (const [date, isProvisional] of [[today, true], [yesterday, false]] as const) {
    const bestSellers = await reportPage.fetchBestSellers('all_excl_lockstock', date, LIMIT);
    bestSellers.forEach((b, i) => rows.push(toDbRow(date, b, i + 1, isProvisional)));
    await logger.info(`syncBestSellers: ${date} — ${bestSellers.length} row(s)`);
  }

  const supabase = SupabaseDbClient.create();
  await supabase.upsertRows(TABLE, rows, ['date', 'sku']);

  await logger.info(`syncBestSellers: upserted ${rows.length} row(s), done in ${Date.now() - start}ms`);
}

function toDbRow(date: string, b: Awaited<ReturnType<BigSellerSalesItemsReportPage['fetchBestSellers']>>[number], rank: number, isProvisional: boolean) {
  return {
    date,
    sku: b.sku,
    product_title: b.productTitle,
    sales_amount: b.salesAmount,
    sales_volume: b.salesVolume,
    effective_sales_amount: b.effectiveSalesAmount,
    effective_sales_volume: b.effectiveSalesVolume,
    cancels_amount: b.cancelsAmount,
    cancels_orders: b.cancelsOrders,
    rank,
    is_provisional: isProvisional,
    source_url: SALES_ITEMS_URL,
    synced_at: new Date().toISOString(),
  };
}
