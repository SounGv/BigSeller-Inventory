import type { Page } from '@playwright/test';
import { SheetsClient } from '../sheets/sheets-client.js';
import { BigSellerMovingGoodsPage, TERMINAL_MOVE_STATUSES } from '../bigseller/moving-goods-page.js';
import { sendLineGroupMessages } from './line-notify-service.js';
import type { TransferTrackingRow, MoveDocumentStatus } from '../types.js';
import { logger } from '../utils/logger.js';
import { humanDelay } from '../utils/human-delay.js';

const SHEET_TRANSFER_TRACKING = process.env.SHEET_TRANSFER_TRACKING ?? 'DB_TRANSFER_TRACKING';
const TRANSFER_TRACKING_HEADERS = [
  'runId', 'documentNumber', 'sourcePosition', 'trackDecision', 'status', 'createdAt', 'lastCheckedAt', 'completedAt',
] as const;

/** A document still in a non-terminal state this long after creation is worth flagging even with no status change. Default 4h — override with STUCK_THRESHOLD_HOURS. */
const STUCK_THRESHOLD_HOURS = Number(process.env.STUCK_THRESHOLD_HOURS ?? 4);

interface TrackedRow extends TransferTrackingRow {
  rowNumber: number; // 1-indexed sheet row, header = row 1 — not currently used for a targeted write (upsertRows matches by key instead), kept for future targeted operations.
}

function parseTrackedRows(sheetRows: string[][]): TrackedRow[] {
  if (sheetRows.length === 0) return [];
  const header = sheetRows[0];
  const col = (name: string) => header.indexOf(name);
  const idx = {
    runId: col('runId'), documentNumber: col('documentNumber'), sourcePosition: col('sourcePosition'),
    trackDecision: col('trackDecision'), status: col('status'), createdAt: col('createdAt'),
    lastCheckedAt: col('lastCheckedAt'), completedAt: col('completedAt'),
  };
  if (Object.values(idx).some((i) => i === -1)) return [];

  return sheetRows.slice(1).map((row, i) => ({
    runId: row[idx.runId],
    documentNumber: row[idx.documentNumber],
    sourcePosition: row[idx.sourcePosition],
    trackDecision: row[idx.trackDecision] as TransferTrackingRow['trackDecision'],
    status: (row[idx.status] || 'ไม่ทราบ') as MoveDocumentStatus,
    createdAt: row[idx.createdAt],
    lastCheckedAt: row[idx.lastCheckedAt],
    completedAt: row[idx.completedAt],
    rowNumber: i + 2,
  }));
}

export interface CheckOutcome {
  checkedCount: number;
  newlyCompleted: TrackedRow[];
  newlyCancelled: TrackedRow[];
  stillStuck: TrackedRow[];
  reported: boolean;
}

export type StatusBucket = 'completed' | 'cancelled' | 'stuck' | 'none';

/**
 * Pure decision logic, pulled out of {@link checkTrackedDocuments} so it can
 * be unit-tested without a live BigSeller page: given a document's previous
 * status and its freshly-looked-up one, decide which bucket (if any) this
 * check's report should put it in.
 *
 * - 'completed' / 'cancelled': the status just NOW turned terminal — a
 *   document that was ALREADY 'เสร็จเรียบร้อย' last check is filtered out
 *   before this ever runs (checkTrackedDocuments only queries non-terminal
 *   rows), so "just turned" here really means "turned since the LAST time
 *   anyone looked", not merely "is currently terminal".
 * - 'stuck': still non-terminal, and has been since before `stuckCutoffMs`
 *   relative to `now` — reported every run while this stays true, since
 *   the point is staff knowing it is STILL not done, not just the first time.
 * - 'none': non-terminal and not yet old enough to count as stuck.
 */
export function classifyStatusUpdate(
  previousStatus: MoveDocumentStatus,
  newStatus: MoveDocumentStatus,
  createdAt: string,
  now: Date,
  stuckCutoffMs: number,
): StatusBucket {
  const justTurnedTerminal = TERMINAL_MOVE_STATUSES.has(newStatus) && newStatus !== previousStatus;
  if (newStatus === 'เสร็จเรียบร้อย' && justTurnedTerminal) return 'completed';
  if (newStatus === 'ยกเลิก' && justTurnedTerminal) return 'cancelled';
  if (TERMINAL_MOVE_STATUSES.has(newStatus)) return 'none'; // already terminal before this check somehow slipped in — nothing new to say
  const ageMs = now.getTime() - new Date(createdAt).getTime();
  return ageMs >= stuckCutoffMs ? 'stuck' : 'none';
}

/**
 * Looks up the live status of every document staff opted in to track (see
 * transfer-tracking-service.ts) that isn't already in a terminal state, and
 * reports back only when there's something worth saying — per explicit user
 * request (2026-11-19): "แจ้งผลอัพเดทไหม... ใบไหนยังค้าง", not a status ping
 * on every single scheduled run regardless of whether anything happened.
 * "Worth saying" = a document finished or got cancelled THIS check, or a
 * still-pending document has been sitting non-terminal for more than
 * {@link STUCK_THRESHOLD_HOURS} hours — reported every run while it stays
 * stuck (not just once), since the whole point is staff knowing it's still
 * not done.
 *
 * One document at a time via getStatusByMovingNo with a short delay between
 * calls — same rate-limit-avoidance convention as every other per-row
 * BigSeller API loop in this project (see e.g. cancelled-orders-page.ts).
 */
