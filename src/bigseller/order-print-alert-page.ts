import type { Page } from '@playwright/test';

const ORDER_LIST_API = 'https://www.bigseller.com/api/v1/order/new/pageList.json';

/**
 * Statuses scanned for a re-printed shipping label. Confirmed live
 * 2026-11-12: `status=toship` never had any rows with `printNum` set
 * (nothing in that bucket has been printed yet, by definition), and
 * `status=""` (every status at once) came back with `printNum` always
 * null for every row — some different, non-per-order aggregation the API
 * does for that query shape — so each status below is queried on its own
 * rather than once with no status filter.
 */
const SCAN_STATUSES = ['processing', 'shipped', 'completed'] as const;

export interface OrderPrintAlertRow {
  packageNo: string;
  orderNo: string;
  store: string;
  platform: string;
  buyer: string;
  status: string;
  warehouse: string;
  printNum: number;
  printTimes: string;
  orderCreatedAt: string;
  trackingNo: string;
}

interface OrderApiRow {
  packageNo: string;
  platformOrderId: string | null;
  shopName: string | null;
  platform: string | null;
  buyerUsername: string | null;
  viewStatus: string | null;
  shipmentWarehouse: string | null;
  printNum: number | null;
  printTimeList: string[] | null;
  orderCreateTimeStr: string | null;
  trackingNo: string | null;
}

interface OrderListApiResponse {
  code?: number;
  msg?: string;
  data?: { page?: { rows: OrderApiRow[]; totalSize: number } };
}

/**
 * Reads every order whose shipping label has been printed more than once
 * (`printNum > 1`), across `SCAN_STATUSES`, via BigSeller's own internal
 * JSON API — same approach as `cancelled-orders-page.ts`. A re-printed
 * label is a real operational risk flag: it can mean two labels went out
 * for one parcel, or staff printed again after losing/damaging the first
 * one, which a plain order list never surfaces on its own.
 */
export class BigSellerOrderPrintAlertPage {
  constructor(private readonly page: Page) {}

  async goto(): Promise<void> {
    await this.page.goto('https://www.bigseller.com/web/order/index.htm?status=shipped', { waitUntil: 'domcontentloaded' });
    await this.page.waitForTimeout(6000);
  }

  async fetchReprintedRows(windowDays: number): Promise<OrderPrintAlertRow[]> {
    const pageSize = 200;
    const seen = new Map<string, OrderPrintAlertRow>();

    for (const status of SCAN_STATUSES) {
      let pageNo = 1;
      for (;;) {
        const res = await this.page.request.post(ORDER_LIST_API, {
          headers: { 'content-type': 'application/json' },
          data: {
            status,
            timeType: 1,
            days: windowDays,
            searchType: 'commoditySku',
            inquireType: 2,
            desc: 1,
            orderBy: 'createTime',
            pageNo,
            pageSize,
          },
        });
        if (!res.ok()) {
          throw new Error(`order/new/pageList.json (status=${status}) returned HTTP ${res.status()}`);
        }
        const body = (await res.json()) as OrderListApiResponse;
        if (!body.data?.page) {
          throw new Error(`order/new/pageList.json (status=${status}) returned code=${body.code}: ${body.msg}`);
        }

        const { rows, totalSize } = body.data.page;
        for (const r of rows) {
          if (typeof r.printNum !== 'number' || r.printNum <= 1) continue;
          // A package can appear under more than one status bucket as it moves
          // through the pipeline (e.g. still "shipped" and already "completed");
          // keep one row per packageNo, newest scan wins.
          seen.set(r.packageNo, {
            packageNo: r.packageNo,
            orderNo: r.platformOrderId ?? '',
            store: r.shopName ?? '',
            platform: r.platform ?? '',
            buyer: r.buyerUsername ?? '',
            status: r.viewStatus ?? status,
            warehouse: r.shipmentWarehouse ?? '',
            printNum: r.printNum,
            printTimes: (r.printTimeList ?? []).join(', '),
            orderCreatedAt: r.orderCreateTimeStr ?? '',
            trackingNo: r.trackingNo ?? '',
          });
        }

        const coveredWholeWindow = rows.length < pageSize || pageNo * pageSize >= totalSize;
        if (coveredWholeWindow) break;
        pageNo += 1;
        await this.page.waitForTimeout(1000); // avoid the rate-limit seen during live investigation of this same API
      }
    }

    return [...seen.values()];
  }
}
