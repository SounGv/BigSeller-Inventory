import type { Locator, Page } from '@playwright/test';
import { dismissOrderPageOverlays } from './order-page-overlays.js';
import { clickThroughGuide } from './dismiss-language-guide.js';
import {
  collectRawOrderRows,
  goToNextOrderPage,
  NEW_ORDERS_URL,
  ORDER_COLUMN,
  readFilterPillCount,
  readFilterPills,
  readWarehouseFilterOptions,
  selectFilterPill,
  waitForListSettled,
  setMaxPageSize,
  setWarehouseFilter,
  type RawOrderRow,
  type WarehouseFilterOption,
} from './new-orders-dom.js';
import { humanDelay } from '../utils/human-delay.js';
import { logger } from '../utils/logger.js';
import { SELLER_DELIVERY_CHANNEL } from '../wave-engine/config.js';

/** One order's priority-relevant fields, as read off the page (spec §3). Raw text is kept so an unparsed field is diagnosable from the dry-run log instead of guessed at. */
/**
 * How strictly a scan is checked against the count the filter publishes.
 * `'tolerant'` for the live queue, which legitimately shrinks while the bot
 * paginates; `'exact'` for exclusion lists, where a missing row silently turns
 * an untouchable order into an eligible one.
 */
export type ScanCompleteness = 'tolerant' | 'exact';

export interface ScannedOrderRow {
  orderId: string;
  orderNo: string;
  rawShippingCell: string;
  rawRowText: string;
  statusText: string;
  urgentFlag: boolean;
  /** Which signal produced `urgentFlag` — '' when not flagged. Logged so the real บาร์ด่วนพิเศษ markup can be confirmed on the first live day. */
  urgentSignal: string;
  /** Raw text of the เวลา cell, before parsing — kept so an unreadable timestamp is diagnosable rather than silently treated as "oldest". */
  orderTimeRaw: string;
  /** Raw text following "กำหนดส่ง", before date parsing. null when the label isn't present in the row at all. */
  deliveryDateRaw: string | null;
  /** Raw text of the รายละเอียดสินค้า cell — carries the SKU codes, which is the only way to tell which FLOOR an order picks from. */
  productCell: string;
  warehouse: string;
}

export interface OrderState {
  present: boolean;
  statusText: string;
  hasConfirmControl: boolean;
}

export interface ConfirmResult {
  confirmed: boolean;
  /** What actually happened, for the audit log — including "clicked but could not verify", which is NOT reported as success. */
  note: string;
}

/**
 * The urgent indicator (spec §3 `urgent_flag`, "บาร์ด่วนพิเศษ") has NOT been
 * confirmed against real markup. Two independent signals are checked — a
 * class containing "urgent" anywhere in the row, and these keywords in the row
 * text — and whichever matched is recorded in `urgentSignal` so the real one
 * can be confirmed from a day of dry-run logs and this list then narrowed.
 *
 * Failure modes both stay safe in phase 1: a false negative on a Seller
 * Delivery order falls through to the กำหนดส่ง date rule, and a false positive
 * only reorders within a tier (tier 0 does not act live this phase).
 */
const URGENT_TEXT_SIGNALS = ['ด่วนพิเศษ', 'ด่วน'];

/** BigSeller order ids are its own internal numeric ids; anything else must never reach a CSS attribute selector. */
const SAFE_ORDER_ID = /^[A-Za-z0-9_-]+$/;

/** How long to wait for BigSeller to reflect a confirmation. Generous on purpose — see confirmOrder. */
const CONFIRM_VERIFY_TIMEOUT_MS = Number(process.env.WAVE_ENGINE_CONFIRM_VERIFY_MS ?? 30000);
/** A bulk confirm runs server-side across a whole filtered set, so it needs longer than a single row's. */
const BULK_CONFIRM_TIMEOUT_MS = Number(process.env.WAVE_ENGINE_BULK_CONFIRM_MS ?? 120000);

