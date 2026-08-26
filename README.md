# BigSeller Inventory Sync

ระบบ Browser Automation (Playwright + TypeScript) สำหรับดึงข้อมูล **สต็อกตามตำแหน่งจัดเก็บ (Location Inventory)** และ **รายงานยอดขาย** จาก BigSeller แล้วบันทึกลง Google Sheets ตามระบบฐานข้อมูลเดิมของ Gadget Villa

> **ข้อควรทราบก่อนใช้งานจริง**: Selector ของ BigSeller ในไฟล์ `src/bigseller/inventory-page.ts` และ `src/bigseller/sales-page.ts` เป็นค่าที่ดีที่สุดเท่าที่ประมาณได้จากข้อความ UI ทั่วไป (ยังไม่ได้ตรวจกับหน้าเว็บจริง) จุดที่ต้องตรวจสอบมีคอมเมนต์ `// TODO: verify` กำกับไว้ ให้ใช้ `npx playwright codegen` (ดูขั้นตอนที่ 3) เพื่อยืนยัน/แก้ไข Selector ให้ตรงกับหน้าเว็บจริงก่อนใช้งานจริง

## 1. ติดตั้งระบบ

```bash
npm install
npx playwright install chromium
```

## 2. ตั้งค่า `.env`

คัดลอกไฟล์ตัวอย่างแล้วกรอกค่า:

```bash
cp .env.example .env
```

ค่าที่ต้องตั้ง:

| ตัวแปร | คำอธิบาย |
|---|---|
| `BIGSELLER_INVENTORY_URL`, `BIGSELLER_SALES_URL` | URL หน้า Inventory / Sales ของ BigSeller |
| `INVENTORY_WAREHOUSE_NAME` | ชื่อคลังสินค้าที่ต้องการดึงข้อมูล (ต้องตรงกับป้ายในหน้าเว็บ) |
| `INVENTORY_AREA_NAME` | ชื่อพื้นที่คลัง |
| `INVENTORY_POSITION_TYPE_NAME` | ค่าเริ่มต้น `ตำแหน่งหยิบสินค้า` |
| `GOOGLE_SHEETS_SPREADSHEET_ID` | ID ของ Google Sheets ปลายทาง |
| `GOOGLE_APPLICATION_CREDENTIALS` | พาธไปยังไฟล์ Service Account JSON (เก็บไว้ที่ `secrets/`, **ห้าม commit**) |
| `DRY_RUN` | `true` = ดึง+ตรวจสอบข้อมูลเท่านั้น ไม่เขียน Google Sheets |

**ห้ามเขียน Username, Password, OTP หรือ Cookie ของ BigSeller ไว้ใน `.env` หรือ Source Code เด็ดขาด** — ค่าเหล่านี้จะไม่ถูกเก็บที่ไหนในโค้ดเลย ระบบใช้ไฟล์ Session (`playwright/.auth/bigseller.json`) แทน

### เชื่อมต่อ Google Sheets

1. สร้าง Service Account ใน Google Cloud Console แล้วเปิดใช้งาน Google Sheets API
2. สร้าง Key เป็นไฟล์ JSON เก็บไว้ที่ `secrets/google-service-account.json` (โฟลเดอร์นี้อยู่ใน `.gitignore` แล้ว)
3. แชร์ Google Sheets ปลายทางให้กับอีเมลของ Service Account (สิทธิ์ Editor)
4. คัดลอก Spreadsheet ID (ส่วนของ URL ระหว่าง `/d/` กับ `/edit`) มาใส่ใน `.env`
5. ตรวจสอบว่า Sheets มีแท็บชื่อ: `DB_LOCATION_SNAPSHOT`, `DB_LOCATION_CURRENT`, `SYNC_LOG`, `ERROR_LOG`, `EMPLOYEE_TASK_VIEW`, `DB_REPLENISH_TRANSACTION`, `DB_SALES_SNAPSHOT` (หรือชื่อที่ตั้งไว้ใน `.env`)

## 3. ล็อกอิน BigSeller ครั้งแรก

```bash
npm run login:bigseller
```

คำสั่งนี้จะเปิดเบราว์เซอร์แบบเห็นหน้าจอ ให้พนักงานกรอก Username, Password, OTP และยืนยัน CAPTCHA **ด้วยตนเอง** ระบบจะตรวจสอบสถานะการล็อกอินให้อัตโนมัติทุก 3 วินาที (รอสูงสุด 5 นาที) เมื่อล็อกอินสำเร็จจะบันทึก Session ไว้ที่ `playwright/.auth/bigseller.json` โดยอัตโนมัติ

### ตรวจ/แก้ไข Selector ด้วย Codegen

หากหน้าเว็บ BigSeller มีการเปลี่ยนแปลง ให้เปิด Codegen เพื่อดู Selector จริง แล้วนำไปแก้ในไฟล์ Page Object เท่านั้น (`src/bigseller/inventory-page.ts`, `src/bigseller/sales-page.ts`) — **ห้ามใส่ Selector กระจายในไฟล์อื่น**:

```bash
npx playwright codegen "https://www.bigseller.com/web/inventory/warehouseInventory.htm" --save-storage=playwright/.auth/bigseller.json
```

## 4. เชื่อมต่อ Google Sheets

ดูขั้นตอนในหัวข้อ 2 (เชื่อมต่อ Google Sheets) ด้านบน

## 5. ทดสอบดึงข้อมูล

