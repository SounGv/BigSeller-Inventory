import type { Page } from '@playwright/test';
import { dismissOrderPageOverlays } from './order-page-overlays.js';
import {
  ORDER_COLUMN,
  collectRawOrderRows,
  goToNextOrderPage,
  selectFilterPill,
  setMaxPageSize,
  type RawOrderRow,
} from './new-orders-dom.js';
import { logger } from '../utils/logger.js';

/**
 * Page Object for `order/index.htm?status=processing` ("กำลังจัดส่ง"), the
 * orders staff are packing. Built for the carton-label page (GV Catalog,
 * tools/order-labels): store, BigSeller bill number, PO, recipient/branch,
 * ship date and one line per SKU with the quantity ordered.
 *
 * The row markup is the same `table.list_items` as `status=new`, so the shared
 * helpers in new-orders-dom.ts do the paging and scrolling. Read-only: this
 * never clicks anything but a filter pill.
 */
export const PROCESSING_ORDERS_URL =
  process.env.BIGSELLER_PROCESSING_ORDERS_URL ?? 'https://www.bigseller.com/web/order/index.htm?status=processing';

export interface ProcessingOrderLine {
  sku: string;
  qty: number;
}

export interface ProcessingOrder {
  /** BigSeller's own bill number, the "# BSUJR3R10375" in the row header. */
  bill: string;
  /** The store pill the order was read under, e.g. "GV ส่งเอง". */
  store: string;
  /** "หมายเลขคำสั่งซื้อ" column: the number the customer's PO is built from. */
  orderNo: string;
  /** Recipient text as BigSeller prints it (company and branch). */
  recipient: string;
  /** "ส่งของวันที่ 27-10-2026" in dd-mm-yyyy, or '' when the shipping cell has none. */
  shipDate: string;
  /** The "ส่งคลัง…" destination text from the shipping cell, or ''. */
  shipTo: string;
  lines: ProcessingOrderLine[];
}

const clean = (text: string): string => text.replace(/คัดลอก/g, ' ').replace(/\s+/g, ' ').trim();

/** One entry per SKU line of the "รายละเอียดสินค้า" cell: "35501 คัดลอก -- THB 208.65 × 3 สต็อกพร้อมขาย 6,686". */
export function parseProcessingProducts(text: string): ProcessingOrderLine[] {
  const matches = [...text.matchAll(/([A-Za-z0-9_\-.]+)\s*คัดลอก\s+.*?THB\s*[\d,.]*\s*[×x]?\s*(\d+)\s*(?:\(.*?\))?\s*สต็อกพร้อมขาย/g)];
  return matches
    .map((m) => ({ sku: m[1], qty: Number(m[2]) }))
    .filter((l) => Number.isFinite(l.qty) && l.qty > 0 && /\d/.test(l.sku));
}

/** "ส่งของวันที่ 27-10-2026 เวลา 11.00 … / ส่งคลังบางนา" -> { shipDate: '27-10-2026', shipTo: 'ส่งคลังบางนา' }. */
export function parseShippingCell(text: string): { shipDate: string; shipTo: string } {
  const date = text.match(/(\d{1,2}-\d{1,2}-\d{4})/);
  const to = text.match(/(ส่งคลัง[^\s/]*(?:\s[^\s/]+)?)/);
  return { shipDate: date ? date[1] : '', shipTo: to ? to[1].replace(/\s*(เพิ่มข้อมูลขนส่ง.*)$/, '').trim() : '' };
}

export function rowToOrder(row: RawOrderRow, store: string): ProcessingOrder | null {
  const bill = row.rowText.match(/#\s*([A-Za-z0-9]+)/)?.[1] ?? '';
  const orderNo = clean(row.cells[ORDER_COLUMN.orderNo] ?? '').split(' ')[0] ?? '';
  const lines = parseProcessingProducts(row.cells[ORDER_COLUMN.product] ?? '');
  if (!bill && !orderNo) return null;
  if (lines.length === 0) return null;
  const { shipDate, shipTo } = parseShippingCell(clean(row.cells[ORDER_COLUMN.shipping] ?? ''));
  return { bill, store, orderNo, recipient: clean(row.cells[ORDER_COLUMN.recipient] ?? ''), shipDate, shipTo, lines };
}

export class BigSellerProcessingOrdersPage {
  constructor(private readonly page: Page) {}

  async goto(): Promise<void> {
    await this.page.goto(PROCESSING_ORDERS_URL, { waitUntil: 'domcontentloaded' });
    await this.page.waitForTimeout(8000); // the filter counts and the list load after the shell
    await dismissOrderPageOverlays(this.page);
  }

  async selectStore(label: string): Promise<void> {
    await selectFilterPill(this.page, 'ร้านค้า', label);
    await this.page.waitForTimeout(2500);
  }

  /** Every order under the active store filter, across all pages (the "พิมพ์ได้" tab is the page's default). */
  async readOrders(store: string): Promise<ProcessingOrder[]> {
    const rows: RawOrderRow[] = [];
    await setMaxPageSize(this.page).catch(() => undefined); // an empty list has no pagination bar
    for (let pageNo = 1; pageNo <= 20; pageNo++) {
      const batch = await collectRawOrderRows(this.page);
      if (batch.length === 0) break;
      rows.push(...batch);
      if (!(await goToNextOrderPage(this.page))) break;
    }
    const seen = new Set<string>();
    const orders: ProcessingOrder[] = [];
    for (const row of rows) {
      if (seen.has(row.orderId)) continue;
      seen.add(row.orderId);
      const order = rowToOrder(row, store);
      if (order) orders.push(order);
      else await logger.warn(`processing-orders: skipped a row with no bill/SKU lines (orderId=${row.orderId})`);
    }
    return orders;
  }
}