/**
 * Page Object for the wave-engine's read of `order/index.htm?status=new`:
 * the four priority fields per order (spec §3) plus the confirm action.
 *
 * Separate from `new-orders-page.ts` (which reads SKU lines off the same page
 * for the order-demand sync) because the two need different fields and this
 * one can click. Both share the confirmed DOM facts in `new-orders-dom.ts`.
 *
 * Field-level provenance, checked against real rows 2026-09-10 via
 * `npm run wave-engine -- --dump`:
 *  - CONFIRMED: the 9-column layout (new-orders-dom.ts), the logistics channel
 *    reading from cell [5] ("Seller Delivery เพิ่มข้อมูลขนส่ง",
 *    "Shopee-TH-Instant Delivery - ส่งทันที (แพ็ก 2 ชั่วโมง) [ Pick up ]"), the
 *    status text in cell [7] ("คำสั่งซื้อใหม่"), and the confirm control's
 *    `autoid` (see confirmControl).
 *  - ANSWERS spec §8 q1, negatively: "กำหนดส่ง" does NOT appear in the list
 *    view at all. Real Seller Delivery rows show "Seller Delivery
 *    เพิ่มข้อมูลขนส่ง" (add shipping info) with no date anywhere in the row, so
 *    `deliveryDateRaw` is null for every one of them and they ALL route to the
 *    manual queue. That is the spec §7 behaviour, but it means tier 0 cannot be
 *    automated from this page alone — the date must come from the order-detail
 *    view or an API before tier 0 can ever act.
 *  - STILL UNCONFIRMED: the บาร์ด่วนพิเศษ urgent marker. No sampled row carried
 *    an "urgent" class or either keyword. Cell [4] does carry an SLA countdown
 *    ("Expire 11 ก.ย. 2026 12:00 หมดอายุใน 19 ชั่วโมง") which is absent on
 *    Seller Delivery rows ("Expire --"), but treating any countdown as urgent
 *    would flag nearly every marketplace order, so it is deliberately NOT wired
 *    up until someone confirms what the real indicator looks like.
 *  - UNRELIABLE: the warehouse code. Found only inside cell [2]'s recipient
 *    text, and inconsistently formatted ("(STOCK-3 คลังออนไลน์)" vs "(คลัง3
 *    ออนไลน์)"). Log-only — BigSeller does the wave's zone split itself.
 */
export class BigSellerOrderPriorityPage {
  constructor(private readonly page: Page) {}

  async goto(): Promise<void> {
    await this.page.goto(NEW_ORDERS_URL, { waitUntil: 'domcontentloaded' });
    await this.page.waitForTimeout(2500);
    await dismissOrderPageOverlays(this.page);
    await this.resetAllFilters();
  }

  /**
   * Puts every filter row back to ทั้งหมด before a cycle reads anything.
   *
   * BigSeller REMEMBERS the filters across page loads, so reloading the URL is
   * not a fresh start. Whatever the last run — or the last person — left
   * selected is still applied, and a scan taken under it describes a slice of
   * the queue while reporting itself as the whole thing.
   *
   * This is what broke the live run on 2026-09-12: an earlier cycle died
   * part-way and left a filter on, so the next cycle collected 69 rows against
   * a filter reporting 508 and had to abandon itself. The completeness check
   * did its job; the page state going in was the fault.
   *
   * Verified, not best-effort — `restoreFilterToAll` reads the selection back
   * and throws if it did not move. Starting a cycle blind is the failure this
   * exists to prevent, so a reset that cannot be confirmed stops the cycle.
   */
  async resetAllFilters(): Promise<void> {
    for (const row of ['ร้านค้า', 'แพลตฟอร์ม', 'โลจิสติกส์'] as const) {
      await restoreFilterToAll(this.page, row);
    }
    await setWarehouseFilter(this.page, 'all');
    await logger.info('wave-engine: filters reset to ทั้งหมด — cycle starts from the whole queue');
  }

  /** Reloads the list so a stale DOM can't hide a confirmation someone made by hand since the last scan (idempotency, spec §7). */
  async refresh(): Promise<void> {
    await this.page.reload({ waitUntil: 'domcontentloaded' });
    await this.page.waitForTimeout(2500);
    await dismissOrderPageOverlays(this.page);
  }

  /** Narrows the list with the "โลจิสติกส์" filter row, so the urgent loop can stay a cheap filter+count instead of walking the whole table (spec §5a). Throws if the pill isn't there — caller decides whether to fall back. */
  async selectLogisticsFilter(pillLabel: string): Promise<void> {
    await selectFilterPill(this.page, 'โลจิสติกส์', pillLabel);
  }

