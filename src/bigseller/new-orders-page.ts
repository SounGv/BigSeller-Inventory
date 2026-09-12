import type { Page } from '@playwright/test';
import { dismissOrderPageOverlays } from './order-page-overlays.js';
import {
  collectRawOrderRows,
  goToNextOrderPage,
  NEW_ORDERS_URL,
  ORDER_COLUMN,
  selectFilterPill,
  setMaxPageSize,
} from './new-orders-dom.js';
import type { NewOrderLineRow } from '../types.js';
import { logger } from '../utils/logger.js';

export { NEW_ORDERS_URL };

/**
 * Page Object for `order/index.htm?status=new` ("คำสั่งซื้อใหม่").
 *
 * Confirmed live (2026-08-31) via a raw DOM dump: each order is its own
 * separate `<table class="list_items"><tbody><tr data-orderid="..." ...>`
 * — 47 of them counted while filtered to the "LockStock" store, exactly
 * matching that filter's own "(47)" badge. This is a materially different
 * structure from the single-`<tbody>` tables used elsewhere in this project
 * (e.g. `inventory-page.ts`); do not assume `tbody tr` iteration works here.
 * The header row lives in a SEPARATE `<table class="list_header">`
 * immediately before the first `list_items` table — and, confirmed live
 * against a raw HTML dump of one real row, that header table's leading
 * empty/checkbox column has NO corresponding `<td>` in each list_items
 * table's own row (an off-by-one bug here on the first attempt at this file
 * silently shifted every field one column to the right and produced zero
 * usable rows — verify against a fresh raw-HTML dump before ever changing
 * these indices again). Real column order, left to right (9 `<td>`s per
 * list_items row, class names confirmed live):
 *   [0] .merge_el.dt_el   — รายละเอียดสินค้า (product lines)
 *   [1] .vp_el            — มูลค่าคำสั่งซื้อ&การชำระเงิน
 *   [2] .rr_el            — ผู้รับ&ภูมิภาค (buyer/recipient label)
 *   [3] .odn_el           — หมายเลขคำสั่งซื้อ&ผู้ซื้อ (order number)
 *   [4] เวลา, [5] การตั้งค่าการจัดส่ง&หมายเลขแทร็คกิ้ง, [6] สถานะแพลตฟอร์ม,
 *   [7] สถานะ, [8] ดำเนินการ (not individually confirmed by class name, only
 *   by position/content in the header dump).
 *
 * A single order's "รายละเอียดสินค้า" cell repeats one segment per SKU line
 * for multi-line-item orders, each confirmed (live, 2026-08-31, reading 47
 * real LockStock orders) to read as:
 *   "{sku} คัดลอก -- THB {price} {qty} สต็อกพร้อมขาย {stockAtOrderTime}"
 * String-parsed via regex below rather than per-element locators — the
 * segments are not wrapped in any distinguishing class in the raw dump this
 * was built from. If BigSeller changes this markup, `parseProductCell`
 * below is the one place to fix.
 *
 * Store filtering (the "ร้านค้า" row of `span.ship_item` pills, confirmed
 * live to include one pill spelled exactly "LockStock", no surrounding
 * whitespace/case variants) is SINGLE-SELECT — clicking one pill replaces
 * whichever was active, there is no confirmed way to select "every store
 * except LockStock" directly. `order-demand-service.ts` therefore scrapes
 * TWICE (once filtered to LockStock, once unfiltered) and classifies by
 * order-number membership rather than by reading a per-row store-name cell.
 */
export class BigSellerNewOrdersPage {
  constructor(private readonly page: Page) {}

  async goto(): Promise<void> {
    await this.page.goto(NEW_ORDERS_URL, { waitUntil: 'domcontentloaded' });
    await this.page.waitForTimeout(2500);
    await dismissOrderPageOverlays(this.page);
  }

  /**
   * Selects `label` in the "ร้านค้า" (store) filter row specifically. Pass
   * "ทั้งหมด" to go back to every store.
   *
   * MUST be scoped to the row whose first cell is literally "ร้านค้า" —
   * confirmed live (2026-08-31) that `span.ship_item` with text "ทั้งหมด"
   * matches SEVERAL unrelated filter rows too (แพลตฟอร์ม, โลจิสติกส์, ...
   * each has its own "ทั้งหมด" pill), so an unscoped locator can silently
   * click the wrong row's "ทั้งหมด" and time out waiting for a state change
   * that was never going to happen on the store row. "LockStock" itself
   * needs no such scoping (no other filter row has that label), but every
   * call goes through this same scoped path for consistency.
   */
  async selectStoreFilter(label: string): Promise<void> {
    await selectFilterPill(this.page, 'ร้านค้า', label);
  }

