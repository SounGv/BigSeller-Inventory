import { SheetsClient } from '../sheets/sheets-client.js';
import type { DocumentInfo } from './line-notify-service.js';
import { sendLineGroupMessageWithQuickReply } from './line-notify-service.js';
import type { TransferTrackingRow } from '../types.js';
import { logger } from '../utils/logger.js';

const SHEET_TRANSFER_TRACKING = process.env.SHEET_TRANSFER_TRACKING ?? 'DB_TRANSFER_TRACKING';

const TRANSFER_TRACKING_HEADERS = [
  'runId', 'documentNumber', 'sourcePosition', 'trackDecision', 'status', 'createdAt', 'lastCheckedAt', 'completedAt',
] as const;

/**
 * Per explicit user request (2026-11-19): right after a batch of transfer
 * documents is created, ask staff (via a LINE quick-reply prompt, see
 * {@link sendTrackingPrompt}) whether they want this run's documents
 * followed up on automatically. This writes one row per document with
 * `trackDecision: 'pending'` BEFORE that prompt is sent, regardless of what
 * staff answers — so a late or missed reply still leaves a real record
 * (just never promoted to 'yes', so transfer-status-check-service.ts's
 * query ignores it), instead of the document numbers only ever existing in
 * memory for the one process that created them.
 *
 * `status` starts as 'รอนำเข้า' — the real status BigSeller always gives a
 * document the instant after `importZoneFile()` succeeds (confirmed live,
 * see moving-goods-page.ts's class doc comment) — rather than null/unknown,
 * so a check that runs before staff even answers the prompt still has a
 * sensible starting point to diff against.
 */
export async function recordPendingDocuments(sheetsClient: SheetsClient, runId: string, documents: DocumentInfo[]): Promise<void> {
  if (documents.length === 0) return;
  const createdAt = new Date().toISOString();
  const rows: TransferTrackingRow[] = documents.map((d) => ({
    runId,
    documentNumber: d.documentNumber,
    sourcePosition: d.zone,
    trackDecision: 'pending',
    status: 'รอนำเข้า',
    createdAt,
    lastCheckedAt: '',
    completedAt: '',
  }));
  await sheetsClient.upsertRows(
    SHEET_TRANSFER_TRACKING,
    rows.map((r) => ({ ...r, key: `${r.runId}::${r.documentNumber}` })),
    { headers: [...TRANSFER_TRACKING_HEADERS], keyColumns: ['runId', 'documentNumber'] },
  );
  await logger.info(`recordPendingDocuments: recorded ${rows.length} document(s) for runId ${runId}, trackDecision=pending`);
}

/**
 * Sends the "ติดตามใบย้ายนี้ไหม" quick-reply prompt for a just-created run.
 * A tapped button sends its `text` back as a plain message — handled in
 * `scripts/line-command-bot.ts` by matching `ติดตามใบย้าย <runId>` /
 * `ไม่ติดตามใบย้าย <runId>` — which calls {@link applyTrackDecision} below.
 *
 * Skipped (not an error) when LINE_NOTIFY_ENABLED isn't true, same gate
 * `notifyTransferBillCreated` uses — no point prompting for updates through
 * a channel that's off.
 */
export async function sendTrackingPrompt(runId: string, documentCount: number): Promise<void> {
  if ((process.env.LINE_NOTIFY_ENABLED ?? 'false').toLowerCase() !== 'true') {
    await logger.info(`sendTrackingPrompt: LINE_NOTIFY_ENABLED is not true — skipping prompt for runId ${runId}.`);
    return;
  }
  const text = `ต้องการให้ติดตามใบย้าย ${documentCount} ใบนี้ไหมครับ — ถ้าติดตาม ระบบจะเช็คสถานะให้เป็นระยะแล้วแจ้งกลับว่าใบไหนเสร็จแล้ว ใบไหนยังค้าง`;
  const result = await sendLineGroupMessageWithQuickReply(text, [
    { label: 'ติดตาม', text: `ติดตามใบย้าย ${runId}` },
    { label: 'ไม่ติดตาม', text: `ไม่ติดตามใบย้าย ${runId}` },
  ]);
  if (!result.ok) {
    await logger.error(`sendTrackingPrompt: LINE send failed for runId ${runId}: ${result.errorMessage}`);
  }
}

export interface ApplyTrackDecisionResult {
  runId: string;
  decision: 'yes' | 'no';
  documentCount: number;
}

/**
 * Called from the LINE webhook when staff taps "ติดตาม"/"ไม่ติดตาม". Flips
 * every row recorded for `runId` (by {@link recordPendingDocuments}) from
 * 'pending' to the given decision. Returns `null` (not an error) when no
 * rows exist for that runId — e.g. a stale button tapped on an old message,
 * or the run genuinely created zero documents — so the caller can reply
 * with a plain "ไม่พบใบย้ายของ runId นี้" instead of a crash.
 */
export async function applyTrackDecision(sheetsClient: SheetsClient, runId: string, decision: 'yes' | 'no'): Promise<ApplyTrackDecisionResult | null> {
  const rows = await sheetsClient.readAll(SHEET_TRANSFER_TRACKING);
  const header = rows[0] ?? [];
  const runIdIdx = header.indexOf('runId');
  const docIdx = header.indexOf('documentNumber');
  const sourceIdx = header.indexOf('sourcePosition');
  const statusIdx = header.indexOf('status');
  const createdIdx = header.indexOf('createdAt');
  const lastCheckedIdx = header.indexOf('lastCheckedAt');
  const completedIdx = header.indexOf('completedAt');
  if ([runIdIdx, docIdx, sourceIdx, statusIdx, createdIdx, lastCheckedIdx, completedIdx].some((i) => i === -1)) return null;

  const matching = rows.slice(1).filter((row) => row[runIdIdx] === runId);
  if (matching.length === 0) return null;

  const updates: TransferTrackingRow[] = matching.map((row) => ({
    runId,
    documentNumber: row[docIdx],
    sourcePosition: row[sourceIdx],
    trackDecision: decision,
    status: (row[statusIdx] || 'รอนำเข้า') as TransferTrackingRow['status'],
    createdAt: row[createdIdx],
    lastCheckedAt: row[lastCheckedIdx] ?? '',
    completedAt: row[completedIdx] ?? '',
  }));
  await sheetsClient.upsertRows(
    SHEET_TRANSFER_TRACKING,
    updates.map((r) => ({ ...r, key: `${r.runId}::${r.documentNumber}` })),
    { headers: [...TRANSFER_TRACKING_HEADERS], keyColumns: ['runId', 'documentNumber'] },
  );
  await logger.info(`applyTrackDecision: runId ${runId} -> trackDecision=${decision} (${updates.length} document(s))`);
  return { runId, decision, documentCount: updates.length };
}