  /**
   * Order ids belonging to one store, collected by filtering to it.
   *
   * A row does not say which store it came from — the same limitation
   * order-demand-service.ts already works around by scraping per store filter
   * and classifying by order-number membership. Uses a full (paginated) scan
   * rather than a light one: the reserved store held 61 orders on 2026-09-11,
   * above the default 50/page, and a light scan would silently return a subset
   * — which for an EXCLUSION list means orders wrongly treated as shippable.
   *
   * Resets the store filter to ทั้งหมด afterwards so the caller's own scan is
   * not silently narrowed.
   */
  /**
   * A live queue that reservations are actively being opened/converted in
   * makes a single full scan of an exclusion list race the count it is
   * checked against — the exact match `assertScanIsComplete('exact')` demands
   * is still right (an excluded order missing from this set would look
   * eligible), but a MOMENTARY off-by-a-few during a live day should get a
   * fresh look, not an aborted cycle. Confirmed live 2026-09-15: the LockStock
   * exclusion scan came up short by exactly 1 row on back-to-back urgent
   * ticks while orders were flowing in continuously.
   *
   * Re-reads the count fresh on every attempt — the count itself is what
   * moved, not just the scan going stale — and only gives up (letting the
   * exact assertion throw for real) after every attempt has failed.
   */
  private async scanExactWithRetry(
    params: { warehouseScope?: string },
    readCount: () => Promise<number | undefined>,
    attempts = 3,
  ): Promise<ScannedOrderRow[]> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        return await this.scanOrders({
          depth: 'full',
          warehouseScope: params.warehouseScope,
          expectedCount: await readCount(),
          completeness: 'exact',
        });
      } catch (error) {
        lastError = error;
        if (attempt === attempts) throw error;
        await logger.warn(
          `wave-engine: exclusion scan attempt ${attempt}/${attempts} came up short — likely the queue moved mid-scan, ` +
            `re-reading and trying again: ${(error as Error).message}`,
        );
        await humanDelay(800, 1500);
      }
    }
    // Unreachable — the loop above always returns or throws — but keeps TS happy.
    throw lastError;
  }

  async collectStoreOrderIds(storeName: string): Promise<Set<string>> {
    await selectFilterPill(this.page, 'ร้านค้า', storeName);
    try {
      const rows = await this.scanExactWithRetry({}, () => readFilterPillCount(this.page, 'ร้านค้า', storeName));
      await logger.info(`wave-engine: store "${storeName}" holds ${rows.length} order(s) — excluded from all actions`);
      return new Set(rows.map((row) => row.orderId));
    } finally {
      // A failed reset leaves the whole page filtered to one store, and every
      // later read in the cycle then describes that store instead of the
      // queue. Never swallow it.
      await restoreFilterToAll(this.page, 'ร้านค้า');
    }
  }

  /**
   * Order ids from platforms this engine may not act on.
   *
   * Only the platforms with a non-zero count are scanned — the platform row
   * publishes its own counts, so a day with no manual orders costs nothing.
   * Same membership trick as the reserved store: a row does not say which
   * platform it came from.
   *
   * Resets the platform filter to ทั้งหมด afterwards.
   */
  async collectBlockedPlatformOrderIds(allowedPlatforms: string[]): Promise<Set<string>> {
    const pills = await readFilterPills(this.page, 'แพลตฟอร์ม');
    // `pill.count === 0` is the only reason to skip a blocked platform: an
    // UNREADABLE count (undefined) must still be scanned, or a platform whose
    // markup changed would silently contribute zero exclusions and every order
    // behind it would look eligible.
    const blocked = pills.filter(
      (pill) =>
        pill.count !== 0 &&
        pill.label !== 'ทั้งหมด' &&
        !allowedPlatforms.some((allowed) => pill.label.toLowerCase().includes(allowed.toLowerCase())),
    );
    if (blocked.length === 0) return new Set();

    const ids = new Set<string>();
    try {
      for (const pill of blocked) {
        await selectFilterPill(this.page, 'แพลตฟอร์ม', pill.label);
        const rows = await this.scanExactWithRetry({}, () => readFilterPillCount(this.page, 'แพลตฟอร์ม', pill.label));
        for (const row of rows) ids.add(row.orderId);
        await logger.warn(
          `wave-engine: platform "${pill.label}" holds ${rows.length} order(s) — outside ${allowedPlatforms.join('/')}, excluded from all actions`,
        );
      }
    } finally {
      await restoreFilterToAll(this.page, 'แพลตฟอร์ม');
    }
    return ids;
  }

  /** Every warehouse option with BigSeller's own live order count — how the engine knows whether anything sits outside the picking warehouse without scanning rows. */
  async readWarehouseOptions(): Promise<WarehouseFilterOption[]> {
    return readWarehouseFilterOptions(this.page);
  }

  /** Restricts the list to `names` (or 'all'), verified. Throws rather than leave the scope uncertain — see setWarehouseFilter. */
  async selectWarehouses(names: string[] | 'all'): Promise<void> {
    await setWarehouseFilter(this.page, names);
  }

  /**
   * Scans orders under whatever filters are currently active.
   *
   * `depth: 'light'` reads only the first pagination page with a low scroll
   * cap — for the every-2-3-minutes urgent loop. `depth: 'full'` sets
   * 300/page and walks every page — for the 10-15 minute main loop.
   */
  async scanOrders({
    depth,
    warehouseScope = '',
    expectedCount,
    completeness = 'tolerant',
  }: {
    depth: 'light' | 'full';
    warehouseScope?: string;
    /** BigSeller's own count for the active filter — the scan is checked against it and throws on a real shortfall. */
    expectedCount?: number;
    /** `'exact'` for exclusion lists: no tolerance, and an unreadable count is itself a failure. */
    completeness?: ScanCompleteness;
  }): Promise<ScannedOrderRow[]> {
    const rows: ScannedOrderRow[] = [];

    if (depth === 'light') {
      const raw = await collectRawOrderRows(this.page, { maxRounds: 6 });
      if (raw.length === 0) {
        await logger.warn(`wave-engine: light scan found no table.list_items rows on ${this.page.url()} — empty queue or markup changed`);
      }
      return raw.map((row) => toScannedOrder(row, warehouseScope));
    }

    await waitForListSettled(this.page);
    await setMaxPageSize(this.page);

    // Deduped by order id ACROSS pages, not just within one.
    //
    // Staff work this queue at the same time as the bot, so rows leave it
    // while the bot is paginating and everything behind them shifts back a
    // page — which means the same order can be read on page 1 and again on
    // page 2. Confirmed live 2026-09-11: a scan reported 313 rows against a
    // filter count of 165, and the duplicate entries made the engine confirm
    // two orders TWICE in one cycle (06:06:55 then 06:08:04 for the same
    // order). The per-page collector dedupes within a page; only this map
    // catches it across them.
    const byOrderId = new Map<string, ScannedOrderRow>();
    let duplicates = 0;

    for (let pageNumber = 1; pageNumber <= 20; pageNumber++) {
      const raw = await collectRawOrderRows(this.page);
      if (raw.length === 0) {
        if (pageNumber === 1) {
          await logger.warn(`wave-engine: full scan found no table.list_items rows on ${this.page.url()} — empty queue or markup changed`);
        }
        break;
      }
      for (const row of raw) {
        const scanned = toScannedOrder(row, warehouseScope);
        if (byOrderId.has(scanned.orderId)) {
          duplicates++;
          continue;
        }
        byOrderId.set(scanned.orderId, scanned);
      }
      await logger.info(
        `wave-engine: full scan page ${pageNumber} yielded ${raw.length} row(s) (unique so far ${byOrderId.size})`,
      );
      if (!(await goToNextOrderPage(this.page))) {
        await logger.info(`wave-engine: full scan stopped after page ${pageNumber} — no next page`);
        break;
      }
    }

    if (duplicates > 0) {
      await logger.info(
        `wave-engine: dropped ${duplicates} duplicate row(s) seen on more than one page — the queue shifted while paginating`,
      );
    }

    rows.push(...byOrderId.values());
    assertScanIsComplete(rows.length, expectedCount, completeness);
    return rows;
  }

  /** Raw rows exactly as read, for `--dump`: the only honest way to confirm the shipping-cell layout before relying on it. */
  async dumpRawRows(limit: number): Promise<RawOrderRow[]> {
    const raw = await collectRawOrderRows(this.page, { maxRounds: 6 });
    return raw.slice(0, limit);
  }

  private orderTable(orderId: string): Locator {
    if (!SAFE_ORDER_ID.test(orderId)) {
      throw new Error(`Refusing to build a selector from an unexpected order id: ${JSON.stringify(orderId)}`);
    }
    // filter({ has: ... }) rather than .first()/.nth(i) — spec §6: positional
    // locators break silently when the DOM order shifts, which on a queue that
    // gains orders continuously would mean confirming the wrong order.
    return this.page
      .locator('table.list_items')
      .filter({ has: this.page.locator(`tr[data-orderid="${orderId}"]`) });
  }

  /**
   * The row's confirm control, confirmed live 2026-09-10 via a raw dump of the
   * ดำเนินการ cell:
   *
   *   <a href="javascript:" autoid="orders_15525908136_pack_order"
   *      title="ยืนยัน" class="action_btn new_action_btn"><span
   *      class="icon-item bsicon_package"></span></a>
   *
   * `autoid` is BigSeller's OWN automation id and it embeds the order id — the
   * `getByTestId`-equivalent spec §6 asks for first, and the only locator here
   * that is both per-order and language-independent. Preferred over the title,
   * which is Thai-only and would break under a locale switch.
   *
   * Precision is safety-critical in this cell, not just robustness: the same
   * row carries `title="ยกเลิกคำสั่งซื้อ"` (cancel the order) and
   * `title="คำสั่งซื้อเป็นโมฆะ"` (void it) as siblings with the IDENTICAL
   * `action_btn new_action_btn` class and, like confirm, no text at all. A
   * positional locator (`.first()`, `.nth(i)`) among those would eventually
   * cancel a real customer's order instead of confirming it. Never select these
   * by position.
   *
   * Also note "ยืนยัน" exists as a PAGE-level button too (the filter bar's
   * own), so this stays scoped to the order's table.
   */
  private confirmControl(orderId: string): Locator {
    const row = this.orderTable(orderId);
    return row
      .locator(`a[autoid="orders_${orderId}_pack_order"]`)
      .or(row.locator('.item_action a[title="ยืนยัน"]'));
  }

  /** Live re-read of one order straight from the current DOM — the immediately-before-confirm check that keeps a poll cycle from double-confirming something a human just handled. */
  /**
   * Reloads the list and puts back the context the scan ran under.
   *
   * A bare reload is not enough: it drops the คลังสินค้า filter and the
   * 300/page size, so the list comes back as an unfiltered first page in a
   * different order. Confirmed live 2026-09-11 — the same order was picked for
   * confirmation twice, three minutes apart, and both times `readOrderState`
   * reported "no longer confirmable" while the very next scan still found it
   * sitting in the queue. Nobody had confirmed it; the bot was simply looking
   * at a different list.
   */
  async refreshKeepingScope(warehouse: string): Promise<void> {
    await this.refresh();
    await this.selectWarehouses([warehouse]);
    await setMaxPageSize(this.page);
  }

  /**
   * Scrolls until this order's row exists in the DOM.
   *
   * This page lazy-renders only the rows near the current scroll position
   * (~15 at a time), so "not in the DOM" means "not scrolled to", NOT "gone
   * from the queue" — and treating the two as the same is what made the
   * engine skip a perfectly confirmable order. Returns false only after
   * actually walking the page to the bottom.
   */
  async scrollToOrder(orderId: string): Promise<boolean> {
    if ((await this.orderTable(orderId).count()) > 0) return true;

    await this.page.evaluate(() => window.scrollTo(0, 0));
    await this.page.waitForTimeout(300);
    for (let round = 0; round < 60; round++) {
      if ((await this.orderTable(orderId).count()) > 0) return true;
      const atBottom = await this.page.evaluate(() => {
        const before = window.scrollY;
        window.scrollBy(0, window.innerHeight * 2);
        return window.scrollY === before;
      });
      await this.page.waitForTimeout(350);
      if (atBottom) break;
    }
    return (await this.orderTable(orderId).count()) > 0;
  }

  /** Reads the row as-is, without hunting for it — used while polling right after a click, where the row is already on screen. */
  private async readOrderStateWithoutScrolling(orderId: string): Promise<OrderState> {
    const table = this.orderTable(orderId);
    if ((await table.count()) === 0) return { present: false, statusText: '', hasConfirmControl: false };
    const cells = await table.locator('td').allInnerTexts();
    return {
      present: true,
      statusText: (cells[ORDER_COLUMN.status] ?? '').replace(/\s+/g, ' ').trim(),
      hasConfirmControl: (await this.confirmControl(orderId).count()) > 0,
    };
  }

  async readOrderState(orderId: string): Promise<OrderState> {
    const table = this.orderTable(orderId);
    const present = (await this.scrollToOrder(orderId)) && (await table.count()) > 0;
    if (!present) return { present: false, statusText: '', hasConfirmControl: false };

    const cells = await table.locator('td').allInnerTexts();
    const statusText = (cells[ORDER_COLUMN.status] ?? '').replace(/\s+/g, ' ').trim();
    const hasConfirmControl = (await this.confirmControl(orderId).count()) > 0;
    return { present, statusText, hasConfirmControl };
  }

  /**
   * Clicks this order's confirm control, then waits for the row to leave the
   * `status=new` list as positive evidence it took effect.
   *
   * Only ever reached in live mode for tier 1 in phase 1. Reports
   * `confirmed: false` with a note when the click landed but the outcome could
   * not be verified — an unverified click must not be logged as a success,
   * since the audit log is what the phase-1 sign-off is spot-checked against.
   */
  /**
   * The counter strip under the bulk ยืนยัน button.
   *
   * These are the page's own numbers for the CURRENT filter, and they are what
   * makes a bulk confirm verifiable: รอยืนยัน has to fall by the number of
   * orders in the set, and ยืนยันล้มเหลว / ของขาด have to stay where they were.
   */
  async readConfirmCounters(): Promise<{ waiting: number; inProgress: number; failed: number; shortStock: number }> {
    return this.page.evaluate(() => {
      const text = (document.body.innerText ?? '').replace(/\s+/g, ' ');
      const read = (label: string) => {
        const match = text.match(new RegExp(`${label}\s*(\d[\d,]*)`));
        return match ? Number(match[1].replace(/,/g, '')) : -1;
      };
      return {
        waiting: read('รอยืนยัน'),
        inProgress: read('กำลังยืนยัน'),
        failed: read('ยืนยันล้มเหลว'),
        shortStock: read('ของขาด'),
      };
    });
  }

  /**
   * Confirms every order under the CURRENT filter in one click, the way staff
   * do it (instructed 2026-09-12: filter platform, filter logistics, check the
   * count, press ยืนยัน).
   *
   * Row-by-row confirming was both slower than a person and less reliable —
   * two live attempts on 2026-09-12 clicked a row's own confirm control and
   * neither landed. This button is the one the warehouse actually uses.
   *
   * It is also the most dangerous control on the page: it acts on everything
   * the filter is showing, so the guards below are the whole safety story.
   * Nothing is clicked unless every one of them passes.
   */
  async bulkConfirmFiltered(params: {
    expectedCourier: string;
    allowedPlatforms: string[];
    reservedStore: string;
    maxOrders: number;
  }): Promise<{ confirmed: number; before: number; after: number; note: string }> {
    const { expectedCourier, allowedPlatforms, reservedStore, maxOrders } = params;

    // Guard 1 — the logistics filter must be narrowed to the ONE courier this
    // call was told about. A bulk confirm under ทั้งหมด would confirm the whole
    // queue.
    const logistics = (await readFilterPills(this.page, 'โลจิสติกส์')).find((pill) => pill.active);
    if (!logistics || logistics.label !== expectedCourier) {
      throw new Error(
        `Refusing to bulk confirm: the โลจิสติกส์ filter reads "${logistics?.label ?? '(nothing active)'}" but this call is for "${expectedCourier}".`,
      );
    }

    // Guard 2 — reservations live under Seller Delivery, and a bulk confirm
    // cannot pick rows out of a set. The only safe answer is never to run one
    // on that courier.
    if (logistics.label.includes(SELLER_DELIVERY_CHANNEL)) {
      throw new Error(
        `Refusing to bulk confirm "${logistics.label}": ${reservedStore} reservations live under this courier and a bulk confirm cannot leave them out.`,
      );
    }

    // Guard 3 — and prove it, rather than trusting the courier name. If any
    // reserved order is visible under this filter, stop.
    const reservedHere = (await readFilterPills(this.page, 'ร้านค้า')).find((pill) => pill.label === reservedStore);
    if ((reservedHere?.count ?? 0) > 0) {
      throw new Error(
        `Refusing to bulk confirm: ${reservedHere?.count} ${reservedStore} order(s) are inside the current filter and would be confirmed with everything else.`,
      );
    }

    // Guard 4 — every platform showing anything must be one this engine may act
    // on.
    const platformsPresent = (await readFilterPills(this.page, 'แพลตฟอร์ม')).filter(
      (pill) => pill.label !== 'ทั้งหมด' && (pill.count ?? 0) > 0,
    );
    const blocked = platformsPresent.filter(
      (pill) => !allowedPlatforms.some((allowed) => pill.label.toLowerCase().includes(allowed.toLowerCase())),
    );
    if (blocked.length > 0) {
      throw new Error(
        `Refusing to bulk confirm: ${blocked.map((pill) => `${pill.label} (${pill.count})`).join(', ')} ` +
          `${blocked.length === 1 ? 'is' : 'are'} outside ${allowedPlatforms.join('/')} and would be confirmed too.`,
      );
    }

    const before = await this.readConfirmCounters();
    if (before.waiting <= 0) {
      return { confirmed: 0, before: before.waiting, after: before.waiting, note: 'nothing waiting to confirm under this filter' };
    }

    // Guard 5 — a set larger than the caller expected means the filter is not
    // what it thought. Better to stop than to confirm hundreds by surprise.
    if (before.waiting > maxOrders) {
      throw new Error(
        `Refusing to bulk confirm ${before.waiting} order(s) for "${expectedCourier}" — more than the ${maxOrders} this run allows.`,
      );
    }

    await logger.warn(
      `wave-engine: BULK CONFIRM "${expectedCourier}" — ${before.waiting} order(s) waiting, ` +
        `failed=${before.failed} shortStock=${before.shortStock}. Clicking ยืนยัน now.`,
    );

    await dismissOrderPageOverlays(this.page);
    const button = this.page.locator('button.ant-btn-primary:visible').filter({ hasText: /^ยืนยัน$/ }).first();
    if ((await button.count()) === 0) throw new Error('Bulk ยืนยัน button not found on the page');
    await humanDelay(600, 1600);
    await clickThroughGuide(this.page, button, { timeout: 8000 });
    const modalNote = await this.acknowledgeConfirmModalIfPresent();

    // BigSeller processes a bulk confirm in the background — กำลังยืนยัน rises
    // and รอยืนยัน falls over several seconds — so the result is read from the
    // counters settling, not from the click returning.
    const deadline = Date.now() + BULK_CONFIRM_TIMEOUT_MS;
    let last = before;
    while (Date.now() < deadline) {
      await this.page.waitForTimeout(2000);
      const now = await this.readConfirmCounters();
      if (now.inProgress === 0 && now.waiting < before.waiting) {
        return {
          confirmed: before.waiting - now.waiting,
          before: before.waiting,
          after: now.waiting,
          note:
            `รอยืนยัน ${before.waiting} → ${now.waiting}` +
            (now.failed > before.failed ? `, ยืนยันล้มเหลว +${now.failed - before.failed}` : '') +
            (now.shortStock > before.shortStock ? `, ของขาด +${now.shortStock - before.shortStock}` : '') +
            modalNote,
        };
      }
      last = now;
    }
    return {
      confirmed: 0,
      before: before.waiting,
      after: last.waiting,
      note:
        `clicked ยืนยัน but after ${BULK_CONFIRM_TIMEOUT_MS / 1000}s รอยืนยัน is still ${last.waiting} ` +
        `(กำลังยืนยัน ${last.inProgress})${modalNote} — needs manual verification`,
    };
  }

  async confirmOrder(orderId: string): Promise<ConfirmResult> {
    const control = this.confirmControl(orderId);
    if ((await control.count()) === 0) {
      return { confirmed: false, note: 'no ยืนยัน/Confirm control found in this row' };
    }

    await dismissOrderPageOverlays(this.page);
    await humanDelay(600, 1600); // human-like pacing between real clicks (spec §7)
    await clickThroughGuide(this.page, control.first(), { timeout: 5000 });

    const modalNote = await this.acknowledgeConfirmModalIfPresent();

    // Accept THREE kinds of evidence, over a window long enough for a platform
    // that queues confirmations.
    //
    // Waiting only for the row to detach, and only for 8 seconds, reported
    // three real confirmations as UNVERIFIED on 2026-09-11 — the clicks had
    // landed (the queue counts dropped) but BigSeller had not finished
    // removing the rows. A wrong "unverified" in the audit log is not
    // harmless: it invites someone to confirm the order a second time by hand.
    const deadline = Date.now() + CONFIRM_VERIFY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if ((await this.orderTable(orderId).count()) === 0) {
        return { confirmed: true, note: `row left the status=new list${modalNote}` };
      }
      const state = await this.readOrderStateWithoutScrolling(orderId);
      if (!state.hasConfirmControl) {
        return { confirmed: true, note: `row still listed but its confirm control is gone${modalNote}` };
      }
      if (state.statusText !== '' && !state.statusText.includes('ใหม่')) {
        return { confirmed: true, note: `row status changed to "${state.statusText}"${modalNote}` };
      }
      await this.page.waitForTimeout(1500);
    }
    return {
      confirmed: false,
      note:
        `clicked confirm but after ${CONFIRM_VERIFY_TIMEOUT_MS / 1000}s the row is still listed, still has its ` +
        `confirm control, and still reads as new${modalNote} — needs manual verification`,
    };
  }

  /**
   * Some BigSeller actions open a second confirmation modal. Whether the
   * confirm action does has NOT been confirmed live, so this only ever clicks a
   * button inside a visible `.ant-modal` whose label is an explicit
   * confirm/ok, logs the modal's own text, and does nothing at all when no
   * modal appeared.
   */
  private async acknowledgeConfirmModalIfPresent(): Promise<string> {
    const modal = this.page.locator('.ant-modal-wrap:visible').first();
    if (!(await modal.isVisible({ timeout: 2000 }).catch(() => false))) return '';

    const modalText = ((await modal.innerText().catch(() => '')) ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
    // Read it BEFORE agreeing to it. This used to click the OK button of
    // whatever dialog happened to be on screen, so a warning the bot has no
    // business accepting — short stock, a negative-stock override, a
    // confirm-everything prompt — would have been agreed to silently and only
    // described in the log afterwards.
    await logger.info(`wave-engine: confirm opened a modal: "${modalText}"`);

    // Questions only a person may answer. Anything about stock is squarely in
    // this group: STOCK_5 is the only warehouse holding sellable stock, and
    // the standing rule is that the bot reports a stock problem and never
    // resolves one itself.
    const REFUSE_MARKERS = ['ไม่พอ', 'ติดลบ', 'ไม่เพียงพอ', 'สต็อก', 'ยกเลิก', 'ลบ', 'insufficient', 'negative', 'cancel', 'delete'];
    const refuseMarker = REFUSE_MARKERS.find((marker) => modalText.toLowerCase().includes(marker.toLowerCase()));
    if (refuseMarker) {
      await this.page.keyboard.press('Escape').catch(() => undefined);
      await logger.error(
        `wave-engine: REFUSED to answer a confirm modal mentioning "${refuseMarker}" — dismissed it instead. ` +
          `A person has to decide this one: "${modalText}"`,
      );
      return ` (refused modal mentioning "${refuseMarker}": "${modalText}")`;
    }

    const okButton = modal.getByRole('button', { name: /^(ยืนยัน|ตกลง|Confirm|OK)$/i });
    if ((await okButton.count()) === 0) {
      await logger.warn(`wave-engine: confirm modal has no recognised confirm button: "${modalText}"`);
      return ` (unhandled modal: "${modalText}")`;
    }
    await okButton.first().click({ timeout: 5000 });
    await logger.info(`wave-engine: acknowledged confirm modal: "${modalText}"`);
    return ` (acknowledged modal: "${modalText}")`;
  }
}