export async function checkTrackedDocuments(page: Page, sheetsClient: SheetsClient): Promise<CheckOutcome> {
  const sheetRows = await sheetsClient.readAll(SHEET_TRANSFER_TRACKING).catch(() => []);
  const tracked = parseTrackedRows(sheetRows).filter(
    (r) => r.trackDecision === 'yes' && !TERMINAL_MOVE_STATUSES.has(r.status),
  );

  if (tracked.length === 0) {
    await logger.info('checkTrackedDocuments: nothing to check (no non-terminal, opted-in documents).');
    return { checkedCount: 0, newlyCompleted: [], newlyCancelled: [], stillStuck: [], reported: false };
  }

  const movingGoodsPage = new BigSellerMovingGoodsPage(page);
  const now = new Date();
  const nowIso = now.toISOString();
  const stuckCutoffMs = STUCK_THRESHOLD_HOURS * 60 * 60 * 1000;

  const updated: TrackedRow[] = [];
  const newlyCompleted: TrackedRow[] = [];
  const newlyCancelled: TrackedRow[] = [];
  const stillStuck: TrackedRow[] = [];

  for (const row of tracked) {
    let newStatus: MoveDocumentStatus;
    try {
      newStatus = (await movingGoodsPage.getStatusByMovingNo(row.documentNumber)) ?? row.status;
    } catch (error) {
      await logger.error(`checkTrackedDocuments: lookup failed for ${row.documentNumber}: ${(error as Error).message}`);
      newStatus = row.status;
    }

    const justTurnedTerminal = TERMINAL_MOVE_STATUSES.has(newStatus) && newStatus !== row.status;
    const updatedRow: TrackedRow = {
      ...row,
      status: newStatus,
      lastCheckedAt: nowIso,
      completedAt: justTurnedTerminal ? nowIso : row.completedAt,
    };
    updated.push(updatedRow);

    const bucket = classifyStatusUpdate(row.status, newStatus, row.createdAt, now, stuckCutoffMs);
    if (bucket === 'completed') newlyCompleted.push(updatedRow);
    else if (bucket === 'cancelled') newlyCancelled.push(updatedRow);
    else if (bucket === 'stuck') stillStuck.push(updatedRow);

    await humanDelay(400, 900);
  }

  await sheetsClient.upsertRows(
    SHEET_TRANSFER_TRACKING,
    updated.map((r) => ({
      runId: r.runId, documentNumber: r.documentNumber, sourcePosition: r.sourcePosition,
      trackDecision: r.trackDecision, status: r.status, createdAt: r.createdAt,
      lastCheckedAt: r.lastCheckedAt, completedAt: r.completedAt,
      key: `${r.runId}::${r.documentNumber}`,
    })),
    { headers: [...TRANSFER_TRACKING_HEADERS], keyColumns: ['runId', 'documentNumber'] },
  );

  const reported = await reportIfNeeded(newlyCompleted, newlyCancelled, stillStuck);
  await logger.info(
    `checkTrackedDocuments: checked ${tracked.length}, completed=${newlyCompleted.length}, cancelled=${newlyCancelled.length}, stuck=${stillStuck.length}, reported=${reported}`,
  );
  return { checkedCount: tracked.length, newlyCompleted, newlyCancelled, stillStuck, reported };
}

async function reportIfNeeded(newlyCompleted: TrackedRow[], newlyCancelled: TrackedRow[], stillStuck: TrackedRow[]): Promise<boolean> {
  if (newlyCompleted.length === 0 && newlyCancelled.length === 0 && stillStuck.length === 0) return false;
  if ((process.env.LINE_NOTIFY_ENABLED ?? 'false').toLowerCase() !== 'true') return false;

  const lines: string[] = ['🤖 อัพเดทสถานะใบย้ายสินค้า', ''];
  if (newlyCompleted.length > 0) {
    lines.push(`✅ เสร็จเรียบร้อยแล้ว (${newlyCompleted.length} ใบ):`);
    lines.push(newlyCompleted.map((r) => `  ${r.documentNumber} (${r.sourcePosition})`).join('\n'));
    lines.push('');
  }
  if (newlyCancelled.length > 0) {
    lines.push(`🚫 ถูกยกเลิก (${newlyCancelled.length} ใบ):`);
    lines.push(newlyCancelled.map((r) => `  ${r.documentNumber} (${r.sourcePosition})`).join('\n'));
    lines.push('');
  }
  if (stillStuck.length > 0) {
    lines.push(`⏳ ยังค้างอยู่เกิน ${STUCK_THRESHOLD_HOURS} ชม. (${stillStuck.length} ใบ):`);
    lines.push(stillStuck.map((r) => `  ${r.documentNumber} (${r.sourcePosition}) — สถานะ: ${r.status}`).join('\n'));
  }

  const result = await sendLineGroupMessages([lines.join('\n')]);
  if (!result.ok) await logger.error(`checkTrackedDocuments: report send failed: ${result.errorMessage}`);
  return result.ok;
}
