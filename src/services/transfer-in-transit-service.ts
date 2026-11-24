import type { Page } from '@playwright/test';
import { BigSellerTransferPage, TRANSFER_URL } from '../bigseller/transfer-page.js';
import { ensureSessionValid } from '../bigseller/auth.js';
import { SheetsClient } from '../sheets/sheets-client.js';
import { logger } from '../utils/logger.js';

const SHEET_TRANSFER_IN_TRANSIT = process.env.SHEET_TRANSFER_IN_TRANSIT ?? 'DB_TRANSFER_IN_TRANSIT';
const HEADERS = [
  'transferNo', 'sourceWarehouse', 'destWarehouse', 'bigsellerCreatedAt', 'estimatedArrival',
  'skuCount', 'qtyTotal', 'note', 'sourceUrl', 'receivedStatus', 'receivedAt',
  'shelvedStatus', 'shelvedBy', 'shelvedAt', 'updatedAt',
] as const;

/**
 * Syncs FEATURE-dashboard-home-page.md section 1b: transfers currently
 * sitting in BigSeller's "ระหว่างทาง" (in-transit) tab.
 *
 * Moved from Supabase to Google Sheets (2026-11-09) — the Supabase project
 * this wrote to was deleted (free-tier storage limit) with no replacement
 * backend decided yet. This sheet carries the same `shelvedStatus`/
 * `shelvedBy`/`shelvedAt` manual overlay the Supabase table had (set by staff
 * through the GV Ops Console UI — that UI itself still needs its own update
 * to write here instead of to Supabase; out of scope for this sync). Unlike
 * Supabase's upsert, `SheetsClient.upsertRows` rewrites every column of a
 * row it touches, which would blank out that overlay on every sync — so
 * this reads the sheet's current `shelvedStatus`/`shelvedBy`/`shelvedAt` (and
 * `receivedAt`) BEFORE building each row's new values, and always carries
 * them forward unchanged. Never write those four columns from scraped data.
 *
 * "Received" has no staff attribution (see FEATURE-dashboard-home-page.md,
 * "การอ้างอิงตัวผู้ทำงาน" round 4) — it's detected purely by a transfer
 * disappearing from the in-transit tab between two sync runs, never through
 * a checklist our staff fill in.
 */
export async function syncTransferInTransit(page: Page, sheetsClient: SheetsClient): Promise<void> {
  const start = Date.now();
  await ensureSessionValid(page, TRANSFER_URL);

  const transferPage = new BigSellerTransferPage(page);
  await transferPage.goto();
  const currentRows = await transferPage.fetchInTransitRows();

  await logger.info(`syncTransferInTransit: ${currentRows.length} transfer(s) currently in-transit`);

  const existingRows = await sheetsClient.readAll(SHEET_TRANSFER_IN_TRANSIT).catch(() => []);
  const existingHeader = existingRows[0] ?? [];
  const existingByTransferNo = new Map<string, Record<string, string>>();
  for (const row of existingRows.slice(1)) {
    const record: Record<string, string> = {};
    existingHeader.forEach((h, i) => { record[h] = row[i] ?? ''; });
    if (record.transferNo) existingByTransferNo.set(record.transferNo, record);
  }

  const now = new Date().toISOString();
  const freshTransferNos = new Set(currentRows.map((r) => r.transferNo));

  const freshUpdates = currentRows.map((r) => {
    const existing = existingByTransferNo.get(r.transferNo);
    return {
      transferNo: r.transferNo,
      sourceWarehouse: r.sourceWarehouse,
      destWarehouse: r.destWarehouse,
      bigsellerCreatedAt: r.bigsellerCreatedAt,
      estimatedArrival: r.estimatedArrival,
      skuCount: r.skuCount,
      qtyTotal: r.qtyTotal,
      note: r.note,
      sourceUrl: r.sourceUrl,
      receivedStatus: 'false',
      receivedAt: existing?.receivedAt ?? '',
      shelvedStatus: existing?.shelvedStatus ?? '',
      shelvedBy: existing?.shelvedBy ?? '',
      shelvedAt: existing?.shelvedAt ?? '',
      updatedAt: now,
    };
  });

  // Previously open (receivedStatus === 'false') but missing from this fresh
  // scrape -> it left BigSeller's "ระหว่างทาง" tab since the last sync, which
  // only happens when the destination warehouse clicks "received" (Stock-In).
  // Re-submits the transfer's last-known data (it's no longer scraped, so
  // there is nothing fresh to use) with receivedStatus flipped.
  const justReceived: Record<string, string | number>[] = [];
  for (const [transferNo, existing] of existingByTransferNo) {
    if (existing.receivedStatus === 'false' && !freshTransferNos.has(transferNo)) {
      justReceived.push({ ...existing, receivedStatus: 'true', receivedAt: now, updatedAt: now });
    }
  }

  await sheetsClient.upsertRows(
    SHEET_TRANSFER_IN_TRANSIT,
    [...freshUpdates, ...justReceived],
    { headers: [...HEADERS], keyColumns: ['transferNo'] },
  );

  await logger.info(
    `syncTransferInTransit: ${justReceived.length} transfer(s) newly detected as received, done in ${Date.now() - start}ms`,
  );
}
