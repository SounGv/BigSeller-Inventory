import 'dotenv/config';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';

const PORT = Number(process.env.LINE_CAPTURE_PORT ?? 3000);
const CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;
const CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;

/**
 * One-time diagnostic tool: LINE never exposes a "look up this group's ID"
 * API — the only way to learn a group's ID is to receive one real webhook
 * event from that group. This starts a local server that verifies the
 * request really came from LINE (X-Line-Signature, HMAC-SHA256 with
 * LINE_CHANNEL_SECRET) and prints `source.groupId` from any group event. See
 * docs/line-group-id.md for the full step-by-step. Stop this (Ctrl+C) once
 * you have the ID — it isn't part of the running pipeline; this project has
 * no persistent web server otherwise.
 */
function isValidSignature(rawBody: string, signatureHeader: string | undefined): boolean {
  if (!CHANNEL_SECRET) return true; // no secret configured yet — warn instead of hard-blocking, see below
  if (!signatureHeader) return false;
  const expected = createHmac('sha256', CHANNEL_SECRET).update(rawBody).digest('base64');
  const a = Buffer.from(expected);
  const b = Buffer.from(signatureHeader);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function fetchGroupName(groupId: string): Promise<string | null> {
  if (!CHANNEL_ACCESS_TOKEN) return null;
  const res = await fetch(`https://api.line.me/v2/bot/group/${groupId}/summary`, {
    headers: { Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}` },
  }).catch(() => null);
  if (!res || !res.ok) return null;
  const body = await res.json().catch(() => null);
  return body?.groupName ?? null;
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
    if (!CHANNEL_SECRET) {
      console.warn('[WARN] LINE_CHANNEL_SECRET is not set in .env — skipping signature verification. Set it for a real security check.');
    } else if (!isValidSignature(body, req.headers['x-line-signature'] as string | undefined)) {
      console.error('[REJECTED] X-Line-Signature did not match — this request did not come from LINE (or LINE_CHANNEL_SECRET is wrong).');
      res.writeHead(401);
      res.end('invalid signature');
      return;
    }

    try {
      const parsed = JSON.parse(body);
      for (const event of parsed.events ?? []) {
        if (event.source?.type !== 'group') continue;
        const groupId: string = event.source.groupId;
        const groupName = await fetchGroupName(groupId);
        console.log('\n=== GROUP EVENT CAPTURED ===');
        console.log(`LINE_GROUP_ID_FOUND: ${groupId}`);
        console.log(`GROUP_NAME: ${groupName ?? '(ไม่สามารถดึงชื่อกลุ่มได้ — ตรวจสอบ LINE_CHANNEL_ACCESS_TOKEN)'}`);
        console.log(`CAPTURED_AT: ${new Date().toISOString()}`);
        console.log('============================\n');
        console.log('Copy the LINE_GROUP_ID value above into LINE_GROUP_ID in your .env file.');
      }
    } catch {
      console.log('Received non-JSON or non-group-event body:', body);
    }
    // LINE requires a fast 200 response regardless of content.
    res.writeHead(200);
    res.end('ok');
  });
});

server.listen(PORT, () => {
  console.log(`LINE webhook capture listening on http://localhost:${PORT}`);
  console.log('Expose this with a tunnel (e.g. "cloudflared tunnel --url http://localhost:3000"),');
  console.log('point your LINE channel\'s webhook URL at the tunnel URL, invite the bot into');
  console.log('the target group, and send any message in that group.');
  if (!CHANNEL_SECRET) {
    console.log('\n[NOTE] LINE_CHANNEL_SECRET is not set — signature verification will be skipped this run.');
  }
});
