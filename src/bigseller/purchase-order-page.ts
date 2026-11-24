import type { Page } from '@playwright/test';

export const PURCHASE_ORDER_URL = 'https://www.bigseller.com/web/all/purchase/manage/index.htm';

/**
 * One row from `/api/v1/purchase/manage/pageList.json` — BigSeller's own internal
 * API for the "การจัดการใบสั่งซื้อ" page, captured live 2026-11-11 (same technique as
 * transfer-page.ts: read the real request the page's own frontend fires, confirmed
 * far more reliable than this page's DOM, which hides its row-action links behind a
 * hover state and wraps status badges in `.ant-badge` spans that fail Playwright's
 * visibility checks).
 *
 * `state` meaning, confirmed empirically against the account's real data
 * (616 rows: 468 state=3, 147 state=4, 1 state=5) cross-checked against
 * `/api/v1/purchase/manage/stateCount.json` (`finished: 468`, `canceled: 147`,
 * `onTheWay`/`delivery`: 1, `partialReceipt`: 0, `draft`: 0): 3 = เสร็จเรียบร้อย
 * (finished), 4 = ยกเลิก (cancelled). Every OTHER state (the UI's กล่องร่าง/รอจัดส่ง/
 * ระหว่างทาง/รับสินค้าบางส่วน) is "still open" — purchase-order-pending-service.ts
 * filters on `state !== 3 && state !== 4` rather than hardcoding the other codes,
 * since 3 of those 4 buckets had zero members to confirm a code for on the day this
 * was built; excluding only the two states that ARE confirmed is the robust way to
 * mean "not yet resolved" without guessing at empty buckets.
 *
 * `subTotal`/`paymentAmount` are BOTH "0.00"/0 for a real, large (64,836-unit)
 * still-open order (confirmed live) — BigSeller does not compute an order's cost
 * value until it is received, so neither field is usable as "value of goods on
 * order". purchase-order-pending-service.ts estimates value itself instead, from
 * the destination warehouse's own average unit cost (DB_STOCK_VALUE_BIGSELLER).
 */
export interface PurchaseOrderRow {
  poNumber: string;
  supplier: string;
  warehouse: string;
  state: number;
  skuCount: number;
  orderedQty: number;
  receivedQty: number;
  estimatedArrival: string;
  createdAt: string;
}

interface PageListApiRow {
  commonNo: string;
  supplier: string | null;
  warehouse: string;
  state: number;
  skuQty: number;
  purchaseQty: number;
  receivedQty: number;
  estimatedArrivalTime: string;
  createTimeStr: string;
}

interface PageListApiResponse {
  code: number;
  msg: string;
  data: { rows: PageListApiRow[] } | null;
}

const PAGE_SIZE = 300;

export class BigSellerPurchaseOrderPage {
  constructor(private readonly page: Page) {}

  async goto(): Promise<void> {
    await this.page.goto(PURCHASE_ORDER_URL, { waitUntil: 'networkidle' });
  }

  /** Every purchase order in the account, every state, via the internal API — all-or-nothing (throws on any page's non-zero `code`, rather than silently returning a partial list). */
  async fetchAllRows(): Promise<PurchaseOrderRow[]> {
    const rows: PurchaseOrderRow[] = [];
    for (let pageNo = 1; ; pageNo++) {
      const url =
        `https://www.bigseller.com/api/v1/purchase/manage/pageList.json?pageNo=${pageNo}&pageSize=${PAGE_SIZE}` +
        '&searchType=commonNo&inquireType=2&searchContent=&warehouseId=&beginDate=&days=&endDate=' +
        '&purchaseType=&selectAll=true&timeType=0&desc=&orderBy=createTime&state=';
      const res = await this.page.request.get(url);
      const json = (await res.json()) as PageListApiResponse;
      if (json.code !== 0) {
        throw new Error(`purchase/manage/pageList.json returned code ${json.code}: ${json.msg}`);
      }

      const pageRows = json.data?.rows ?? [];
      for (const r of pageRows) {
        rows.push({
          poNumber: r.commonNo,
          supplier: r.supplier ?? '',
          warehouse: r.warehouse,
          state: r.state,
          skuCount: r.skuQty,
          orderedQty: r.purchaseQty,
          receivedQty: r.receivedQty,
          estimatedArrival: r.estimatedArrivalTime,
          createdAt: r.createTimeStr,
        });
      }

      if (pageRows.length < PAGE_SIZE) break; // last page
    }
    return rows;
  }
}
