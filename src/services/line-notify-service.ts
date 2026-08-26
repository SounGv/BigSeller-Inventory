import { SheetsClient } from '../sheets/sheets-client.js';
import type { TransferNotificationLogRow } from '../types.js';
import { logger } from '../utils/logger.js';

const LINE_PUSH_URL = 'https://api.line.me/v2/bot/message/push';
const SHEET_TRANSFER_NOTIFICATION_LOG = process.env.SHEET_TRANSFER_NOTIFICATION_LOG ?? 'TRANSFER_NOTIFICATION_LOG';
// Real LINE text-message cap is 5000 chars; stay under it with margin for
// count/rounding differences between our length check and LINE's own.
const LINE_MESSAGE_SOFT_LIMIT = 4500;
// One LINE push call accepts at most 5 message objects.
const LINE_MAX_MESSAGES_PER_PUSH = 5;

const NOTIFICATION_LOG_HEADERS = [
  'runId', 'timestamp', 'billCount', 'skuCount', 'moveRowCount', 'totalMoveQty', 'lineStatus', 'lineRequestId', 'errorMessage',
] as const;

export type Priority = 1 | 2 | 3 | 4;

export interface DocumentInfo {
  documentNumber: string;
  zone: string;
  /** Highest avgDailySales among this document's SKUs — the ranking signal for priority. 0 when sales data wasn't available. */
  score: number;
}

export interface TransferBillCreatedInput {
  runId: string;
  /** Human-readable run time, e.g. "25 ส.ค. 2569 12:05" — NOT the raw runId code. */
  runDateTime: string;
  warehouse: string;
  skuCount: number;
  moveRowCount: number;
  totalMoveQty: number;
  documents: DocumentInfo[];
}

const PRIORITY_LABELS: Record<Priority, string> = {
  1: '🔴 P1 ขายดีมาก ทำก่อน',
  2: '🟡 P2 ขายดี ทำถัดไป',
  3: '⚪ P3 มียอดขาย ทำตามคิว',
  4: '⚫ P4 ไม่มียอดขาย ทำหลัง',
};

/**
 * One notification per runId (not per transfer document) — a single
 * import:moves run against a full sync typically creates dozens of separate
 * transfer documents (one per zone file), and pinging everyone in the group
 * once per document would spam a 16-person group dozens of times per run.
 * Confirmed with the user (2026-08-25) this aggregate-per-run shape is what's
 * wanted; the per-document template some drafts assumed doesn't hold once a
 * real run spans more than one zone.
 *
 * Never throws — a failed notification must not make `import:moves` itself
 * report failure, since the transfer documents it's reporting on are already
 * real and already created by the time this runs.
 */
export async function notifyTransferBillCreated(sheetsClient: SheetsClient, input: TransferBillCreatedInput): Promise<void> {
  if ((process.env.LINE_NOTIFY_ENABLED ?? 'false').toLowerCase() !== 'true') {
    await logger.info(`notifyTransferBillCreated: LINE_NOTIFY_ENABLED is not true — skipping notification for runId ${input.runId}.`);
    return;
  }

  const alreadyNotified = await hasAlreadyNotified(sheetsClient, input.runId);
  if (alreadyNotified) {
    await logger.info(`notifyTransferBillCreated: runId ${input.runId} was already notified — skipping duplicate.`);
    return;
  }

  const messages = buildMessages(input);
  const result = await sendLineGroupMessages(messages);

  await appendNotificationLog(sheetsClient, {
    runId: input.runId,
    timestamp: new Date().toISOString(),
    billCount: input.documents.length,
    skuCount: input.skuCount,
    moveRowCount: input.moveRowCount,
    totalMoveQty: input.totalMoveQty,
    lineStatus: result.ok ? 'success' : 'failed',
    lineRequestId: result.requestId ?? '',
    errorMessage: result.ok ? '' : result.errorMessage,
  });

  if (!result.ok) {
    await logger.error(`notifyTransferBillCreated: LINE send failed for runId ${input.runId}: ${result.errorMessage}`);
    await sendAdminFailureAlert(input, result.errorMessage);
  } else {
    await logger.info(`notifyTransferBillCreated: sent notification for runId ${input.runId} (${messages.length} message(s), lineRequestId=${result.requestId})`);
  }
}