const DELIVERY_DATE_LABEL = 'กำหนดส่ง';

/**
 * `warehouse` is stamped from the คลังสินค้า filter the scan was run under —
 * NOT read from the row.
 *
 * An earlier version matched /STOCK[_-]?\d+/ against the row text and was
 * plainly wrong, caught 2026-09-10 against real rows: the only STOCK-shaped
 * text in a row lives in the ผู้รับ cell and belongs to the CUSTOMER, e.g. the
 * JIB order reading "บริษัท เจ.ไอ.บี.คอมพิวเตอร์ กรุ๊ป จำกัด (สำนักงานใหญ่)
 * (STOCK-3 คลังออนไลน์)" — that is JIB's own branch warehouse, nothing to do
 * with which of OUR warehouses holds the stock. Feeding that into the
 * STOCK_5-only guardrail would have flagged orders for a stock move based on
 * the buyer's address. Unknown ('') until a filtered scan supplies it.
 */
/**
 * Fails a scan that returned materially fewer rows than the filter itself says
 * exist.
 *
 * A partial scan is the most dangerous failure this engine has: it looks like a
 * successful cycle, but every order it never saw is an order that silently does
 * not get confirmed — including urgent ones. Confirmed live 2026-09-11: a scan
 * returned 81 rows while the คลังสินค้า filter reported 1,619, and the only
 * symptom was a smaller-than-usual summary line.
 *
 * The tolerance is deliberately wide. This queue is worked by people at the
 * same time as the bot: orders arrive AND get confirmed by hand while a scan
 * is running, so the count and the row total are never going to match. Two
 * cycles were aborted on 2026-09-11 over gaps of 8% (146/160, 152/165) that
 * were nothing but staff doing their job. What this guard exists to catch is
 * structural — a scan that silently returns one page of many (81 rows against
 * 1,619) — and that survives any sane tolerance.
 */
