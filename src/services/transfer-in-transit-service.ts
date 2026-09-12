import type { Page } from '@playwright/test';
import { BigSellerTransferPage, TRANSFER_URL } from '../bigseller/transfer-page.js';
import { ensureSessionValid } from '../bigseller/auth.js';
import { SupabaseDbClient } from '../db/supabase-db-client.js';
import { logger } from '../utils/logger.js';

const TABLE = 'transfer_in_transit';

/**
 * Syncs FEATURE-dashboard-home-page.md section 1b: transfers currently
 * sitting in BigSeller's "ระหว่างทาง" (in-transit) tab.
 *
 * Supabase-only (no Google Sheets write) — unlike every other sync in this
 * project, this table has a manual overlay (shelved_status/shelved_by/
 * shelved_at, set by staff through the GV Ops Console UI via the
 * mark_transfer_shelved() RPC). SheetsClient.upsertRows overwrites an
 * entire row's columns on every call, which would blank out that staff
 * input on the next sync; Supabase's upsert only touches the columns
 * actually passed in, so it's safe here and Sheets isn't.
 *
 * "Received" has no staff attribution (see FEATURE-dashboard-home-page.md,
 * "การอ้างอิงตัวผู้ทำงาน" round 4) — it's detected purely by a transfer
 * disappearing from the in-transit tab between two sync runs, never through
 * a checklist our staff fill in.
 */
export async function syncTransferInTransit(page: Page): Promise<void> {
  const start = Date.now();
  await ensureSessionValid(page, TRANSFER_URL);

  const transferPage = new BigSellerTransferPage(page);
  await transferPage.goto();
  const currentRows = await transferPage.fetchInTransitRows();

  await logger.info(`syncTransferInTransit: ${currentRows.length} transfer(s) currently in-transit`);

  const supabase = SupabaseDbClient.create();

  await supabase.upsertRows(
    TABLE,
    currentRows.map((r) => ({
      transfer_no: r.transferNo,
      source_warehouse: r.sourceWarehouse,
      dest_warehouse: r.destWarehouse,
      bigseller_created_at: r.bigsellerCreatedAt,
      estimated_arrival: r.estimatedArrival,
      sku_count: r.skuCount,
      qty_total: r.qtyTotal,
      note: r.note,
      source_url: r.sourceUrl,
      received_status: false,
      updated_at: new Date().toISOString(),
    })),
    ['transfer_no'],
  );

  // Anything we previously had marked as still-open (received_status=false)
  // that did NOT show up in this scrape has left the "ระหว่างทาง" tab since
  // the last sync — the only way that happens is the destination warehouse
  // clicked "received" (Stock-In) on it.
  const previouslyOpen = await supabase.selectWhere(TABLE, 'transfer_no', { received_status: false });
  const stillOpenNos = new Set(currentRows.map((r) => r.transferNo));
  const justReceivedNos = previouslyOpen
    .map((row) => row.transfer_no as string)
    .filter((no) => !stillOpenNos.has(no));

  await supabase.updateWhereIn(TABLE, 'transfer_no', justReceivedNos, {
    received_status: true,
    received_at: new Date().toISOString(),
  });

  await logger.info(
    `syncTransferInTransit: ${justReceivedNos.length} transfer(s) newly detected as received, done in ${Date.now() - start}ms`,
  );
}