/**
 * Ranks documents by `score` (highest sales velocity SKU first) into 4
 * priority tiers — per user request (2026-08-25), refined the same day after
 * the user gave exact semantics for each tier rather than an arbitrary
 * quartile split: "P1 = ขายดีมาก ทำก่อน, P2 = ขายดี ทำถัดไป, P3 = มียอดขาย
 * ทำตามคิว, P4 = ไม่มียอดขาย ทำหลัง". That means P4 must be an EXACT threshold
 * (score === 0, i.e. genuinely no sales) rather than "whichever quarter
 * ranks lowest" — a plain quartile split (the original implementation) could
 * mislabel a zero-sales document as "ขายดี" whenever most of a run's
 * documents happened to have no sales data, which is a real risk given
 * sales data isn't available for every SKU every run.
 *
 * So: documents with score === 0 always land in P4, regardless of how many
 * there are. The remaining documents (score > 0) are ranked and split into
 * 3 even groups for P1/P2/P3 — still proportional/self-adjusting like the
 * original approach, just scoped to only the documents a ranking is
 * actually meaningful for.
 */
export function assignPriorities(documents: DocumentInfo[]): Map<string, Priority> {
  const map = new Map<string, Priority>();
  const withSales = documents.filter((d) => d.score > 0).sort((a, b) => b.score - a.score);
  const n = withSales.length;
  withSales.forEach((doc, i) => {
    const third = n === 0 ? 0 : Math.min(2, Math.floor((i / n) * 3));
    map.set(doc.documentNumber, (third + 1) as Priority);
  });
  for (const doc of documents) {
    if (doc.score <= 0) map.set(doc.documentNumber, 4);
  }
  return map;
}

function groupByZone(documents: DocumentInfo[]): Map<string, DocumentInfo[]> {
  const groups = new Map<string, DocumentInfo[]>();
  for (const doc of documents) {
    const list = groups.get(doc.zone) ?? [];
    list.push(doc);
    groups.set(doc.zone, list);
  }
  return groups;
}

/** P1 lists each document's real BigSeller number per zone; P2-P4 only show zone + count, per user request ("ห้ามแสดงรายการ SKU ทั้งหมด", "เลขที่ใบย้ายของกลุ่ม P1" specifically). */
function buildPrioritySection(priority: Priority, documents: DocumentInfo[]): string {
  const lines = [PRIORITY_LABELS[priority]];
  if (documents.length === 0) {
    lines.push('(ไม่มีรายการ)');
    return lines.join('\n');
  }
  const byZone = groupByZone(documents);
  for (const [zone, docs] of byZone) {
    if (priority === 1) {
      lines.push(`โซน ${zone} (${docs.length} ใบ): ${docs.map((d) => d.documentNumber).join(', ')}`);
    } else {
      lines.push(`โซน ${zone} (${docs.length} ใบ)`);
    }
  }
  return lines.join('\n');
}

function buildHeaderBlock(input: TransferBillCreatedInput): string {
  const botName = process.env.LINE_BOT_NAME ?? 'GV Inventory Bot';
  return [
    '📦 แจ้งงานเติมสต็อก',
    botName,
    '',
    `รอบงาน: ${input.runDateTime}`,
    `คลังสินค้า: ${input.warehouse}`,
    '',
    'ทั้งหมด',
    `• ใบย้าย: ${input.documents.length} ใบ`,
    `• SKU: ${input.skuCount} รุ่น`,
    `• จำนวนรวม: ${input.totalMoveQty} ชิ้น`,
  ].join('\n');
}

/**
 * Builds the notification as message bubbles — normally just 1 (matching the
 * exact template the user specified), but splits into up to
 * `LINE_MAX_MESSAGES_PER_PUSH` bubbles if the combined text would run long
 * per user request ("ถ้ามีใบย้ายจำนวนมาก ให้แบ่งข้อความตาม Priority หรือโซน").
 * The header (totals) block is never dropped — only the grouping of priority
 * sections into bubbles changes. The "วิธีทำงาน"/link block that used to
 * close the message was cut per explicit user request (2026-08-25) — staff
 * apparently didn't need the reminder steps or link repeated every time.
 */
