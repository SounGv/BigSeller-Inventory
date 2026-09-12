import type { Page } from '@playwright/test';
import { BigSellerWaveWorkBoardPage, WAVE_WORK_BOARD_URL } from '../bigseller/wave-work-board-page.js';
import { ensureSessionValid } from '../bigseller/auth.js';
import { SupabaseDbClient } from '../db/supabase-db-client.js';
import { logger } from '../utils/logger.js';

const TABLE = 'operator_wave_ranking';
const DAILY_TABLE = 'operator_wave_ranking_daily';

/** `YYYY-MM-DD` in local time (machine confirmed Asia/Bangkok) — same helper duplicated in sales-summary-service.ts / best-sellers-service.ts / order-funnel-service.ts. */
function formatLocalDate(d: Date): string {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Syncs today's live pick/pack (and sort/shipped/scan-inspection) ranking
 * from BigSeller's Wave work board — feeds the "อันดับผลงานวันนี้" ranking
 * cards in FEATURE-dashboard-home-page.md, now covering both ฝ่ายออนไลน์
 * and ฝ่ายออฟไลน์ (previously only ฝ่ายออนไลน์-หยิบ had a real data path).
 *
 * Writes to TWO tables: `operator_wave_ranking` (replaceAll — a live "as of
 * right now" snapshot, no history, powers the live ranking cards, same
 * reasoning as warehouse-backlog-service.ts) AND `operator_wave_ranking_daily`
 * (upsert keyed on date+rank_type+employee — added 2026-09-02 so the
 * dashboard can show a %-vs-yesterday badge on employee performance, which
 * the snapshot-only table can never support since it's wiped every run).
 * Today's row in the daily table keeps growing as the day progresses (same
 * "keeps correcting itself" upsert pattern as sales_summary); once the date
 * rolls over, that row is frozen and a new one starts — no separate "close
 * out the day" step needed. Department for each `employee` is resolved by
 * joining against `staff` at query time (dashboard side), not stored here —
 * keeps both tables a pure mirror of BigSeller's numbers.
 */
export async function syncOperatorWaveRanking(page: Page): Promise<void> {
  const start = Date.now();
  await ensureSessionValid(page, WAVE_WORK_BOARD_URL);

  const boardPage = new BigSellerWaveWorkBoardPage(page);
  const rows = await boardPage.fetchTodayRanking();

  await logger.info(`syncOperatorWaveRanking: ${rows.length} ranking row(s) across all rank types`);

  const supabase = SupabaseDbClient.create();
  const syncedAt = new Date().toISOString();

  await supabase.replaceAll(
    TABLE,
    rows.map((r) => ({
      rank_type: r.rankType,
      employee: r.employee,
      package_num: r.packageNum,
      sku_num: r.skuNum,
      source_url: r.sourceUrl,
      synced_at: syncedAt,
    })),
  );

  const today = formatLocalDate(new Date());
  await supabase.upsertRows(
    DAILY_TABLE,
    rows.map((r) => ({
      date: today,
      rank_type: r.rankType,
      employee: r.employee,
      package_num: r.packageNum,
      sku_num: r.skuNum,
      source_url: r.sourceUrl,
      synced_at: syncedAt,
    })),
    ['date', 'rank_type', 'employee'],
  );

  await logger.info(`syncOperatorWaveRanking: done in ${Date.now() - start}ms`);
}
