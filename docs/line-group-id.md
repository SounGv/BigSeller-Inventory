# หา LINE_GROUP_ID

LINE ไม่มี API สำหรับ "ค้นหา Group ID" ของกลุ่มที่มีอยู่แล้ว — วิธีเดียวที่หาได้คือให้ LINE ส่ง webhook event จริงจากกลุ่มนั้นมาให้เราดูสักครั้ง ขั้นตอนนี้ทำครั้งเดียว ไม่ต้องทำซ้ำอีกหลังจากได้ Group ID แล้ว

## ขั้นตอน

เครื่องนี้มี `cloudflared` ติดตั้งอยู่แล้ว ใช้ทำ tunnel ได้เลยโดยไม่ต้องสมัครสมาชิกอะไรเพิ่ม (เร็วกว่า ngrok)

1. **เปิดตัวรับ webhook ของโปรเจกต์นี้** (เทอร์มินัลหน้าต่างที่ 1):
   ```bash
   npm run capture:line-group-id
   ```

2. **เปิด tunnel** (เทอร์มินัลหน้าต่างที่ 2 — เปิดแยกจากหน้าต่างแรก อย่าปิดหน้าต่างแรก):
   ```bash
   cloudflared tunnel --url http://localhost:3000
   ```
   รอสักครู่จะเห็นบรรทัดคล้าย ๆ:
   ```
   https://random-words-here.trycloudflare.com
   ```
   ก็อปปี้ URL นี้เก็บไว้ (เป็น URL ชั่วคราว ใช้ได้ตลอดที่หน้าต่างนี้ยังเปิดอยู่)

3. **ตั้งค่า Webhook URL ใน LINE Developers Console**
   - เข้า [LINE Developers Console](https://developers.line.biz/console/) → เลือก Channel (Messaging API) ของคุณ
   - แท็บ "Messaging API" → หัวข้อ "Webhook settings"
   - ใส่ Webhook URL เป็น URL จาก cloudflared ในขั้นตอนที่ 2 (เช่น `https://random-words-here.trycloudflare.com`) แล้วกด "Verify" เพื่อยืนยันว่าเชื่อมต่อได้ (ควรขึ้น Success)
   - เปิด "Use webhook" ให้เป็น ON

4. **เชิญบอทเข้ากลุ่มไลน์เป้าหมาย**
   เพิ่ม LINE Official Account (บอท) เป็นสมาชิกกลุ่มไลน์ที่ต้องการให้แจ้งเตือน (เหมือนเพิ่มเพื่อนคนหนึ่งเข้ากลุ่ม)

5. **พิมพ์ข้อความอะไรก็ได้ในกลุ่มนั้น**
   ทันทีที่มีข้อความ LINE จะส่ง webhook event มาที่ terminal ที่รัน `capture:line-group-id` ไว้ จะเห็นบรรทัด:
   ```
   >>> GROUP ID: Cxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
   ```

6. **นำค่านั้นไปใส่ใน `.env`**:
   ```
   LINE_GROUP_ID=Cxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
   ```

7. **เก็บกวาด**
   - ปิด `capture:line-group-id` และ `cloudflared` ได้เลย (Ctrl+C ทั้งสองหน้าต่าง)
   - กลับไปที่ LINE Developers Console แล้วปิด "Use webhook" กลับเป็น OFF (โปรเจกต์นี้ไม่ได้ใช้ webhook ถาวร มีแค่ push message ทางเดียว ไม่จำเป็นต้องเปิด webhook ค้างไว้)

หลังจากนี้ ระบบจะส่งข้อความแจ้งเตือนพร้อมแท็ก "@ทุกคน" เข้ากลุ่มนี้อัตโนมัติทุกครั้งที่ `npm run import:moves` สร้างใบย้ายสินค้าสำเร็จ
