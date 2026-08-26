import 'dotenv/config';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { SheetsClient } from '../src/sheets/sheets-client.js';
import { runFullTransferPipeline } from '../src/services/transfer-command-service.js';
import { sendLineGroupMessages } from '../src/services/line-notify-service.js';
import { logger } from '../src/utils/logger.js';

const PORT = Number(process.env.LINE_COMMAND_BOT_PORT ?? 3001);
const CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;
const CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const GROUP_ID = process.env.LINE_GROUP_ID;
const BOT_NAME = process.env.LINE_BOT_NAME ?? 'GV Inventory Bot';
const ALLOWED_USER_IDS = new Set(
  (process.env.LINE_COMMAND_ALLOWED_USER_IDS ?? '').split(',').map((id) => id.trim()).filter(Boolean),
);
// Any of these substrings in the (mention-stripped) message text counts as
// "create the transfer bill" — kept loose since this is the only command the
// bot understands right now. A tag with no recognized keyword gets a help
// reply instead of silently doing nothing.
const TRIGGER_KEYWORDS = ['สร้างใบย้าย', 'ทำใบย้าย', 'ย้ายสินค้า', 'ใบย้าย'];

const LINE_REPLY_URL = 'https://api.line.me/v2/bot/message/reply';

/**
 * Lets whitelisted staff trigger the full sync -> validate -> plan -> export
 * -> validate -> import pipeline either by tagging the bot in the LINE group,
 * or by messaging it 1:1 (per follow-up request 2026-08-26: "ถ้าคนที่จะสั่งงาน
 * แอดทักแชทมาสั่ง แทนละ" — a direct chat needs no @mention and the sender must
 * already have added the bot as a LINE friend for that event to exist at
 * all). Either way the "รับคำสั่งแล้ว รอสักครู่" ack goes back to whichever chat
 * the command came from, but the completion report always goes to the group
 * (LINE_GROUP_ID) — per the original request: "ทำเสร็จแจ้งกลับในกลุ่ม". Deliberately runs the
 * ENTIRE pipeline through to a real BigSeller import with no further
 * confirmation step — the user chose this over a review-then-confirm flow
 * when asked directly. AUTO_IMPORT=true is still required as a second gate
 * (see runFullTransferPipeline) — this bot alone flipping to "live" isn't
 * enough on its own.
 *
 * This process must stay running continuously with a public HTTPS URL
 * pointed at it from the LINE Developers Console (webhook URL) for LINE to
 * ever reach it — see the deployment notes this was handed over with.
 */
if (!CHANNEL_SECRET || !CHANNEL_ACCESS_TOKEN || !GROUP_ID) {
  console.error('[FATAL] LINE_CHANNEL_SECRET, LINE_CHANNEL_ACCESS_TOKEN, and LINE_GROUP_ID must all be set in .env before starting this bot.');
  process.exit(1);
}
if (ALLOWED_USER_IDS.size === 0) {
  console.error('[FATAL] LINE_COMMAND_ALLOWED_USER_IDS is empty — no one would be authorized to trigger anything. Set at least one LINE userId.');
  process.exit(1);
}

let pipelineInFlight = false;

