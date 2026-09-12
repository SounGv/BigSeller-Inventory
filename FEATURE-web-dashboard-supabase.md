# เว็บแดชบอร์ด Realtime บน Supabase + Vercel (ฟรี) — ต่อยอดจาก BigSeller-Inventory

Paste ไฟล์นี้ทั้งไฟล์เป็น prompt แรกให้ Cursor — ทำในโปรเจกต์ใหม่แยกจาก `BigSeller-Inventory` repo
(เป็น consumer ของข้อมูล ไม่ใช่ตัว scraper)

## บริบท / ทำไมเลือก stack นี้
ผู้ใช้เคย migrate `SounGv/Delivery` (KPI dashboard) จาก Google Apps Script ไป **Supabase** มาแล้ว
เพราะปัญหาโหลดช้าเหมือนกันเป๊ะกับที่ต้องการแก้ตอนนี้ และเคย deploy `GV CareHub` บน **Vercel free
tier** สำเร็จมาแล้ว — งานนี้ใช้ stack เดียวกันทั้งคู่ ไม่ทดลองของใหม่

**Scope รอบนี้: ย้ายเฉพาะข้อมูลฝั่งรายงาน/แดชบอร์ดไป Supabase เท่านั้น** — `DB_TRANSFER_PLAN` และ
ระบบสั่งงานจริง (`transfer-command-service.ts`, LINE bot) **ห้ามแตะ** ยังคงอยู่ Google Sheets เหมือนเดิม
เพราะใช้งานจริงอยู่ทุกวัน ไม่มีเหตุผลต้องเสี่ยง

## ตารางที่ย้ายไป Supabase (Postgres)

จาก Google Sheets `DB_*` เดิม → SQL table ใหม่ (ตั้งชื่อ snake_case ตาม convention):
- `DB_OPERATOR_PERFORMANCE` → `operator_performance` (index บน `date`, `operator`)
- `DB_PENDING_ORDER_DEMAND` → `pending_order_demand` (index บน `sku`)
- `DB_OFFLINE_LOCK` → `offline_lock` (index บน `sku`, `lock_status`)
- decoy reconciliation exceptions → `decoy_reconciliation_exceptions`

**ก่อนสร้าง schema จริง ให้ดู header ที่ระบุไว้ใน `FEATURE-pending-demand-and-offline-lock.md` และ
`FEATURE-operator-picking-performance.md`** (อยู่ในเอกสารที่คุยกันมาก่อนหน้านี้) แปลงเป็น column
type ที่เหมาะสม (`date` เป็น `date` type จริง ไม่ใช่ text, ตัวเลขเป็น `integer`/`numeric`)

## Layer 1: ตัวเขียนข้อมูล (แก้ที่ BigSeller-Inventory repo)

สร้าง `src/db/supabase-client.ts` **mirror interface เดียวกับ `SheetsClient`** (`upsertRows`,
`readRowsForRunId`) เพื่อให้ service เดิม (`operator-performance-service.ts`,
`order-demand-service.ts`) แก้แค่จุดที่เรียก client ไม่ต้องเขียน business logic ใหม่:

```typescript
export class SupabaseDbClient {
  async upsertRows(table: string, rows: Record<string, unknown>[], keyColumns: string[]): Promise<void> {
    // ใช้ supabase-js .upsert() พร้อม onConflict: keyColumns.join(',')
  }
  async readRowsForRunId(table: string, runId: string): Promise<Record<string, unknown>[]> {
    // .select('*').eq('run_id', runId)
  }
}
```

Service ที่เขียนไว้แล้วก่อนหน้านี้ (operator-performance, order-demand) ให้เปลี่ยนมาเรียก
`SupabaseDbClient` แทน `SheetsClient` — **เขียนเข้าทั้งสองที่พร้อมกันได้ในช่วงเปลี่ยนผ่าน** (dual-write)
ถ้ายังไม่มั่นใจ 100% แล้วค่อยตัด Sheets ออกทีหลังเมื่อ dashboard ใช้งานจริงมั่นคงแล้ว — ปลอดภัยกว่า
ตัดทีเดียว

