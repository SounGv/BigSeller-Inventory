# Feature: ดึงผลงานหยิบสินค้ารายวันต่อคน เทียบกับเป้า แล้ว sync เข้า Google Sheets ทุกวันอัตโนมัติ

Paste ไฟล์นี้ทั้งไฟล์เป็น prompt แรกให้ Cursor — มีบริบทครบ

## แก้ไข 2026-09-01 — พบหน้ารายงานที่ทำให้ข้อจำกัด "ไม่รวมแพ็ค" ด้านล่างไม่จริงอีกต่อไป
ผู้ใช้ส่งภาพหน้า `https://www.bigseller.com/web/statis/waveWorkBoard.htm` ("แผงรายงาน Wave") มา —
มี "อันดับการหยิบวันนี้" **และ** "อันดับการบรรจุวันนี้" (พัสดุ+สินค้าต่อคน) ครอบคลุมทั้งฝ่ายออนไลน์และ
ฝ่ายออฟไลน์ในหน้าเดียว แบบเรียลไทม์ — ตรวจสอบ API เบื้องหลังแล้ว (`GET
/api/v1/wave/dashboard/shippedOrderRank.json?warehouseId=`) พบว่าให้ทั้ง `pickRank`/`packageRank`/
`sortRank`/`shippedRank`/`scanInspectionRank` โดย `employee` ในผลลัพธ์คือ BigSeller login เดียวกับที่ใช้
เป็น `staff.id` ใน Supabase อยู่แล้ว — join หา department ได้ตรงๆ

**สร้างเสร็จแล้วและทดสอบจริงแล้ว (2026-09-01) — ใช้แหล่งนี้แทน แทนที่จะไปสร้าง
`operator-performance-page.ts` ตาม spec เดิมด้านล่าง (`packagedAnalytics.htm`)** เพราะ:
- ได้ข้อมูลบรรจุที่ spec เดิมบอกว่าไม่มีจริงๆ (ทำให้ scope เดิม "ไม่รวมแพ็ค" ไม่จำเป็นอีกต่อไป)
- ครอบคลุมทั้ง 2 ฝ่ายในเรียกเดียว ไม่ต้อง join ข้ามหน้า
- เป็น real-time snapshot "วันนี้" ตรงกับที่ ranking widget ในหน้า home ต้องการอยู่แล้ว (ไม่ต้องกรองช่วงวันที่)

ตาราง Supabase ใหม่ `operator_wave_ranking` (`rank_type ['pick'/'sort'/'shipped'/'package'/
'scan_inspection'], employee, package_num, sku_num, source_url, synced_at`) — replaceAll ทุกรอบ (ไม่มี
manual overlay) ไม่ผูก FK กับ `staff.id` ตรงๆ (join แบบ LEFT JOIN ตอน query แทน เผื่อมีพนักงานใหม่ที่ยัง
ไม่ได้เพิ่มลง `staff`) โค้ด: `src/bigseller/wave-work-board-page.ts`,
`src/services/operator-wave-ranking-service.ts`, `scripts/sync-operator-wave-ranking.ts`
(`npm run sync:operator-wave-ranking`) — ทดสอบจริงแล้ว ได้ 41 แถว join กับ `staff` ได้ครบทุกคน

**เนื้อหาด้านล่างนี้ (packagedAnalytics.htm, ตาราง `operator_performance`, เป้า 350/คน/วัน) ยังใช้ได้ถ้า
ในอนาคตต้องการ metric ละเอียดกว่านี้ต่อ operator ต่อวัน** (ยืนยัน/พิมพ์ใบปะหน้า/PDA/ฯลฯ) — แต่ไม่ใช่สิ่งที่
ต้องสร้างก่อนแล้วสำหรับ ranking widget ในหน้า home อีกต่อไป เพราะ `operator_wave_ranking` ครอบคลุมแล้ว

## แหล่งข้อมูล

### หน้า `https://www.bigseller.com/web/statis/packagedAnalytics.htm`
ตาราง "รายละเอียดข้อมูล" มีคอลัมน์ต่อแถว (ต่อ operator ต่อวัน):
`วันที่, Operator, ยืนยัน, พิมพ์ใบปะหน้าพัสดุ, พิมพ์ Pick List, PDA หยิบของ, จัดส่ง, พิมพ์ใบแจ้งหนี้,
จำนวน Wave ที่หยิบ, จำนวนรวมพัสดุที่หยิบ, จำนวนรวม SKU ที่หยิบ, จำนวน Wave ที่คัดแยก`

