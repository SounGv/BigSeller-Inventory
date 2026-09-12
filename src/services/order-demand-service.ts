import type { Page } from '@playwright/test';
import { BigSellerNewOrdersPage, NEW_ORDERS_URL } from '../bigseller/new-orders-page.js';
import { ensureSessionValid } from '../bigseller/auth.js';
import { SheetsClient } from '../sheets/sheets-client.js';
import { SupabaseDbClient } from '../db/supabase-db-client.js';
import type { NewOrderLineRow, LockStatus } from '../types.js';
import { logger } from '../utils/logger.js';

const SHEET_PENDING_ORDER_DEMAND = process.env.SHEET_PENDING_ORDER_DEMAND ?? 'DB_PENDING_ORDER_DEMAND';
const SHEET_OFFLINE_LOCK = process.env.SHEET_OFFLINE_LOCK ?? 'DB_OFFLINE_LOCK';

/**
 * Exact store name confirmed live (2026-08-31) via the "ร้านค้า" filter pill
 * on order/index.htm?status=new (shown as "LockStock (47)" with no
 * surrounding whitespace or casing variation) — GV's mandatory
 * offline-stock-hold workaround, per user 2026-08-28: every employee creates
 * a fake order in this store to reserve stock, and closes/cancels it the
 * moment the item is released or actually sold.
 */
const LOCKSTOCK_STORE_NAME = 'LockStock';

const PENDING_DEMAND_HEADERS = ['sku', 'qty', 'store', 'channel', 'orderTime', 'sourceUrl'] as const;
const OFFLINE_LOCK_HEADERS = ['sku', 'qty', 'lockOrderNo', 'lockStatus', 'orderTime', 'sourceUrl'] as const;

/**
 * Checked live 2026-08-31 against all 47 real LockStock orders on the
 * account at the time: NONE contained this word anywhere in their buyer/
 * recipient field or order number — every one classified as `confirmed`
 * under the rule below. That is the spec'd, intentional fallback (not a
 * bug) — see FEATURE-pending-demand-and-offline-lock.md — but it does mean
 * this sync has never yet actually produced a `pending_confirm` row on real
 * data. If that keeps being true once real "จองรอลูกค้าคอนเฟิร์ม" holds show
 * up in practice, the actual distinguishing signal may not be this literal
 * word — worth asking the warehouse team directly rather than assuming this
 * regex is complete.
 */
const PENDING_CONFIRM_MARKER = /รอคอนเฟิร์ม/;

function classifyLockStatus(row: NewOrderLineRow): LockStatus {
  return PENDING_CONFIRM_MARKER.test(row.buyerOrLabel) || PENDING_CONFIRM_MARKER.test(row.orderNo)
    ? 'pending_confirm'
    : 'confirmed';
}

/**
 * Scrapes `order/index.htm?status=new` and splits every SKU line into two
 * current-state sheets: DB_OFFLINE_LOCK (store === LockStock) and
 * DB_PENDING_ORDER_DEMAND (every other store/channel).
 *
 * The store-name split is done by ORDER-NUMBER MEMBERSHIP, not by reading a
 * per-row store-name cell — the "ร้านค้า" filter is single-select (confirmed
 * live: selecting one store pill replaces whichever was active, with no
 * confirmed way to select "every store except LockStock" in one filter
 * state), so this scrapes twice: once filtered to LockStock, once
 * unfiltered, and treats any order number seen in the LockStock pass as
 * excluded from the pending-demand set. See {@link BigSellerNewOrdersPage}
 * for the full page-structure notes.
 *
 * Both sheets are REPLACED (not upserted/appended) every run — they must
 * reflect current state at sync time, so a closed/confirmed order
 * disappears automatically on the next sync (see SheetsClient.replaceAll).
 */
export async function syncOrderDemand(page: Page, sheetsClient: SheetsClient, runId: string): Promise<void> {
  await ensureSessionValid(page, NEW_ORDERS_URL);

  const ordersPage = new BigSellerNewOrdersPage(page);
  await ordersPage.goto();

  await ordersPage.selectStoreFilter(LOCKSTOCK_STORE_NAME);
  const lockRows = await ordersPage.scrapeCurrentFilterRows(LOCKSTOCK_STORE_NAME);

  await ordersPage.selectStoreFilter('ทั้งหมด');
  const allRows = await ordersPage.scrapeCurrentFilterRows('');

  // Joined on `orderId` (BigSeller's own internal numeric id), not the
  // human-typed `orderNo` — guaranteed unique/stable, see NewOrderLineRow.
  const lockOrderIds = new Set(lockRows.map((r) => r.orderId));
  const pendingRows = allRows.filter((r) => !lockOrderIds.has(r.orderId));

  await logger.info(
    `syncOrderDemand: ${lockRows.length} LockStock line(s) across ${lockOrderIds.size} order(s), ${pendingRows.length} pending-demand line(s)`,
  );

  await sheetsClient.replaceAll(
    SHEET_PENDING_ORDER_DEMAND,
    [...PENDING_DEMAND_HEADERS],
    pendingRows.map((r) => ({
      sku: r.sku,
      qty: r.qty,
      store: r.store,
      channel: r.platform,
      orderTime: r.orderTime,
      sourceUrl: r.sourceUrl,
    })),
  );

  await sheetsClient.replaceAll(
    SHEET_OFFLINE_LOCK,
    [...OFFLINE_LOCK_HEADERS],
    lockRows.map((r) => ({
      sku: r.sku,
      qty: r.qty,
      lockOrderNo: r.orderNo,
      lockStatus: classifyLockStatus(r),
      orderTime: r.orderTime,
      sourceUrl: r.sourceUrl,
    })),
  );

  await dualWriteToSupabase(pendingRows, lockRows);

  void runId; // kept in the signature to match every other sync*() function's shape in this project, even though these two sheets don't stamp it (see SheetsClient.replaceAll doc comment — they hold current state, not a per-run history)
}

/**
 * Dual-write to Supabase alongside the Sheets writes above, per
 * FEATURE-web-dashboard-supabase.md's transition plan — Sheets stays the
 * source of truth for now (this project's LINE bot/transfer pipeline reads
 * from Sheets only), Supabase is an additional target for the GV Ops Console
 * dashboard to read from. OPTIONAL: skips silently (info log, not an error)
 * if SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY aren't set yet, so this never
 * blocks the existing pipeline for anyone who hasn't set up Supabase.
 *
 * Column names are snake_case to match the actual Postgres schema (applied
 * 2026-09-01 via the Supabase MCP) — camelCase Sheets field names are mapped
 * here, not renamed at the source, since SheetsClient's own headers must stay
 * matched to what's already in the live spreadsheet.
 */
async function dualWriteToSupabase(pendingRows: NewOrderLineRow[], lockRows: NewOrderLineRow[]): Promise<void> {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    await logger.info('dualWriteToSupabase: SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY not set — skipping Supabase write (Sheets-only for now)');
    return;
  }

  const supabase = SupabaseDbClient.create();
  await supabase.replaceAll(
    'pending_order_demand',
    pendingRows.map((r) => ({
      sku: r.sku,
      qty: r.qty,
      store: r.store,
      channel: r.platform,
      order_time: r.orderTime,
      source_url: r.sourceUrl,
    })),
  );
  await supabase.replaceAll(
    'offline_lock',
    lockRows.map((r) => ({
      sku: r.sku,
      qty: r.qty,
      lock_order_no: r.orderNo,
      lock_status: classifyLockStatus(r),
      order_time: r.orderTime,
      source_url: r.sourceUrl,
    })),
  );
}