ใช้ **Supabase free tier** — สร้างโปรเจกต์ใหม่ที่ supabase.com, เอา connection string + anon key
มาใส่ `.env` (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` สำหรับฝั่งเขียนจาก Node script — ใช้
service role key ไม่ใช่ anon key เพราะ script รันฝั่ง server ไม่ใช่ browser)

## Layer 2: Frontend (โปรเจกต์ใหม่แยกต่างหาก)

**จุดเริ่มต้น (เพิ่ม 2026-08-31): clone `cruip/tailwind-dashboard-template` (Mosaic Lite) เป็นฐาน**
แทนที่จะ scaffold React+Vite เปล่าตั้งแต่ศูนย์ — ตรวจสอบ `package.json` แล้วยืนยัน stack ตรงกับที่
ออกแบบไว้ในไฟล์นี้พอดี: React 19 + Vite 6 + Tailwind CSS v4 + Chart.js 4.4 + React Router 7 ฟรี ใช้
เชิงพาณิชย์ได้ (ห้ามแค่ republish/resell ตัวเทมเพลตเอง ไม่กระทบการใช้เป็นเครื่องมือภายใน)

ส่วนที่ใช้ต่อได้ตรงๆ ไม่ต้องเขียนใหม่:
- `src/utils/ThemeContext.jsx` — มีกลไก dark/light toggle อยู่แล้ว ปรับเป็น fixed-theme ต่อหน้า
  (มืดที่หน้า home ตาม `FEATURE-dashboard-home-page.md`, สว่างที่หน้า drill-down) แทนการ toggle โดยผู้ใช้
- `src/components/Datepicker.jsx`, `DateSelect.jsx` — ตรงกับตัวกรองช่วงวันที่ที่ `FEATURE-department-pages.md` ต้องใช้ทุกหน้าฝ่าย
- `src/charts/DoughnutChart.jsx`, `LineChart01-02.jsx`, `BarChart01-03.jsx` — ใช้แทนกราฟที่ต้องมี
  (donut อันดับ, กราฟจริง-vs-เป้า) Chart.js รองรับ mixed chart type ทำ combo เส้น+แท่งได้ในตัว
- `src/partials/dashboard/DashboardCard01-13.jsx` — การ์ด KPI สำเร็จรูป ปรับสี/เนื้อหาแทนเขียนใหม่

ต้องเปลี่ยนสีธีมและฟอนต์ default ของเทมเพลตเป็นโทนที่ตกลงกันไว้ (ทองแดง+เขียวมิ้นท์ accent, Chakra
Petch สำหรับหัวข้อ, IBM Plex Sans Thai สำหรับเนื้อหา — ดู wireframe ที่ทำไว้ก่อนเขียนโค้ดจริง)

React + Vite (ตาม pattern `SounGv/Delivery`) + `@supabase/supabase-js`:

```typescript
// realtime subscription — หน้าเว็บเห็นข้อมูลใหม่ทันทีไม่ต้อง refresh
const channel = supabase
  .channel('operator-performance-changes')
  .on('postgres_changes', { event: '*', schema: 'public', table: 'operator_performance' },
    (payload) => { /* อัปเดต state ในหน้าเว็บ */ })
  .subscribe();
```

ฝั่ง frontend ใช้ **anon key** (public, จำกัดสิทธิ์ผ่าน Row Level Security — ต้องตั้ง RLS policy
อนุญาตแค่ `SELECT` ให้ anon role เท่านั้น **ห้ามเปิดสิทธิ์เขียนให้ anon เด็ดขาด** เพราะ key นี้อยู่ใน
โค้ด frontend ที่ browser ทุกคนเห็นได้)

Deploy ด้วย Vercel free tier (ตาม pattern `gv-carehub.vercel.app`) — ต่อ GitHub repo แล้ว auto-deploy
ทุกครั้งที่ push ได้เลย ไม่ต้องตั้ง CI แยก

## ห้ามทำ
- ห้ามย้าย `DB_TRANSFER_PLAN` หรือแตะ `transfer-command-service.ts`/LINE bot ในรอบนี้
- ห้ามใส่ `SUPABASE_SERVICE_ROLE_KEY` ในโค้ด frontend หรือไฟล์ที่ commit ขึ้น git — ใช้แค่ฝั่ง Node
  script เท่านั้น เก็บใน `.env` ที่อยู่ใน `.gitignore`
- ห้ามเปิด RLS ให้ anon role เขียนข้อมูลได้

## Trade-off ที่ต้องรู้
Supabase free tier pause โปรเจกต์ถ้าไม่มี activity ~7 วัน — แต่ Task Scheduler รัน sync ทุกวันอยู่แล้ว
เท่ากับมี write เข้า Supabase ทุกวันโดยอัตโนมัติ ความเสี่ยงจริงต่ำ แต่ถ้า scheduler พังหลายวันติด
โปรเจกต์ Supabase อาจ pause ไปด้วย — ควรมี monitoring/alert แยกว่า sync รันสำเร็จทุกวันจริงไหม
(เช่นต่อกับ LINE notify ที่มีอยู่แล้วในโปรเจกต์)

## วิธีทดสอบ
1. รัน sync script ที่แก้แล้ว เช็คว่าข้อมูลขึ้นใน Supabase table studio จริง
2. เปิดหน้าเว็บ frontend ทิ้งไว้ แล้วรัน sync อีกรอบจากเครื่องอื่น เช็คว่าหน้าเว็บอัปเดตเองโดยไม่ต้อง
   refresh (พิสูจน์ realtime subscription ทำงานจริง)
3. เช็ค RLS policy ด้วยการลองเรียก Supabase REST API ตรงๆ ด้วย anon key แล้วลอง insert/update —
   ต้องถูกปฏิเสธ