**เมตริกหลักที่ต้องใช้สำหรับ "หยิบ": `PDA หยิบของ` และ/หรือ `จำนวนรวมพัสดุที่หยิบ`** — เปิดหน้าจริง
เทียบสองคอลัมน์นี้ก่อนเขียนโค้ดว่าตัวไหนตรงกับนิยาม "ผลงานหยิบต่อวัน" ที่ทีมใช้จริง (อาจไม่เหมือนกัน —
"PDA หยิบของ" น่าจะนับจำนวนแอคชันหยิบผ่านเครื่อง PDA, "จำนวนรวมพัสดุที่หยิบ" น่าจะนับจำนวนพัสดุจริง)
ถ้าไม่แน่ใจ ดึงมาเก็บทั้งคู่ ไม่ต้องเลือกทิ้งเลย ให้ตัดสินใจตอนดูข้อมูลจริง

**หน้านี้มีปุ่ม export (ไอคอนดาวน์โหลด มุมขวาบนของตาราง)** — เช็คก่อนว่า export ได้ไฟล์ที่มีข้อมูล
ครบเหมือนหน้า list ไหม (มีตัวกรองวันที่/ร้านค้า/คลังด้านบนตารางด้วย) ถ้า export ใช้ได้ ให้ใช้แทนการ
scrape DOM ทีละแถว ตาม convention เดิมของโปรเจกต์นี้ (เชื่อถือได้กว่า เร็วกว่า) มี pagination
"50/หน้า" ให้ตั้งค่าสูงสุดก่อน loop ถ้าไม่มี export จริงๆ

## งานที่ต้องทำ

### 1. Page object ใหม่: `src/bigseller/operator-performance-page.ts`
ตาม pattern เดียวกับ `inventory-page.ts` — **ห้ามเดา selector เอง** ต้องเปิดหน้าจริงแล้ว inspect DOM
ก่อนเขียน locator ทุกตัว:
- ไปที่ `packagedAnalytics.htm`
- ตั้งช่วงวันที่ = "เมื่อวาน" (ดึงของเมื่อวานเสมอ เพราะรันตอนเช้าของวันถัดไป ข้อมูลเมื่อวานจะนิ่งแล้ว
  ไม่เหมือนของวันนี้ที่ยังนับไม่ครบ)
- อ่าน/export ตาราง "รายละเอียดข้อมูล" ทุกแถว (ยกเว้นแถว "ทั้งหมด" ที่เป็นผลรวม)

### 2. Service ใหม่: `src/services/operator-performance-service.ts`
```typescript
export async function syncOperatorPerformance(page: Page, sheetsClient: SheetsClient, runId: string): Promise<void> {
  // 1. ensureSessionValid(page, PACKAGED_ANALYTICS_URL)
  // 2. scrape/export ด้วย OperatorPerformancePage
  // 3. เขียนลง DB_OPERATOR_PERFORMANCE (upsert ต่อ runId+date+operator ไม่ใช่ append-only —
  //    ถ้ารันซ้ำวันเดียวกันต้องทับ ไม่ใช่ซ้ำแถว)
}
```

Sheet `DB_OPERATOR_PERFORMANCE` headers:
`runId, date, operator, confirmedCount, printedLabelCount, printedPickListCount, pdaPickedCount,
dispatchedCount, printedInvoiceCount, waveCountPicked, totalParcelsPicked, totalSkuPicked,
waveCountSorted, sourceUrl`

