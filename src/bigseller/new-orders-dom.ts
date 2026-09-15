import type { Page } from '@playwright/test';
import { dismissOrderPageOverlays } from './order-page-overlays.js';
import { clickThroughGuide } from './dismiss-language-guide.js';
import { humanDelay } from '../utils/human-delay.js';
import { logger } from '../utils/logger.js';

/**
 * The confirmed-live DOM facts about `order/index.htm?status=new`, shared by
 * every page object that reads that page (order-demand's SKU-line scraper in
 * new-orders-page.ts, and the wave-engine's priority scanner in
 * order-priority-page.ts). Extracted so these facts — each one learned the
 * hard way against real markup — live in exactly one place and can't drift
 * between two copies.
 */

export const NEW_ORDERS_URL =
  process.env.BIGSELLER_NEW_ORDERS_URL ?? 'https://www.bigseller.com/web/order/index.htm?status=new';

export interface RawOrderRow {
  /** `<tr data-orderid="...">` — BigSeller's own internal id, stable and unique unlike the human-typed order number. */
  orderId: string;
  /** The 9 `<td>` texts of this order's row, whitespace-collapsed. See column map below. */
  cells: string[];
  /** Whole-row text, for signals that aren't cleanly confined to one cell. */
  rowText: string;
  /** True when any descendant carries a class containing "urgent" — one of two signals used for the บาร์ด่วนพิเศษ flag. */
  hasUrgentClass: boolean;
}

/**
 * Column indices into {@link RawOrderRow.cells}, confirmed live 2026-08-31
 * against a raw HTML dump of one real row.
 *
 * The header lives in a SEPARATE `table.list_header` whose leading
 * empty/checkbox column has NO corresponding `<td>` in each `list_items` row —
 * an off-by-one here silently shifts every field one column right and yields
 * zero usable rows. Verify against a fresh raw-HTML dump before changing these.
 * Indices 4-8 were confirmed by position/content in the header dump only, not
 * by class name.
 */
export const ORDER_COLUMN = {
  product: 0, // .merge_el.dt_el — รายละเอียดสินค้า
  value: 1, // .vp_el — มูลค่าคำสั่งซื้อ&การชำระเงิน
  recipient: 2, // .rr_el — ผู้รับ&ภูมิภาค
  orderNo: 3, // .odn_el — หมายเลขคำสั่งซื้อ&ผู้ซื้อ
  time: 4, // เวลา
  shipping: 5, // การตั้งค่าการจัดส่ง&หมายเลขแทร็คกิ้ง
  platformStatus: 6, // สถานะแพลตฟอร์ม
  status: 7, // สถานะ
  // ดำเนินการ — icon-only `<a>` controls, so this cell's TEXT is always empty.
  // Confirmed live 2026-09-10: act on them via their `autoid` attribute
  // (see order-priority-page.ts's confirmControl), never by text or position.
  actions: 8,
} as const;

/**
 * Sets the page-size selector to its maximum (300).
 *
 * Confirmed live 2026-08-31 via a raw HTML dump of `.pagination`: this is a
 * genuine native `<select>`, NOT a click-to-open custom dropdown like the Ant
 * Design ones elsewhere in this project — an earlier version assumed that and
 * silently left every run stuck at the default 50/page.
 *
 * Live counts ran ~930-945 new orders and drift upward between checks (orders
 * arrive continuously — never expect a stable total), i.e. 4 pages at 300/page.
 * DOM scraping is used rather than an export because this page has no export
 * for "new" orders at all (confirmed by the user 2026-08-31 — only
 * already-processed orders get one). `.pagination` also
 * appears MORE THAN ONCE (the page renders a duplicate pagination bar), so an
 * unscoped locator hits Playwright's strict-mode error; `.first()` resolves it
 * and both bars mirror the same underlying state.
 */
export async function setMaxPageSize(page: Page): Promise<void> {
  await dismissOrderPageOverlays(page);
  await page.locator('.pagination .list_num_item select').first().selectOption('300');
  await page.waitForTimeout(2000);
}