  /**
   * Scrapes every order visible under whatever store filter is currently
   * active, across every page, stamping every returned row with `store`.
   * Caller is responsible for calling {@link selectStoreFilter} first.
   */
  async scrapeCurrentFilterRows(store: string): Promise<NewOrderLineRow[]> {
    await setMaxPageSize(this.page);
    const sourceUrl = this.page.url();
    const rows: NewOrderLineRow[] = [];

    for (let page = 1; page <= 20; page++) {
      const pageRows = await collectRawOrderRows(this.page);

      if (pageRows.length === 0) {
        if (page === 1) {
          await logger.warn(`No table.list_items rows found on ${sourceUrl} (store="${store}") — page may be empty or markup changed`);
        }
        break;
      }

      const orderTime = new Date().toISOString();
      for (const { orderId, cells } of pageRows) {
        const productCell = cells[ORDER_COLUMN.product] ?? '';
        const buyerCell = cells[ORDER_COLUMN.recipient] ?? '';
        const orderNoCell = cells[ORDER_COLUMN.orderNo] ?? '';

        const orderNo = orderNoCell.replace(/คัดลอก/g, '').trim();
        if (!orderId && !orderNo) continue; // defensive — a malformed/placeholder row with neither id nor number is not real order data

        const lines = parseProductCell(productCell);
        for (const line of lines) {
          rows.push({
            sku: line.sku,
            qty: line.qty,
            store,
            platform: '',
            orderId,
            orderNo,
            buyerOrLabel: buyerCell.replace(/คัดลอก/g, '').trim(),
            orderTime,
            sourceUrl,
          });
        }
      }

      const advanced = await goToNextOrderPage(this.page);
      if (!advanced) break;
    }

    return rows;
  }
}

/**
 * Parses "รายละเอียดสินค้า" cell text into one entry per SKU line, one
 * segment per line item repeated back-to-back with no separator other than
 * the pattern itself. Confirmed live 2026-08-31 against TWO real formats
 * that both occur on this page:
 *  - LockStock orders (no real variant/discount — 47 read live): e.g.
 *    "75701C คัดลอก -- THB 0 120 สต็อกพร้อมขาย 162"
 *  - Real paid orders (variant text + optional discount parenthetical
 *    between SKU and "สต็อกพร้อมขาย" — read live from several real Shopee/
 *    TikTok orders): e.g.
 *    "70523 คัดลอก สีเงิน 1M - 70523 THB 339 1 สต็อกพร้อมขาย 471" (no discount) or
 *    "35501 คัดลอก สีดำ - 1 เมตร THB 204 1 ( ส่วนลดทั้งหมดจากแพลตฟอร์ม ： THB 20
 *     ส่วนลดทั้งหมดจากร้านค้า ： THB 55 ) สต็อกพร้อมขาย 4,686" (with discount)
 * An EARLIER version of this regex hardcoded the literal "--" LockStock
 * always shows in place of variant text, which matched zero real orders —
 * confirmed live the hard way (a full sync run returned 116 LockStock lines
 * but only 4 pending-demand lines against ~830 real new orders). The
 * `.*?` here skips whatever variant text/placeholder sits between "คัดลอก"
 * and the first "THB", and the optional `(?:\(.*?\))?` skips a discount
 * parenthetical between qty and "สต็อกพร้อมขาย" when present.
 */
/** Every real SKU seen live across both LockStock and real paid orders (75701C, FAN-KEY-MK895-WHT-YLS, 25851, 20201, 40362, 10106, 35501, 70523, ...) contains at least one digit — used as a sanity filter below. */
const SKU_HAS_DIGIT = /\d/;

function parseProductCell(text: string): { sku: string; qty: number }[] {
  const matches = [...text.matchAll(/([A-Za-z0-9_\-.]+)\s*คัดลอก\s+.*?THB\s*[\d,.]*\s*(\d+)\s*(?:\(.*?\))?\s*สต็อกพร้อมขาย/g)];
  return matches
    .map((m) => ({ sku: m[1], qty: Number(m[2]) }))
    .filter((l) => Number.isFinite(l.qty) && l.qty > 0)
    .filter((l) => {
      // Confirmed live (2026-09-01): a real sync run produced one bogus line
      // with sku="Rest" (no corresponding real product) — root cause not
      // pinned down (order queue had already moved on by the time this was
      // investigated), but every genuine SKU observed on this page always
      // contains a digit. Reject anything that doesn't, as a defensive
      // filter, rather than leaving a known-bad row silently in the data.
      if (!SKU_HAS_DIGIT.test(l.sku)) {
        void logger.warn(`parseProductCell: dropped implausible SKU with no digit: "${l.sku}" (qty=${l.qty}) — likely a regex mismatch on unrelated page text, not a real product`);
        return false;
      }
      return true;
    });
}