/**
 * Puts a filter row back on ทั้งหมด and REFUSES to continue if it will not go.
 *
 * The old version swallowed the failure. On 2026-09-12 that left the platform
 * row stuck on คำสั่งซื้อด้วยตนเอง: the run reported an empty morning, and the
 * staff's own screen was left filtered behind it. A filter that cannot be reset
 * is not a cosmetic problem — every count taken afterwards is wrong.
 */
export async function restoreFilterToAll(page: Page, rowLabel: string): Promise<void> {
  try {
    await selectFilterPill(page, rowLabel, 'ทั้งหมด');
  } catch (error) {
    const message = `Could not reset the "${rowLabel}" filter to ทั้งหมด — the page is left filtered and every later count would be wrong: ${(error as Error).message}`;
    await logger.error(`wave-engine: ${message}`);
    throw new Error(message);
  }
}

export function assertScanIsComplete(
  scanned: number,
  expected: number | undefined,
  completeness: ScanCompleteness = 'tolerant',
): void {
  // An exclusion list has to be read WHOLE. A missing id there does not mean
  // "one order goes unconfirmed" — it means an order nobody may touch looks
  // touchable, which is the failure mode the guard exists to prevent. And the
  // tolerance below only makes sense for the live queue, which shrinks under
  // the bot because staff confirm from it; a LockStock or manual-order filter
  // does not shrink that way, so a shortfall there is a read problem, not
  // concurrent work.
  if (completeness === 'exact') {
    if (expected === undefined) {
      throw new Error(
        `Scan is unverifiable: collected ${scanned} row(s) but the active filter published no count. ` +
          'Refusing to build an exclusion list that cannot be checked — an unread order would look eligible.',
      );
    }
    if (scanned >= expected) return;
    throw new Error(
      `Exclusion scan is incomplete: collected ${scanned} row(s) but the active filter reports ${expected}. ` +
        'Refusing to act — every order missing from this list would be treated as eligible.',
    );
  }

  if (expected === undefined) return;
  const tolerance = Math.max(25, Math.ceil(expected * 0.25));
  if (scanned >= expected - tolerance) return;
  throw new Error(
    `Scan is incomplete: collected ${scanned} row(s) but the active filter reports ${expected}. ` +
      'Refusing to act on a partial view of the queue — orders that were never scanned would silently go unconfirmed.',
  );
}