/**
 * Clicks the pagination bar's "Next Page" arrow once; false when there is no
 * next page.
 *
 * Confirmed live 2026-08-31: `<li class="next_item"><a title="Next Page">`,
 * with the `<li>` gaining a `disabled` class at the end. An earlier version
 * targeted a page-number jumper via `input[type="number"]` — that input's real
 * type is "text", so the selector never matched and every run silently stopped
 * after page 1.
 *
 * The `:visible` scoping is a REAL BUG FIX, confirmed live 2026-09-10: this
 * page renders THREE `li.next_item` elements (two visible duplicates plus one
 * hidden), so an unscoped `.evaluate()` hit Playwright's strict-mode violation,
 * the `.catch(() => true)` below read that exception as "disabled", and every
 * scan silently stopped after page 1. Measured on a real queue at the time:
 * pagination read "1 - 300 of 387 … 1 / 2", so 87 orders were never being
 * scanned — by the wave engine OR by the order-demand sync that shares this
 * function. Keep the selector single-element; do not widen it again.
 */
export async function goToNextOrderPage(page: Page): Promise<boolean> {
  const nextItem = page.locator('li.next_item:visible').first();
  const disabled = await nextItem.evaluate((el) => el.classList.contains('disabled')).catch(() => true);
  if (disabled) return false;

  await dismissOrderPageOverlays(page);
  await clickThroughGuide(page, nextItem.locator('a[title="Next Page"]'), { timeout: 3000 }).catch(() => undefined);
  await page.waitForTimeout(2000);
  await dismissOrderPageOverlays(page);
  return true;
}

/**
 * The pagination bar's own row total ("1 - 50 of 50", "1 - 300 of 387") —
 * the actual count of rows the table itself has, straight from BigSeller's
 * rendering of the list.
 *
 * Confirmed live 2026-09-15: this can DISAGREE with a filter row's own pill
 * badge — LockStock's badge read 51 while a scan of the actual table (and
 * this bar) both agreed on 50. The badge is a separately-cached count that
 * can lag; this bar reflects what is actually in the table right now, which
 * is what an exclusion-list scan needs to match.
 *
 * `.pagination` renders twice on this page (a confirmed duplicate — see
 * setMaxPageSize above), so only the first is read. Returns undefined when no
 * pagination bar is present (an empty list has none) or its text does not
 * parse, so a caller must decide what "unreadable" means for its own check.
 */
export async function readPaginationTotal(page: Page): Promise<number | undefined> {
  const text = await page
    .locator('.pagination')
    .first()
    .textContent()
    .catch(() => null);
  const match = (text ?? '').replace(/\s+/g, ' ').match(/of\s+(\d[\d,]*)/i);
  return match ? Number(match[1].replace(/,/g, '')) : undefined;
}

/**
 * Collects every `table.list_items` row reachable on the CURRENT pagination
 * page by scrolling down repeatedly and re-reading the DOM between scrolls,
 * deduping by `data-orderid`.
 *
 * Confirmed live 2026-08-31: even at 300/page (pagination read "1 - 300 of
 * 947") only ~15 `table.list_items` existed in the DOM at once — this page
 * lazy-renders rows near the scroll position, so a single `querySelectorAll`
 * after landing is not enough. Stops after 3 consecutive rounds that add no new
 * order ids, capped at `maxRounds` either way.
 *
 * `maxRounds` is what makes the urgent loop cheap (spec §5a wants it to stay a
 * lightweight filter+count, not a full table walk): a small cap reads the top
 * of the list and stops.
 */
export async function collectRawOrderRows(page: Page, { maxRounds = 60 }: { maxRounds?: number } = {}): Promise<RawOrderRow[]> {
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(300);

  const seen = new Map<string, RawOrderRow>();
  let stableRounds = 0;
  for (let round = 0; round < maxRounds && stableRounds < 3; round++) {
    // Do NOT declare a named helper (`const collapse = ...`, or a function
    // declaration) inside this callback. Confirmed live 2026-09-10: tsx/esbuild
    // compiles named functions with a `__name(...)` wrapper for keepNames, and
    // that helper does not exist in the page's own JS context — the callback
    // throws "ReferenceError: __name is not defined" the moment it runs in the
    // browser. Inline anonymous callbacks (like the `.map()` ones below) are
    // unaffected, which is why the original version of this code worked.
    const batch = await page.evaluate(() =>
      Array.from(document.querySelectorAll('table.list_items')).map((table) => {
        const row = table.querySelector('tr');
        return {
          orderId: row?.getAttribute('data-orderid') ?? '',
          cells: Array.from(table.querySelectorAll('td')).map((cell) => (cell.textContent ?? '').replace(/\s+/g, ' ').trim()),
          rowText: (table.textContent ?? '').replace(/\s+/g, ' ').trim(),
          hasUrgentClass: table.querySelector('[class*="urgent" i]') !== null,
        };
      }),
    );

    const before = seen.size;
    for (const item of batch) {
      if (item.orderId) seen.set(item.orderId, item);
    }
    stableRounds = seen.size === before ? stableRounds + 1 : 0;

    await page.evaluate(() => window.scrollBy(0, window.innerHeight * 2));
    await page.waitForTimeout(400);
  }
  return [...seen.values()];
}