ตรวจสอบความพร้อมของระบบ (Session, ตัวแปร .env, การเชื่อมต่อ Google Sheets, แท็บที่จำเป็น) โดยไม่เขียนข้อมูลใด ๆ:

```bash
npm run validate
```

ทดสอบดึงข้อมูลแบบ Dry Run (ตั้ง `DRY_RUN=true` ใน `.env`):

```bash
npm run sync:inventory
npm run sync:sales
```

รัน Unit Test / Integration Test:

```bash
npm test
```

> Integration test ในหน้า BigSeller จะถูก **ข้ามอัตโนมัติ** หากยังไม่มีไฟล์ Session หรือยังไม่ตั้งค่าตัวกรองคลัง/พื้นที่ใน `.env`

## 6. เปิดระบบอัตโนมัติ

เมื่อทดสอบผ่านแล้ว ตั้ง `DRY_RUN=false` ใน `.env` แล้วรัน:

```bash
npm run sync:all
```

แนะนำให้ตั้ง Cron / Scheduled Task บนเซิร์ฟเวอร์ (VPS) ให้รันคำสั่งนี้ตามรอบที่ต้องการ โดย**ต้องมีไฟล์ Session ที่ยังไม่หมดอายุอยู่ก่อนแล้ว** ระบบจะไม่พยายามล็อกอินเองเมื่อ Session หมดอายุ

## 7. แก้ปัญหา Session หมดอายุ

หาก Sync ล้มเหลวด้วย error `SessionExpiredError`:

1. ระบบจะ**หยุดทำงานทันที** และบันทึก Error Log พร้อม Screenshot ไว้ที่โฟลเดอร์ `logs/`
2. ระบบ**จะไม่ลองรหัสผ่านซ้ำเองโดยอัตโนมัติ**
3. ให้พนักงานที่มีสิทธิ์รัน `npm run login:bigseller` เพื่อล็อกอินใหม่
4. รัน `npm run validate` เพื่อยืนยันว่า Session ใช้งานได้แล้วก่อน Sync รอบถัดไป

## 8. ตรวจสอบ Log และไฟล์ Trace

| ประเภท | ตำแหน่งไฟล์ |
|---|---|
| Log รายวัน (`logger.ts`) | `logs/YYYY-MM-DD.log` |
| Error Log (Google Sheets) | แท็บ `ERROR_LOG` |
| Sync Log (Google Sheets) | แท็บ `SYNC_LOG` |
| Screenshot เมื่อเกิดข้อผิดพลาด | `logs/<job>-error-<timestamp>.png` |
| Trace (บันทึกตอน Retry ครั้งแรก) | `logs/<job>-trace-<timestamp>.zip` |
| Playwright Test Report / Trace | `playwright-report/`, `test-results/` |

เปิดไฟล์ Trace ด้วย:

```bash
npx playwright show-trace logs/<job>-trace-<timestamp>.zip
```

## โครงสร้างโปรเจกต์

```text
src/
  bigseller/
    auth.ts            ตรวจสอบ/บังคับสถานะ Session (ไม่มีการล็อกอินอัตโนมัติ)
    inventory-page.ts  Page Object: BigSellerInventoryPage
    sales-page.ts       Page Object: BigSellerSalesPage
    extract-table.ts   อ่าน/ตรวจสอบไฟล์ .xlsx / .csv ที่ดาวน์โหลดมา
    download-report.ts ดาวน์โหลดรายงานพร้อมตรวจสอบไฟล์ก่อนใช้งาน
  sheets/
    sheets-client.ts   เขียน/อัปเดต Google Sheets (Snapshot ก่อน แล้วค่อย Upsert)
  services/
    sync-service.ts       ควบคุมขั้นตอน Sync Inventory / Sales ทั้งหมด
    replenish-service.ts   สูตรคำนวณ "เติมได้อีกกี่ชิ้น" + บันทึกการเติมสินค้า
  utils/
    logger.ts, retry.ts, browser-runner.ts

tests/
  bigseller-inventory.spec.ts
  bigseller-sales.spec.ts
  replenish-formula.spec.ts

scripts/
  login-bigseller.ts   npm run login:bigseller
  sync-inventory.ts    npm run sync:inventory
  sync-sales.ts        npm run sync:sales
  sync-all.ts          npm run sync:all
  validate.ts          npm run validate
```

## กฎสำคัญของระบบ

- พนักงานดูข้อมูลผ่านแท็บ `EMPLOYEE_TASK_VIEW` เท่านั้น และ**ห้ามแก้ยอดสต็อกปัจจุบันในชีตโดยตรง**
- การเติมสินค้าจริงต้องบันทึกผ่าน `DB_REPLENISH_TRANSACTION` เท่านั้น
- Sync รอบถัดไปถือข้อมูลจาก BigSeller เป็นยอดจริงเสมอ
- Key ป้องกันข้อมูลซ้ำ: `sku + warehouse + area + position + positionType`
- ก่อนเขียนทับ `DB_LOCATION_CURRENT` ระบบจะบันทึก Snapshot ใหม่ลง `DB_LOCATION_SNAPSHOT` ก่อนเสมอ (Append-only ไม่มีการเขียนทับ)
- หากตรวจสอบข้อมูลที่ดึงมาไม่ครบ (เช่นไฟล์รายงานผิดรูปแบบ หรือจำนวนแถวลดลงเกินครึ่งจากรอบก่อน) ระบบจะ**หยุดก่อนเขียน Google Sheets**
