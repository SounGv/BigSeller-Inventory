import 'dotenv/config';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';

const PORT = Number(process.env.LINE_CAPTURE_PORT ?? 3000);
const CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;
const CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const GROUP_ID = process.env.LINE_GROUP_ID;

/**
 * One-time bootstrapping tool for scripts/line-command-bot.ts's
 * LINE_COMMAND_ALLOWED_USER_IDS whitelist. LINE never shows a member's
 * userId anywhere in its own UI (the group member search only shows display
 * name + photo) — the only way to learn it is to receive one real webhook
 * event from that member and read `source.userId` off it, same technique
 * already used to capture LINE_GROUP_ID (see docs/line-group-id.md). This
 * additionally resolves each captured userId's real display name via
 * BigSeller... via LINE's own group-member-profile API, so the console
 * output can be matched directly against a list of names (e.g. the staff
 * circled in a screenshot) instead of just showing raw IDs.
 *
 * Usage: run this, expose it with a tunnel (same as line-webhook-capture.ts),
 * point the LINE channel's webhook URL at the tunnel, and have each staff
 * member you want to whitelist send any one message — either in the group,
 * or as a 1:1 DM to the bot (both are captured; line-command-bot.ts accepts
 * commands from either). Copy the printed userId values into
 * LINE_COMMAND_ALLOWED_USER_IDS (comma-separated) once every expected name
 * has shown up. Stop (Ctrl+C) when done — this isn't part of the running bot.
 */
function isValidSignature(rawBody: string, signatureHeader: string | undefined): boolean {
  if (!CHANNEL_SECRET) return true; // no secret configured yet — warn instead of hard-blocking, see below
  if (!signatureHeader) return false;
  const expected = createHmac('sha256', CHANNEL_SECRET).update(rawBody).digest('base64');
  const a = Buffer.from(expected);
  const b = Buffer.from(signatureHeader);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function fetchGroupMemberDisplayName(groupId: string, userId: string): Promise<string | null> {
  if (!CHANNEL_ACCESS_TOKEN) return null;
  const res = await fetch(`https://api.line.me/v2/bot/group/${groupId}/member/${userId}`, {
    headers: { Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}` },
  }).catch(() => null);
  if (!res || !res.ok) return null;
  const body = await res.json().catch(() => null);
  return body?.displayName ?? null;
}

/** For a 1:1 DM sender — a different endpoint than the group-member one above (that one 404s for a non-group source). Requires the sender to have added the bot as a friend, which is also a prerequisite for the DM itself to exist. */
async function fetchUserProfileDisplayName(userId: string): Promise<string | null> {
  if (!CHANNEL_ACCESS_TOKEN) return null;
  const res = await fetch(`https://api.line.me/v2/bot/profile/${userId}`, {
    headers: { Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}` },
  }).catch(() => null);
  if (!res || !res.ok) return null;
  const body = await res.json().catch(() => null);
  return body?.displayName ?? null;
}

const seen = new Set<string>();

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
      console.warn('[WARN] LINE_CHANNEL_SECRET is not set — skipping signature verification. Set it for a real security check.');
    } else if (!isValidSignature(body, req.headers['x-line-signature'] as string | undefined)) {
      console.error('[REJECTED] X-Line-Signature did not match — this request did not come from LINE (or LINE_CHANNEL_SECRET is wrong).');
      res.writeHead(401);
      res.end('invalid signature');
      return;
    }

    try {
      const parsed = JSON.parse(body);
      for (const event of parsed.events ?? []) {
        const sourceType = event.source?.type;
        if (sourceType !== 'group' && sourceType !== 'user') continue; // ignore room events etc. — not a source type this project uses
        if (sourceType === 'group' && GROUP_ID && event.source.groupId !== GROUP_ID) {
          console.log(`(ignored — different group: ${event.source.groupId})`);
          continue;
        }

        const userId: string | undefined = event.source.userId;
        if (!userId || seen.has(userId)) continue;
        seen.add(userId);

        const displayName =
          sourceType === 'group'
            ? await fetchGroupMemberDisplayName(event.source.groupId, userId)
            : await fetchUserProfileDisplayName(userId);

        console.log('\n=== MEMBER CAPTURED ===');
        console.log(`VIA: ${sourceType === 'group' ? 'group message' : '1:1 DM to the bot'}`);
        console.log(`DISPLAY_NAME: ${displayName ?? '(ดึงชื่อไม่ได้ — ตรวจสอบ LINE_CHANNEL_ACCESS_TOKEN)'}`);
        console.log(`USER_ID: ${userId}`);
        console.log(`CAPTURED_AT: ${new Date().toISOString()}`);
        console.log('========================');
        console.log(`Captured so far: ${seen.size} unique member(s).`);
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
  console.log(`LINE user-id capture listening on http://localhost:${PORT}`);
  console.log('Expose this with a tunnel (e.g. "cloudflared tunnel --url http://localhost:3000"),');
  console.log('point your LINE channel\'s webhook URL at the tunnel URL, and have each staff member');
  console.log('you want to whitelist send any one message in the group.');
  if (!CHANNEL_SECRET) {
    console.log('\n[NOTE] LINE_CHANNEL_SECRET is not set — signature verification will be skipped this run.');
  }
  if (!GROUP_ID) {
    console.log('\n[NOTE] LINE_GROUP_ID is not set — capturing from ANY group the bot is in, not just the target one.');
  }
});
