import type { Page } from '@playwright/test';
import { thaiEpochToUtcIso } from '../utils/thai-date.js';
import { logger } from '../utils/logger.js';

export const TRANSFER_URL = process.env.BIGSELLER_TRANSFER_URL ?? 'https://www.bigseller.com/web/inventory/transfer/index.htm';

const TRANSFER_LIST_API = 'https://www.bigseller.com/api/v1/inventory/transfer/pageList.json';

/**
 * `status` values for the transfer list tabs — confirmed live 2026-09-01 by
 * capturing the real POST bodies fired when the page loads (status=0, the
 * default tab) and when clicking "ระหว่างทาง" (status=1). The other three
 * are inferred from tab display order (แผนการโอนสินค้า, ระหว่างทาง,
 * รับสินค้าบางส่วน, เสร็จเรียบร้อย, ยกเลิก) — NOT individually confirmed by
 * capturing their requests. Only IN_TRANSIT is used by this project so far;
 * verify the others live before relying on them.
 */
const TRANSFER_STATUS = {
  PLAN: 0,
  IN_TRANSIT: 1,
  PARTIALLY_RECEIVED: 2,
  COMPLETED: 3,
  CANCELLED: 4,
} as const;

/** One row of `pageList.json`'s `data.rows` — only the fields this project actually uses; the real payload has more (image, shippingFee, costCurrency, ...). */
interface TransferApiRow {
  commonNo: string;
  warehouseOutName: string;
  warehouseInName: string;
  createTime: number;
  estimatedArrivalTime: string;
  skuQty: number;
  transferQty: number;
  note: string;
  showState: string;
}

interface TransferApiResponse {
  code: number;
  msg: string;
  data: {
    pageNo: number;
    pageSize: number;
    totalSize: number;
    rows: TransferApiRow[];
  };
}

export interface TransferInTransitRow {
  transferNo: string;
  sourceWarehouse: string;
  destWarehouse: string;
  /** ISO timestamp, from the API's epoch-millis `createTime` — no Thai date-string parsing needed. */
  bigsellerCreatedAt: string;
  estimatedArrival: string;
  skuCount: number;
  qtyTotal: number;
  note: string;
  sourceUrl: string;
}

/**
 * Reads the "ระหว่างทาง" (in-transit) transfer list via BigSeller's own
 * internal JSON API instead of DOM scraping — confirmed live 2026-09-01 by
 * capturing the real request BigSeller's own frontend fires when that tab is
 * clicked (`POST pageList.json`, form-encoded body below). This is an
 * undocumented internal endpoint (no public API contract), so it can change
 * without notice same as any DOM structure could — but unlike DOM scraping
 * it returns typed fields (epoch-millis timestamps, explicit state codes)
 * instead of Thai date strings embedded in free-form innerText, which is
 * significantly less fragile to parse. See FEATURE-dashboard-home-page.md
 * section 1b for the decision to use this approach.
 *
 * `page.request` reuses the same authenticated browser context or a
 * withBigSellerPage() call already navigated — no separate auth/cookie
 * handling here.
 */
export class BigSellerTransferPage {
  constructor(private readonly page: Page) {}

  async goto(): Promise<void> {
    await this.page.goto(TRANSFER_URL, { waitUntil: 'domcontentloaded' });
    await this.page.waitForTimeout(1500);
  }

  async fetchInTransitRows(): Promise<TransferInTransitRow[]> {
    const rows: TransferApiRow[] = [];
    const pageSize = 100;
    let pageNo = 1;

    for (;;) {
      const res = await this.page.request.post(TRANSFER_LIST_API, {
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        form: {
          pageNo: String(pageNo),
          pageSize: String(pageSize),
          status: String(TRANSFER_STATUS.IN_TRANSIT),
          searchType: 'skuName',
          searchContent: '',
          inquireType: '0',
          warehouseOutId: '',
          warehouseInId: '',
          beginDate: '',
          endDate: '',
          days: '30',
          timeType: '0',
          desc: '1',
          orderBy: 'createTime',
        },
      });
      if (!res.ok()) {
        throw new Error(`transfer pageList.json returned HTTP ${res.status()}`);
      }
      const body = (await res.json()) as TransferApiResponse;
      if (body.code !== 0) {
        throw new Error(`transfer pageList.json returned code=${body.code}: ${body.msg}`);
      }

      rows.push(...body.data.rows);
      await logger.info(`fetchInTransitRows: page ${pageNo}, ${body.data.rows.length} row(s), total so far ${rows.length}/${body.data.totalSize}`);

      if (rows.length >= body.data.totalSize || body.data.rows.length === 0) break;
      pageNo += 1;
    }

    return rows.map((r) => ({
      transferNo: r.commonNo,
      sourceWarehouse: r.warehouseOutName,
      destWarehouse: r.warehouseInName,
      bigsellerCreatedAt: thaiEpochToUtcIso(r.createTime),
      estimatedArrival: r.estimatedArrivalTime,
      skuCount: r.skuQty,
      qtyTotal: r.transferQty,
      note: r.note,
      sourceUrl: TRANSFER_URL,
    }));
  }
}