function isValidSignature(rawBody: string, signatureHeader: string | undefined): boolean {
  if (!signatureHeader) return false;
  const expected = createHmac('sha256', CHANNEL_SECRET!).update(rawBody).digest('base64');
  const a = Buffer.from(expected);
  const b = Buffer.from(signatureHeader);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function replyText(replyToken: string, text: string): Promise<void> {
  await fetch(LINE_REPLY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}` },
    body: JSON.stringify({ replyToken, messages: [{ type: 'text', text }] }),
  }).catch((error) => logger.error(`replyText failed: ${(error as Error).message}`));
}

function isMentioningSelf(message: { text: string; mention?: { mentionees?: { isSelf?: boolean }[] } }): boolean {
  if (message.mention?.mentionees?.some((m) => m.isSelf)) return true;
  // Fallback for setups where the LINE mention object isn't present (e.g. a
  // plain "@GV Inventory Bot" typed as text rather than picked from LINE's
  // own mention autocomplete) — confirm live once deployed which path real
  // messages actually take.
  return message.text.includes(BOT_NAME);
}

function matchesTriggerKeyword(text: string): boolean {
  return TRIGGER_KEYWORDS.some((kw) => text.includes(kw));
}

async function runPipelineAndReport(): Promise<void> {
  if (pipelineInFlight) return; // guarded by caller, but stay safe if called twice
  pipelineInFlight = true;
  try {
    const sheetsClient = await SheetsClient.create();
    const outcome = await runFullTransferPipeline(sheetsClient);
    await logger.info(`line-command-bot: pipeline outcome — ${JSON.stringify(outcome)}`);

    // The success-with-documents case already pushed the full P1-P4
    // breakdown from inside runFullTransferPipeline (via
    // notifyTransferBillCreated) — every other outcome (gate refused, a
    // phase failed, or nothing needed replenishing) has no message yet and
    // needs one here so staff aren't left guessing what happened.
    if (!(outcome.ok && outcome.succeededFiles && outcome.succeededFiles > 0)) {
      const lines = [`🤖 ${BOT_NAME}`, ''];
      if (outcome.ok) {
        lines.push(outcome.message);
      } else {
        lines.push('❌ สร้างใบย้ายไม่สำเร็จ');
        if (outcome.runId) lines.push(`runId: ${outcome.runId}`);
        lines.push(`สาเหตุ: ${outcome.message}`);
      }
      await sendLineGroupMessages([lines.join('\n')]);
    }
  } catch (error) {
    await logger.error(`line-command-bot: unhandled pipeline error: ${(error as Error).message}`);
    await sendLineGroupMessages([`🤖 ${BOT_NAME}\n\n❌ เกิดข้อผิดพลาดที่ไม่คาดคิดระหว่างสร้างใบย้าย: ${(error as Error).message}`]).catch(() => undefined);
  } finally {
    pipelineInFlight = false;
  }
}

const server = createServer((req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(200);
    res.end('ok');
    return;
  }

  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', async () => {
    if (!isValidSignature(body, req.headers['x-line-signature'] as string | undefined)) {
      logger.error('[REJECTED] X-Line-Signature did not match — this request did not come from LINE.').catch(() => undefined);
      res.writeHead(401);
      res.end('invalid signature');
      return;
    }

    // LINE requires a fast 200 regardless of what the events contain —
    // acknowledge first, handle events after.
    res.writeHead(200);
    res.end('ok');

    let parsed: { events?: unknown[] };
    try {
      parsed = JSON.parse(body);
    } catch {
      return;
    }

    for (const event of (parsed.events ?? []) as any[]) {
      if (event.type !== 'message' || event.message?.type !== 'text') continue;

      const isTargetGroup = event.source?.type === 'group' && event.source.groupId === GROUP_ID;
      // A 1:1 DM to the bot is inherently "addressed to it" — there's no
      // @mention concept in a direct chat, and the staff member must already
      // have added the bot as a LINE friend for this event to exist at all.
      const isDirectMessage = event.source?.type === 'user';
      if (!isTargetGroup && !isDirectMessage) continue;
      if (isTargetGroup && !isMentioningSelf(event.message)) continue;

      const replyToken: string = event.replyToken;
      const userId: string | undefined = event.source.userId;

      if (!userId || !ALLOWED_USER_IDS.has(userId)) {
        await logger.info(`line-command-bot: ignored command from non-whitelisted userId ${userId ?? '(unknown)'}`);
        await replyText(replyToken, `ขออภัยครับ คุณไม่มีสิทธิ์สั่งงานนี้ — ติดต่อแอดมินหากต้องการสิทธิ์`);
        continue;
      }

      if (!matchesTriggerKeyword(event.message.text)) {
        await replyText(replyToken, `พิมพ์ "@${BOT_NAME} สร้างใบย้าย" เพื่อสั่งให้ระบบสร้างใบย้ายสินค้าครับ`);
        continue;
      }

      if (pipelineInFlight) {
        await replyText(replyToken, 'มีการสร้างใบย้ายกำลังทำงานอยู่ในขณะนี้ กรุณารอให้รอบนี้เสร็จก่อนสั่งใหม่ครับ');
        continue;
      }

      await replyText(replyToken, `รับคำสั่งแล้วครับ กำลังสร้างใบย้ายสินค้า รอสักครู่นะครับ 🙏\nจะแจ้งผลกลับในกลุ่มเมื่อเสร็จ`);
      void runPipelineAndReport();
    }
  });
});

server.listen(PORT, () => {
  console.log(`LINE command-bot listening on http://localhost:${PORT}`);
  console.log(`Whitelisted userIds: ${ALLOWED_USER_IDS.size}`);
  console.log('Point your LINE channel\'s webhook URL (LINE Developers Console) at this server\'s public HTTPS address.');
});