/**
 * Selects a pill in one specific filter row, identified by that row's own
 * leading label cell (e.g. "ร้านค้า", "โลจิสติกส์").
 *
 * MUST stay scoped to the row: confirmed live 2026-08-31 that `span.ship_item`
 * with text "ทั้งหมด" matches several unrelated filter rows (แพลตฟอร์ม,
 * โลจิสติกส์, ...each has its own "ทั้งหมด" pill), so an unscoped locator can
 * click the wrong row's pill and then time out waiting for a state change that
 * was never going to happen.
 */
export interface WarehouseFilterOption {
  /** Warehouse name with the count stripped, e.g. "STOCK_5", "STOCK_ซิงก์ขายออนไลน์", "Test01". */
  name: string;
  /** BigSeller's own live count of new orders in this warehouse — free, and exact, without scanning a single row. */
  count: number;
  checked: boolean;
}

/**
 * Each filter row's own container id, confirmed live 2026-09-10 from a raw
 * dump of the filter table. These beat matching on the row's label text: they
 * are unique, language-independent, and can't be confused with another row
 * whose cell merely CONTAINS the same word.
 *
 * Learned the hard way the same day: a `tr`-with-`td`-hasText locator for
 * "คลังสินค้า" resolved to a row with no options in it at all (the filter read
 * back as an empty list and the run aborted), while these ids resolve straight
 * to the right container.
 */
const FILTER_ROW_CONTAINER: Record<string, string> = {
  แพลตฟอร์ม: '#really_height_site',
  ร้านค้า: '#really_height',
  โลจิสติกส์: '#really_height_logi',
  คลังสินค้า: '#really_height_warehouse',
};

/** The คลังสินค้า filter row. Unlike the pill rows, this one is an antd checkbox GROUP (confirmed live 2026-09-10). */
function warehouseFilterRow(page: Page) {
  return page.locator(FILTER_ROW_CONTAINER.คลังสินค้า).first();
}

/**
 * Reads every warehouse option with its live order count, e.g.
 * `{ name: 'STOCK_5', count: 426, checked: true }`.
 *
 * Confirmed live 2026-09-10: each option is a
 * `<label class="ant-checkbox-wrapper">` whose text reads "STOCK_5 (426)", and
 * the group's "ทั้งหมด" master checkbox carries the extra class
 * `checkbox_all`. The per-warehouse counts here are the cheapest reliable way
 * to know whether any order sits outside the picking warehouse — no row
 * scanning needed to find out that there is nothing to look at.
 */
export async function readWarehouseFilterOptions(page: Page): Promise<WarehouseFilterOption[]> {
  return warehouseFilterRow(page)
    .locator(WAREHOUSE_OPTION_SELECTOR)
    .evaluateAll((labels) =>
      labels.map((label) => {
        const text = (label.textContent ?? '').replace(/\s+/g, ' ').trim();
        // BigSeller prints a thousands separator once a warehouse passes 999
        // ("STOCK_5 (1,547)"). A digits-only pattern silently failed to match
        // there, which left the count at 0 AND kept the separator inside the
        // name — so on 2026-09-12 the board reported "0 orders" for a warehouse
        // holding over 1,500, and setWarehouseFilter could no longer find
        // "STOCK_5" at all.
        const match = text.match(/^(.*?)\s*\(([\d,]+)\)$/);
        return {
          name: (match ? match[1] : text).trim(),
          count: match ? Number(match[2].replace(/,/g, '')) : 0,
          checked: label.className.includes('ant-checkbox-wrapper-checked'),
        };
      }),
    );
}

