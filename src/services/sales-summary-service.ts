import type { Page } from '@playwright/test';
import { BigSellerSalesItemsReportPage, SALES_ITEMS_URL, type ChannelGroup, type SalesSummaryRow } from '../bigseller/sales-items-report-page.js';
import { ensureSessionValid } from '../bigseller/auth.js';
import { SupabaseDbClient } from '../db/supabase-db-client.js';
import { logger } from '../utils/logger.js';

const TABLE = 'sales_summary';
const CHANNELS: ChannelGroup[] = ['online', 'offline', 'all_excl_lockstock'];
const ROLLING_WINDOW_DAYS = 3;

/** `YYYY-MM-DD` in local time (machine confirmed Asia/Bangkok) — NOT `.toISOString().slice(0,10)`, which would read the UTC calendar date and can be a day off near midnight. */
function formatLocalDate(d: Date): string {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Leaves out today's rows when BigSeller has no figures for today yet.
 *
 * BigSeller's stats report does not count the current day: checked 2026-11-18 at 11:00 with the same API call, every figure of
 * today was 0 for all shops while the day before had 2,522 orders. Writing that 0 would show "no sales" on the dashboard when the
 * truth is "no data yet". Only the rows of `today` are held back, and only when all of them are zero; an older day with zero
 * sales stays, because that is a real figure.
 */
export function dropTodayWithoutData<T extends Pick<SalesSummaryRow, 'date' | 'salesCount' | 'salesVolumeCount' | 'effectiveSalesAmount' | 'efficientsOrders'>>(
  rows: T[],
  today: string,
): T[] {
  const todays = rows.filter((r) => r.date === today);
  const noFigures = todays.length > 0 && todays.every((r) => !r.salesCount && !r.salesVolumeCount && !r.effectiveSalesAmount && !r.efficientsOrders);
  return noFigures ? rows.filter((r) => r.date !== today) : rows;
}

/**
 * Syncs FEATURE-sales-online-offline-report.md: per-day sales totals split
 * online/offline/all, one row per (date, channelGroup).
 *
 * Rolling window, not single-day — re-fetches the last `ROLLING_WINDOW_DAYS`
 * days every run and upserts over whatever was there before. This is a
 * deliberate simplification of the spec's original plan (which wanted an
 * empirical test first: sync "yesterday" twice hours apart, see if the
 * number ever moves, THEN decide a schedule): re-verifying a short window
 * every run makes that test unnecessary — if BigSeller's number for a day
 * ever changes after the fact (e.g. delayed payment settlement), the next
 * run's upsert just silently corrects it instead of an ops person having to
 * notice a stale figure. Today's row is flagged `isProvisional: true`
 * (still moving intraday); everything older is `false` (treated as
 * settled) — this is what the dashboard should use to decide whether to
 * show a "ชั่วคราว" badge.
 */
export async function syncSalesSummary(page: Page): Promise<void> {
  const start = Date.now();
  await ensureSessionValid(page, SALES_ITEMS_URL);

  await page.goto(SALES_ITEMS_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);

  const reportPage = new BigSellerSalesItemsReportPage(page);
  const today = new Date();
  const summaries: SalesSummaryRow[] = [];

  for (let offset = 0; offset < ROLLING_WINDOW_DAYS; offset++) {
    const date = new Date(today);
    date.setDate(date.getDate() - offset);
    const dateStr = formatLocalDate(date);

    for (const channel of CHANNELS) {
      summaries.push(await reportPage.fetchDailySummary(channel, dateStr));
      await page.waitForTimeout(700); // pace requests — see rate-limit lessons from cancelled-orders-page.ts
    }
  }

  const todayStr = formatLocalDate(today);
  const usable = dropTodayWithoutData(summaries, todayStr);
  if (usable.length < summaries.length) {
    await logger.info(`syncSalesSummary: BigSeller has no figures for ${todayStr} yet — today's ${summaries.length - usable.length} row(s) left out`);
  }
  const rows = usable.map((s) => toDbRow(s, s.date === todayStr));

  const supabase = SupabaseDbClient.create();
  await supabase.upsertRows(TABLE, rows, ['date', 'channel_group']);

  await logger.info(`syncSalesSummary: upserted ${rows.length} row(s) (up to ${ROLLING_WINDOW_DAYS} days × ${CHANNELS.length} channels), done in ${Date.now() - start}ms`);
}

function toDbRow(s: Awaited<ReturnType<BigSellerSalesItemsReportPage['fetchDailySummary']>>, isProvisional: boolean) {
  return {
    date: s.date,
    channel_group: s.channelGroup,
    sales_count: s.salesCount,
    effective_sales_amount: s.effectiveSalesAmount,
    sales_volume_count: s.salesVolumeCount,
    effective_sales_quantity: s.effectiveSalesQuantity,
    sku_count: s.skuCount,
    refunds_count: s.refundsCount,
    refunds_volume_count: s.refundsVolumeCount,
    efficients_orders: s.efficientsOrders,
    is_provisional: isProvisional,
    source_url: s.sourceUrl,
    synced_at: new Date().toISOString(),
  };
}
