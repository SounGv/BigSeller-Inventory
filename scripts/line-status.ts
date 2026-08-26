import 'dotenv/config';

/** Read-only environment/config check for the LINE notification feature. Never sends anything. */
async function main() {
  let ok = true;

  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  const secret = process.env.LINE_CHANNEL_SECRET;
  const groupId = process.env.LINE_GROUP_ID;
  const notifyEnabled = (process.env.LINE_NOTIFY_ENABLED ?? 'false').toLowerCase() === 'true';

  console.log(token ? '[OK] LINE_CHANNEL_ACCESS_TOKEN ตั้งค่าแล้ว' : '[FAIL] ไม่ได้ตั้งค่า LINE_CHANNEL_ACCESS_TOKEN');
  ok &&= Boolean(token);

  console.log(secret ? '[OK] LINE_CHANNEL_SECRET ตั้งค่าแล้ว' : '[WARN] ไม่ได้ตั้งค่า LINE_CHANNEL_SECRET (ใช้ยืนยัน webhook เท่านั้น ไม่จำเป็นสำหรับการส่งข้อความ)');

  console.log(groupId ? `[OK] LINE_GROUP_ID = ${groupId}` : '[FAIL] ไม่ได้ตั้งค่า LINE_GROUP_ID — ดู docs/line-group-id.md');
  ok &&= Boolean(groupId);

  console.log(`[${notifyEnabled ? 'OK' : 'WARN'}] LINE_NOTIFY_ENABLED = ${notifyEnabled} ${notifyEnabled ? '(จะส่งแจ้งเตือนจริงหลัง import:moves สำเร็จ)' : '(ยังไม่ส่งแจ้งเตือนจริง — รัน "npm run line:test" ให้ผ่านก่อนเปิด)'}`);

  if (token && groupId) {
    const res = await fetch(`https://api.line.me/v2/bot/group/${groupId}/summary`, {
      headers: { Authorization: `Bearer ${token}` },
    }).catch(() => null);
    if (res?.ok) {
      const body = await res.json();
      console.log(`[OK] บอทเข้าถึงกลุ่มนี้ได้จริง — ชื่อกลุ่ม: "${body.groupName}"`);
    } else {
      console.log(`[FAIL] เรียก group summary ไม่สำเร็จ (status ${res?.status ?? 'network error'}) — ตรวจสอบว่า Token/Group ID ถูกต้อง และบอทยังอยู่ในกลุ่ม`);
      ok = false;
    }
  }

  console.log(ok ? '\nพร้อมใช้งาน' : '\nยังไม่พร้อม — แก้ตามรายการ [FAIL] ด้านบนก่อน');
  if (!ok) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