/** Every warehouse option EXCEPT the group's "ทั้งหมด" master, so option order lines up 1:1 wherever both are used. */
const WAREHOUSE_OPTION_SELECTOR = 'label.ant-checkbox-wrapper:not(.checkbox_all)';

/**
 * Waits for the order list to finish reloading after a filter change.
 *
 * This list is XHR-driven, so a fixed sleep after clicking a filter is a race.
 * Losing it is not loud — the rows from the PREVIOUS filter are still in the
 * DOM, and the row collector below happily accumulates them. Confirmed live
 * 2026-09-11: a scan taken too soon after switching the store filter back to
 * ทั้งหมด returned 81 rows for a 1,619-order warehouse, 61 of which were the
 * previous filter's leftovers, and stopped at "page 1 of 1" because the
 * pagination bar had not re-rendered either.
 *
 * Scrolls back to the top as well, since the collector reads from the current
 * scroll position outward.
 */
export async function waitForListSettled(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => undefined);
  await page.evaluate(() => window.scrollTo(0, 0)).catch(() => undefined);
  await page.waitForTimeout(1200);
}

/**
 * Leaves exactly `names` checked in the คลังสินค้า filter (pass 'all' for the
 * master checkbox), then VERIFIES the result and throws if it doesn't match.
 *
 * The verification is not defensive padding — it is the safety property that
 * makes warehouse-scoped scanning trustworthy. Callers stamp every scanned row
 * with the warehouse they believe they filtered to, and that stamp is what the
 * STOCK_5-only guardrail decides on. A filter click that silently failed would
 * therefore label non-STOCK_5 orders as STOCK_5 and clear them for
 * confirmation — the exact mistake the guardrail exists to prevent. Better to
 * abort the cycle than to scan an unknown scope.
 */
export async function setWarehouseFilter(page: Page, names: string[] | 'all'): Promise<void> {
  const row = warehouseFilterRow(page);
  await dismissOrderPageOverlays(page);

  const master = row.locator('label.checkbox_all');
  const masterChecked = await master
    .evaluate((el) => el.className.includes('ant-checkbox-wrapper-checked'))
    .catch(() => false);

  if (names === 'all') {
    if (!masterChecked) {
      await clickThroughGuide(page, master, { timeout: 5000 });
      await page.waitForTimeout(1500);
    }
    return;
  }

  // Clicking the checked master clears the whole group, giving a known-empty
  // starting point instead of toggling options one by one from an unknown state.
  if (masterChecked) {
    await clickThroughGuide(page, master, { timeout: 5000 });
    await page.waitForTimeout(1200);
  }

  // Reconcile in BOTH directions. Only checking the wanted boxes is not enough:
  // when this is called again from an already-filtered state (the engine scans
  // STOCK_5, then each misplaced warehouse in turn) the previous selection is
  // still checked and the scope silently becomes the union of the two.
  // Caught live 2026-09-10 by this function's own verification, which reported
  // "wanted exactly [Test01], page reports [STOCK_5, Test01]".
  //
  // Options are matched by EXACT parsed name, never `hasText`: a substring
  // match on "STOCK_1" also matches "STOCK_12 คลังของคืน", "STOCK_13 FBS" and
  // "STOCK_14". Indices line up 1:1 with WAREHOUSE_OPTION_SELECTOR, which
  // excludes the master the same way readWarehouseFilterOptions does.
  const available = await readWarehouseFilterOptions(page);
  for (const name of names) {
    if (!available.some((option) => option.name === name)) {
      throw new Error(`No warehouse filter option matching "${name}" — available: ${available.map((o) => o.name).join(', ')}`);
    }
  }

  const labels = row.locator(WAREHOUSE_OPTION_SELECTOR);
  for (const [index, option] of available.entries()) {
    if (option.checked === names.includes(option.name)) continue;
    await clickThroughGuide(page, labels.nth(index), { timeout: 5000 });
    await humanDelay(200, 500);
  }
  await waitForListSettled(page);

  const actual = (await readWarehouseFilterOptions(page)).filter((option) => option.checked).map((option) => option.name);
  const expected = [...names].sort();
  const matches = actual.length === expected.length && [...actual].sort().every((name, index) => name === expected[index]);
  if (!matches) {
    throw new Error(
      `Warehouse filter verification failed — wanted exactly [${expected.join(', ')}], page reports [${actual.join(', ')}]. ` +
        'Refusing to scan an unknown warehouse scope.',
    );
  }
  await logger.info(`wave-engine: warehouse filter set to [${actual.join(', ')}]`);
}