export function toScannedOrder(row: RawOrderRow, warehouseScope = ''): ScannedOrderRow {
  const shipping = row.cells[ORDER_COLUMN.shipping] ?? '';
  const urgentKeyword = URGENT_TEXT_SIGNALS.find((signal) => row.rowText.includes(signal));
  const urgentSignal = row.hasUrgentClass ? 'class*=urgent' : (urgentKeyword ?? '');

  return {
    orderId: row.orderId,
    orderNo: (row.cells[ORDER_COLUMN.orderNo] ?? '').replace(/คัดลอก/g, '').trim(),
    rawShippingCell: shipping,
    rawRowText: row.rowText,
    statusText: (row.cells[ORDER_COLUMN.status] ?? '').trim(),
    urgentFlag: urgentSignal !== '',
    urgentSignal,
    orderTimeRaw: (row.cells[ORDER_COLUMN.time] ?? '').replace(/\s+/g, ' ').trim(),
    deliveryDateRaw: extractDeliveryDateText(shipping),
    productCell: (row.cells[ORDER_COLUMN.product] ?? '').replace(/\s+/g, ' ').trim(),
    warehouse: warehouseScope,
  };
}

/**
 * Grabs the text right after the "กำหนดส่ง" label so {@link parseDeliveryDate}
 * can try to read a date out of it. Deliberately returns a slice of raw text
 * rather than a parsed value: the field's real format is unconfirmed, and a
 * wrong parse on a Seller Delivery order is exactly the mistake spec §7
 * forbids, so the unparsed text travels all the way into the log.
 */
export function extractDeliveryDateText(shippingCell: string): string | null {
  const index = shippingCell.indexOf(DELIVERY_DATE_LABEL);
  if (index === -1) return null;
  const after = shippingCell.slice(index + DELIVERY_DATE_LABEL.length, index + DELIVERY_DATE_LABEL.length + 40);
  return after.replace(/^[\s:：]+/, '').trim() || null;
}
