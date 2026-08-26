import 'dotenv/config';

/**
 * Sends the exact test message to LINE_GROUP_ID right now, bypassing
 * LINE_NOTIFY_ENABLED (this IS the manual test that decides whether to flip
 * that flag on). Never claims a real "@all" tag worked unless you actually
 * see everyone get pinged in the group — this message deliberately does not
 * use LINE's mention feature, so judge it on delivery only, not on tagging.
 */
async function main() {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  const groupId = process.env.LINE_GROUP_ID;
  if (!token) throw new Error('LINE_CHANNEL_ACCESS_TOKEN is not set in .env');
  if (!groupId) throw new Error('LINE_GROUP_ID is not set in .env — see docs/line-group-id.md');

  const botName = process.env.LINE_BOT_NAME ?? 'GV Inventory Bot';
  const text = [
    `🧪 ทดสอบระบบ ${botName}`,
    '',
    'เชื่อมต่อกลุ่ม "ติดตามการทำงาน" สำเร็จแล้ว',
    '',
    'สมาชิกในกลุ่มสามารถรับแจ้งเตือนใบย้ายสินค้าได้',
  ].join('\n');

  const res = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ to: groupId, messages: [{ type: 'text', text }] }),
  });

  const requestId = res.headers.get('x-line-request-id');
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error(`[FAIL] LINE API returned ${res.status}${requestId ? ` (x-line-request-id: ${requestId})` : ''}: ${body}`);
    process.exit(1);
  }

  console.log(`[OK] ส่งข้อความทดสอบสำเร็จ${requestId ? ` (x-line-request-id: ${requestId})` : ''}`);
  console.log('ไปเช็คในกลุ่มไลน์จริงว่าข้อความเข้าไหม ก่อนเปลี่ยน LINE_NOTIFY_ENABLED=true');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