/**
 * The count BigSeller prints inside a filter pill, e.g. "LockStock (61)" -> 61.
 * Undefined when the pill carries no count (ทั้งหมด and อื่นๆ don't), so the
 * caller simply skips the completeness check rather than comparing to zero.
 */
export async function readFilterPillCount(page: Page, rowLabel: string, pillLabel: string): Promise<number | undefined> {
  const containerId = FILTER_ROW_CONTAINER[rowLabel];
  if (!containerId) return undefined;
  const text = await page
    .locator(containerId)
    .first()
    .locator('span.ship_item', { hasText: pillLabel })
    .first()
    .textContent()
    .catch(() => null);
  const match = (text ?? '').replace(/\s+/g, ' ').match(/\((\d[\d,]*)\)/);
  return match ? Number(match[1].replace(/,/g, '')) : undefined;
}

export interface FilterPill {
  label: string;
  /** Undefined for pills BigSeller prints without a count (ทั้งหมด, อื่นๆ). */
  count: number | undefined;
  active: boolean;
}

/**
 * Every pill in one filter row with the count BigSeller prints on it.
 *
 * This is the cheapest possible read of "what is waiting right now": the page
 * has already counted the queue by platform, store and courier, so a two
 * second read answers what an 80-second row scan would.
 */
export async function readFilterPills(page: Page, rowLabel: string): Promise<FilterPill[]> {
  const containerId = FILTER_ROW_CONTAINER[rowLabel];
  if (!containerId) return [];
  return page
    .locator(containerId)
    .first()
    .locator('span.ship_item')
    .evaluateAll((pills) =>
      pills.map((pill) => {
        const text = (pill.textContent ?? '').replace(/\s+/g, ' ').trim();
        const match = text.match(/^(.*?)\s*\((\d[\d,]*)\)$/);
        return {
          label: (match ? match[1] : text).trim(),
          count: match ? Number(match[2].replace(/,/g, '')) : undefined,
          active: pill.className.includes('ship_item_active'),
        };
      }),
    );
}

export async function selectFilterPill(page: Page, rowLabel: string, pillLabel: string, attempts = 5): Promise<void> {
  // Prefer the row's confirmed container id; fall back to the original
  // label-cell match for any row not in that map.
  const containerId = FILTER_ROW_CONTAINER[rowLabel];
  const filterRow = containerId
    ? page.locator(containerId).first()
    : page.locator('tr', { has: page.locator('td', { hasText: rowLabel }) }).first();
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    await dismissOrderPageOverlays(page);
    try {
      await clickThroughGuide(page, filterRow.locator('span.ship_item', { hasText: pillLabel }).first(), { timeout: 3000 });
      await waitForListSettled(page);
      await dismissOrderPageOverlays(page);
      // Read the selection back. A click that Playwright reports as successful
      // is NOT proof the filter moved — a toast can sit over the pill and eat
      // it. Confirmed live 2026-09-12: a reset to ทั้งหมด reported success
      // while the platform row stayed on คำสั่งซื้อด้วยตนเอง, so the next scan
      // saw 68 orders instead of 1,600 and reported an empty morning.
      const active = (await readFilterPills(page, rowLabel)).find((pill) => pill.active);
      if (active && active.label === pillLabel) return;
      lastError = new Error(
        `clicked "${pillLabel}" but the "${rowLabel}" row now reads "${active?.label ?? '(nothing active)'}"`,
      );
      await humanDelay(300, 700);
      continue;
    } catch (error) {
      lastError = error;
      await humanDelay(300, 700);
    }
  }
  throw new Error(
    `Could not click "${pillLabel}" in the "${rowLabel}" filter row after ${attempts} attempts. Last error: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}
