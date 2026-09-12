import type { Page } from '@playwright/test';
import { parseThaiDateTime, isSameLocalDay } from '../utils/thai-date.js';
import { logger } from '../utils/logger.js';

export const CANCELLED_ORDERS_URL = process.env.BIGSELLER_CANCELLED_ORDERS_URL ?? 'https://www.bigseller.com/web/order/index.htm?status=In%20Cancel';

const ORDER_LIST_API = 'https://www.bigseller.com/api/v1/order/new/pageList.json';

/**
 * `inCancelBeforeStatus` values confirmed SAFE (order was never packed) by
 * scanning 700 real cancelled orders live 2026-09-01 — see
 * FEATURE-dashboard-home-page.md section 1c. This is an ALLOWLIST
 * deliberately: anything not in this set (including values never seen
 * before, or `null`) is treated as risky and gets flagged, since a missed
 * real risk is far worse than an extra manual check.
 */
const SAFE_BEFORE_CANCEL_STATUSES = new Set(['New', 'new', 'unpaid']);

interface OrderApiRow {
  packageNo: string;
  cancelTimeStr: string | null;
  inCancelBeforeStatus: string | null;
  multilingualCancelBeforeStatus: string | null;
  cancelReason: string | null;
}

interface OrderListApiResponse {
  data?: {
    page?: {
      totalSize: number;
      rows: OrderApiRow[];
    };
  };
  code?: number;
  msg?: string;
}

export interface CancelledAtRiskOrderRow {
  orderNo: string;
  cancelTime: string;
  statusBeforeCancel: string;
  statusBeforeCancelLabel: string;
  cancelReason: string;
  sourceUrl: string;
}

/**
 * Reads today's cancelled orders that were already packed/shipped before
 * cancellation, via BigSeller's own internal JSON API (same approach as
 * transfer-page.ts, confirmed with the user 2026-09-01 — see
 * FEATURE-dashboard-home-page.md section 1c).
 *
 * Deliberately does NOT rely on the UI's own "วันนี้" quick-filter or on
 * finding the right `timeType` code for "cancel time" (attempted live and
 * gave up after repeated requests started tripping BigSeller's rate limiter
 * and killing the session) — instead fetches a `days`-wide safety window by
 * order time (`timeType=1`, which the UI's default view already uses) and
 * filters precisely client-side against each row's own `cancelTimeStr`,
 * which is unambiguous regardless of what BigSeller's own quick-filter
 * buttons are internally keyed on.
 *
 * KNOWN GAP (accepted, not silently assumed — flag to the user if this ever
 * matters in practice): the `days` window is applied to ORDER/paid time, not
 * cancel time, because that is the only sort/filter basis confirmed live. An
 * order paid more than `safetyWindowDays` ago that stayed unshipped that
 * long and got cancelled today would be missed. Default is 7 days, which
 * should comfortably cover the "packed and cancelled" scenario this feature
 * targets (orders reach "To Ship"/"Shipped" within a few days of payment in
 * normal operation) — a multi-week-old still-unshipped order being cancelled
 * would itself be a separate, unusual case worth its own investigation.
 */
export class BigSellerCancelledOrdersPage {
  constructor(private readonly page: Page) {}

  async goto(): Promise<void> {
    await this.page.goto(CANCELLED_ORDERS_URL, { waitUntil: 'domcontentloaded' });
    await this.page.waitForTimeout(1500);
  }

  /** Despite the return type's name, this returns EVERY order cancelled today, not just at-risk ones — callers filter with `isAtRiskStatus()` themselves (see cancelled-after-pack-service.ts). Reused as-is by order-funnel-service.ts for a plain "cancelled today" count. */
  async fetchTodayCancelledRows(safetyWindowDays = 7): Promise<CancelledAtRiskOrderRow[]> {
    const pageSize = 100;
    let pageNo = 1;
    const todayRows: OrderApiRow[] = [];

    for (;;) {
      const res = await this.page.request.post(ORDER_LIST_API, {
        headers: { 'content-type': 'application/json' },
        data: {
          status: 'canceled',
          timeType: 1,
          days: safetyWindowDays,
          searchType: 'commoditySku',
          inquireType: 2,
          desc: 1,
          orderBy: 'paidTime',
          pageNo,
          pageSize,
        },
      });
      if (!res.ok()) {
        throw new Error(`order/new/pageList.json returned HTTP ${res.status()}`);
      }
      const body = (await res.json()) as OrderListApiResponse;
      if (!body.data?.page) {
        throw new Error(`order/new/pageList.json returned code=${body.code}: ${body.msg}`);
      }

      const { rows, totalSize } = body.data.page;
      const stillToday = rows.filter((r) => {
        const cancelTime = parseThaiDateTime(r.cancelTimeStr);
        return cancelTime !== null && isSameLocalDay(cancelTime);
      });
      todayRows.push(...stillToday);

      await logger.info(
        `fetchTodayCancelledRows: page ${pageNo}, ${rows.length} row(s) fetched, ${stillToday.length} within today, total scanned so far ${pageNo * pageSize}/${totalSize}`,
      );

      // Rows are sorted newest-first (desc/paidTime) but that's ORDER time,
      // not cancel time, so a page with zero "still today" rows does NOT
      // reliably mean every later page is also outside today — confirmed
      // live 2026-09-01: page 7 of a real scan had 0 today-cancelled rows,
      // page 8 had 2 more. There is no safe early-exit short of scanning the
      // entire `safetyWindowDays` window every time.
      const coveredWholeWindow = rows.length < pageSize || pageNo * pageSize >= totalSize;
      if (coveredWholeWindow) break;
      pageNo += 1;
      await this.page.waitForTimeout(1000); // avoid the rate-limit seen during live investigation
    }

    return todayRows.map((r) => ({
      orderNo: r.packageNo,
      cancelTime: parseThaiDateTime(r.cancelTimeStr)!.toISOString(),
      statusBeforeCancel: r.inCancelBeforeStatus ?? '',
      statusBeforeCancelLabel: r.multilingualCancelBeforeStatus ?? '',
      cancelReason: r.cancelReason ?? '',
      sourceUrl: CANCELLED_ORDERS_URL,
    }));
  }
}

export function isAtRiskStatus(statusBeforeCancel: string): boolean {
  return !SAFE_BEFORE_CANCEL_STATUSES.has(statusBeforeCancel);
}

/**
 * Total order count for today, ANY status — confirmed live 2026-09-02:
 * omitting the `status` field entirely (unlike the cancelled-only queries
 * above, which always pass `status: 'canceled'`) returns every order
 * regardless of status, filtered by order time via the same
 * `timeType: 1, days: 0` = "today" pattern used throughout this file. One
 * request, `pageSize: 1` — only `totalSize` is needed, not the rows.
 */
export async function fetchTotalOrdersToday(page: Page): Promise<number> {
  const res = await page.request.post(ORDER_LIST_API, {
    headers: { 'content-type': 'application/json' },
    data: {
      timeType: 1,
      days: 0,
      searchType: 'commoditySku',
      inquireType: 2,
      desc: 1,
      orderBy: 'paidTime',
      pageNo: 1,
      pageSize: 1,
    },
  });
  if (!res.ok()) {
    throw new Error(`order/new/pageList.json returned HTTP ${res.status()}`);
  }
  const body = (await res.json()) as OrderListApiResponse;
  if (!body.data?.page) {
    throw new Error(`order/new/pageList.json returned code=${body.code}: ${body.msg}`);
  }
  return body.data.page.totalSize;
}