export function buildMessages(input: TransferBillCreatedInput): string[] {
  const priorities: Priority[] = [1, 2, 3, 4];
  const byPriority = assignPriorities(input.documents);
  const docsByPriority = new Map<Priority, DocumentInfo[]>(priorities.map((p) => [p, []]));
  for (const doc of input.documents) {
    const p = byPriority.get(doc.documentNumber) ?? 4;
    docsByPriority.get(p)!.push(doc);
  }

  const header = buildHeaderBlock(input);
  const sections = priorities.map((p) => buildPrioritySection(p, docsByPriority.get(p)!));

  const full = [header, ...sections].join('\n\n');
  if (full.length <= LINE_MESSAGE_SOFT_LIMIT) return [full];

  const bubbles = [
    [header, sections[0]].join('\n\n'), // P1 stays with the header — it's the most actionable part
    [sections[1], sections[2]].join('\n\n'),
    sections[3],
  ].filter((b) => b.trim().length > 0);

  return bubbles.slice(0, LINE_MAX_MESSAGES_PER_PUSH);
}

export interface LineSendResult {
  ok: boolean;
  requestId?: string;
  errorMessage: string;
}

/**
 * Pushes one or more plain-text bubbles to the configured group — the same
 * transport `notifyTransferBillCreated` uses for its P1-P4 breakdown, exposed
 * directly for callers (e.g. the LINE command-bot) that need to report a
 * one-off status line (an ack, a failure reason) rather than the full
 * transfer-bill template.
 */
export async function sendLineGroupMessages(texts: string[]): Promise<LineSendResult> {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  const groupId = process.env.LINE_GROUP_ID;
  if (!token || !groupId) {
    return { ok: false, errorMessage: 'LINE_CHANNEL_ACCESS_TOKEN or LINE_GROUP_ID is not set in .env' };
  }

  try {
    const res = await fetch(LINE_PUSH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ to: groupId, messages: texts.map((text) => ({ type: 'text', text })) }),
    });
    const requestId = res.headers.get('x-line-request-id') ?? undefined;
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { ok: false, requestId, errorMessage: `LINE API returned ${res.status}: ${body}` };
    }
    return { ok: true, requestId, errorMessage: '' };
  } catch (error) {
    return { ok: false, errorMessage: (error as Error).message };
  }
}

async function sendAdminFailureAlert(input: TransferBillCreatedInput, errorMessage: string): Promise<void> {
  const botName = process.env.LINE_BOT_NAME ?? 'GV Inventory Bot';
  const alertText = [
    `⚠️ ${botName}`,
    '',
    'สร้างใบย้ายสินค้าแล้ว แต่ส่งแจ้งเตือน LINE ไม่สำเร็จ',
    '',
    `รอบการทำงาน: ${input.runDateTime}`,
    `สาเหตุ: ${errorMessage}`,
  ].join('\n');
  // Best-effort only — if even the alert fails, just log it, do not throw or retry.
  await sendLineGroupMessages([alertText]).catch(() => undefined);
}

async function hasAlreadyNotified(sheetsClient: SheetsClient, runId: string): Promise<boolean> {
  const rows = await sheetsClient.readAll(SHEET_TRANSFER_NOTIFICATION_LOG).catch(() => []);
  const header = rows[0] ?? [];
  const runIdIdx = header.indexOf('runId');
  const statusIdx = header.indexOf('lineStatus');
  if (runIdIdx === -1 || statusIdx === -1) return false;
  return rows.slice(1).some((row) => row[runIdIdx] === runId && row[statusIdx] === 'success');
}

async function appendNotificationLog(sheetsClient: SheetsClient, row: TransferNotificationLogRow): Promise<void> {
  await sheetsClient.appendRows(SHEET_TRANSFER_NOTIFICATION_LOG, [NOTIFICATION_LOG_HEADERS.map((h) => row[h])]);
}