### 3. เทียบกับเป้า — เป้าเป็นค่าคงที่ ไม่ต้อง join กับชีตเป้าเดิมแล้ว (แก้ 2026-08-31)
**ตัดสินใจแล้ว: ไม่ join กับ `รายงานของทีม.xlsx`/team-kpi-workbook เดิม** — ชีตเดิมพนักงานต้องพิมพ์เอง
ทุกวัน ถ้าลืมพิมพ์ก็ไม่มีข้อมูล (ยืนยันจากผู้ใช้ 2026-08-31: "จะใช้ข้อมูลจริงทุกอย่างจาก bigseller
ทุกอย่าง ให้ระบบเป็นหลัก") ตรวจไฟล์เดิมแล้วพบว่าชีต `คลัง6`/`ชีต7` เป็น template คอลัมน์ที่ตั้งไว้แต่ไม่มี
แถวข้อมูลจริงเลย — ยืนยันปัญหานี้เชิงประจักษ์ด้วย

แทนที่ด้วย **เป้าคงที่ = 350 พัสดุ/คน/วัน** (ตัวเลขจริงจากไฟล์เดิม แก้จาก 300 ที่เคยใช้เป็นตัวอย่างคาดเดา
ในเอกสารชุดนี้ก่อนหน้า) เก็บเป็นค่าคงที่ในโค้ด/`.env` (`ONLINE_PICK_DAILY_QUOTA=350`) ไม่ต้อง join กับ
ชีตภายนอกใดๆ:

```typescript
const ONLINE_PICK_DAILY_QUOTA = Number(process.env.ONLINE_PICK_DAILY_QUOTA ?? 350);

function computeQuotaAchievement(
  actual: OperatorPerformanceRow,
): { pctOfQuota: number; hitTarget: boolean } {
  const pct = actual.totalParcelsPicked / ONLINE_PICK_DAILY_QUOTA;
  return { pctOfQuota: Math.round(pct * 100), hitTarget: pct >= 1 };
}
```
เขียนผลลัพธ์เพิ่มเป็นคอลัมน์ `pctOfQuota, hitTarget` ใน `DB_OPERATOR_PERFORMANCE` เอง

**ไม่รวมเวลาเข้า-ออกงาน** ในการคำนวณนี้ (ยืนยันจากผู้ใช้ 2026-08-31: "เข้าออกงาน ไม่ต้องดึงมา") — เป้าที่
ปรับตามเวลาของวัน (ดู `FEATURE-dashboard-home-page.md` หัวข้อ "เป้าที่ปรับตามเวลา") ต้องอิงกะมาตรฐาน/
ค่าเฉลี่ยย้อนหลัง ไม่ใช่เวลาเข้างานจริงรายคน

**ต่อกับระบบแรงกิ้งใหม่:** ตัวเลข `totalParcelsPicked` ต่อ operator ต่อวันจากไฟล์นี้ คือแหล่งข้อมูลตรงของ
"อันดับผลงานวันนี้ — ฝ่ายออนไลน์" ใน `FEATURE-dashboard-home-page.md`/`FEATURE-department-pages.md`
(เพิ่ม 2026-08-31) — จัดอันดับจากจำนวนพัสดุที่หยิบอย่างเดียว ไม่ผสมตัวชี้วัดอื่น

### 4. Automation รายวัน — ตาม pattern เดิมของโปรเจกต์ (`run-sync.bat` + Windows Task Scheduler)
สร้าง npm script ใหม่:
```json
"sync:operator-performance": "tsx scripts/sync-operator-performance.ts"
```
และไฟล์ `.bat` คู่กันตาม pattern `run-sync.bat` ที่มีอยู่แล้ว:
```bat
@echo off
cd /d "%~dp0.."
if not exist logs mkdir logs
echo [%date% %time%] Starting sync:operator-performance >> logs\scheduled-operator-performance.log
call npm run sync:operator-performance >> logs\scheduled-operator-performance.log 2>&1
set SYNC_EXIT=%errorlevel%
echo [%date% %time%] Finished sync:operator-performance with exit code %SYNC_EXIT% >> logs\scheduled-operator-performance.log
exit /b %SYNC_EXIT%
```
แนะนำให้ตั้ง Task Scheduler รันตอนเช้า (เช่น 07:00) หลังเที่ยงคืนของวันที่ต้องการข้อมูลผ่านไปแล้ว
เพื่อให้ข้อมูล "เมื่อวาน" นิ่งสมบูรณ์ก่อนดึง — **ไม่ต้องเดาเวลาที่แน่นอน ให้ถามผู้ใช้ว่าอยากรันกี่โมง**

## ห้ามทำ
- ห้ามกลับไป join กับ `รายงานของทีม.xlsx`/team-kpi-workbook เดิม — ตัดสินใจแล้วว่าใช้เป้าคงที่ +
  ข้อมูลจาก BigSeller ล้วนๆ (ดูหัวข้อ 3)
- ห้ามดึงเวลาเข้า-ออกงานมาประกอบการคำนวณ (ตัดออกจาก scope แล้ว)
- ห้ามเดา selector/ปุ่ม export — ต้องเปิดหน้าจริงก่อนเขียน locator ทุกตัว
- ห้ามทำเรื่อง "แพ็ค" ในรอบนี้ (นอก scope ตามที่ตกลงกันไว้)
- ห้ามลบ/แก้ script หรือ `.bat` ที่มีอยู่แล้ว (`run-sync.bat` ต้องคงเดิม)

## วิธีทดสอบ
```bash
npm run login:bigseller
npx tsx scripts/sync-operator-performance.ts
```
เช็คด้วยตา: เทียบตัวเลขในชีต `DB_OPERATOR_PERFORMANCE` กับตารางจริงในหน้า `packagedAnalytics.htm`
(กรองวันเดียวกัน) ต้องตรงกันทุก operator ทุกคอลัมน์
