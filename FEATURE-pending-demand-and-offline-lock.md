# Feature: นับ demand ที่ยังไม่ยืนยัน + ล็อกออฟไลน์ (LockStock) เข้าไปในการคำนวณเติมสต็อก

Paste ไฟล์นี้ทั้งไฟล์เป็น prompt แรกให้ Cursor — มีบริบทครบ ไม่ต้องถามเพิ่ม

## Root cause / ทำไมต้องทำ

`src/services/transfer-plan-service.ts` (`computeReplenishmentCandidates`) คำนวณ "สต็อกพร้อมขายจริง"
จาก `skuWarehouseStockBySku.availableWarehouseStock` ที่ sync มาจาก BigSeller ตรงๆ ค่านี้คือ
`totalWarehouseStock` ลบเฉพาะออเดอร์ที่ **ยืนยันแล้ว** เท่านั้น ทำให้พลาด 2 อย่าง:

1. **ออเดอร์ออนไลน์ที่ยังไม่กดยืนยัน** ("คำสั่งซื้อใหม่") — จะกินสต็อกแน่ๆ ในไม่ช้า แต่ระบบยังไม่รู้จัก
2. **ของที่ถูกล็อกไว้ขายหน้าร้าน/ออฟไลน์** — GV มีขั้นตอนบังคับอยู่แล้ว (ยืนยันจากผู้ใช้ 2026-08-28):
   พนักงานทุกคนสร้าง "ออเดอร์" ปลอมในร้านชื่อ **LockStock** เพื่อกันของ (เลขออเดอร์/แทรคขึ้นต้นด้วย
   `Lock-` เช่น `Lock-pone-280869-1`) และปิด/ยกเลิกออเดอร์นั้นทุกครั้งที่ปล่อยของหรือขายจริง — เป็น
   ขั้นตอนบังคับ 100% ไม่มีการกันของด้วยปากเปล่า จึงเชื่อถือได้เป็นแหล่งข้อมูลเดียวพอ ไม่ต้องสร้าง
   ระบบบันทึกคู่ขนาน (เช่น LINE bot command) เพิ่ม

**ข้อมูลทั้งสองอย่างนี้อยู่ในหน้าเดียวกัน**: `https://www.bigseller.com/web/order/index.htm?status=new`
คอลัมน์ "รายละเอียดสินค้า" ของแต่ละแถวออเดอร์แสดง SKU + จำนวนอยู่แล้วในหน้า list — **ไม่ต้องเปิด
order detail ทีละใบ** และคอลัมน์ร้าน (store) จะบอกว่าเป็นออเดอร์จริงจากช่องทางไหน หรือเป็น
`LockStock` (ล็อกออฟไลน์)

## สถาปัตยกรรม

```
scrape "คำสั่งซื้อใหม่" (status=new) หน้าเดียว ทุกร้าน/ช่องทาง
   │  ต่อแถว: sku, qty, store, channel, courier, orderTime
   │
   ├── store === "LockStock"  →  เขียนลง DB_OFFLINE_LOCK
   └── store !== "LockStock"  →  เขียนลง DB_PENDING_ORDER_DEMAND
                                        │
                                        ▼
   transfer-plan-service.ts: effectiveAvailableStock =
     availableWarehouseStock (จาก BigSeller, มีอยู่แล้ว)
     − sum(DB_PENDING_ORDER_DEMAND ต่อ sku)
     − sum(DB_OFFLINE_LOCK ต่อ sku)
                                        │
                                        ▼
   computeReplenishmentCandidates() ใช้ effectiveAvailableStock แทน
   ค่าตรงๆ จาก skuWarehouseStockBySku (แก้จุดเดียว ไม่แตะ algorithm หาตำแหน่ง/ปัดลัง)
```

SLA/cutoff แต่ละช่องทางเป็นงานแยก ไม่รวมใน scope นี้ (ทำเป็นตาราง reference
`DB_CHANNEL_SLA` ต่างหากทีหลัง ไว้ join เพื่อเรียงคิวความเร่งด่วนของใบย้าย)

## งานที่ต้องทำ

### 1. Page object ใหม่: `src/bigseller/new-orders-page.ts`
สร้างตาม pattern เดียวกับ `inventory-page.ts` — **ห้ามเดา selector เอง** ต้องเปิดหน้าจริงแล้ว
inspect DOM ก่อนเขียน locator ทุกตัว (ตาม convention ของโปรเจกต์นี้ — ดู comment
"Confirmed live (วันที่)" ใน `inventory-page.ts` เป็นตัวอย่างว่าต้องละเอียดขนาดไหน):

- ไปที่ `https://www.bigseller.com/web/order/index.htm?status=new`
- ตั้ง filter คลังสินค้าให้ตรงกับ `INVENTORY_WAREHOUSE_NAME` (มีตัวกรอง "คลังสินค้า" อยู่แล้วในหน้านี้
  เหมือนหน้า inventory)
- ตั้งจำนวนต่อหน้าให้สูงสุด (มี dropdown "300/หน้า" ในภาพตัวอย่าง) ก่อน loop เก็บทุกแถว —
  ถ้าจำนวนออเดอร์ใหม่เกิน 300 ต้องมี pagination loop ด้วย (เช็คตัวเลขจริงตอน dev)
- อ่านแต่ละแถวในตาราง: SKU, จำนวน, ชื่อร้าน (store), แพลตฟอร์ม/ช่องทาง, เวลาที่สั่ง
  **สำคัญ:** ตรวจสอบให้แน่ใจว่า SKU ที่ดึงได้คือ SKU ที่ตรงกับ `sku` column ใน `DB_LOCATION_CURRENT`/
  `DB_SKU_INVENTORY` (merchant SKU) ไม่ใช่ store SKU หรือรหัสแสดงผลอื่น — ถ้าไม่ตรงกัน ต้อง map ก่อน
  เขียนลง sheet ไม่งั้นการลบยอดจะจับคู่ผิด SKU
- ถ้าออเดอร์หนึ่งใบมีหลายรายการสินค้า (multi-line item) ต้องดึงทุกบรรทัดย่อย ไม่ใช่แค่บรรทัดแรก
- เขียน export helper คล้าย `exportAllRows()` ถ้าหน้านี้มีปุ่ม "ส่งออก" เหมือนหน้าคลังสินค้า
  (เช็คก่อนเขียน DOM scraper แบบ manual — export ทั้งชุดเชื่อถือได้กว่าตามที่โปรเจกต์นี้เคยพิสูจน์
  มาแล้วกับหน้าคลังสินค้า)

### 2. Service ใหม่: `src/services/order-demand-service.ts`
```typescript
export async function syncOrderDemand(page: Page, sheetsClient: SheetsClient, runId: string): Promise<void> {
  // 1. ensureSessionValid(page, NEW_ORDERS_URL)
  // 2. scrape ด้วย NewOrdersPage
  // 3. แยกแถวด้วย row.store === 'LockStock' (เช็ค exact string จริงจาก DOM ก่อน — 
  //    อาจมีช่องว่าง/ตัวพิมพ์เล็กใหญ่ต่างจากที่เห็นในภาพ)
  // 4. เขียน DB_PENDING_ORDER_DEMAND และ DB_OFFLINE_LOCK แยกกัน คนละ sheet
  //    (เขียนทับด้วย upsert ต่อ runId ไม่ใช่ append-only — ทั้งสอง sheet นี้ต้องสะท้อน
  //    "สถานะปัจจุบัน ณ ตอน sync" ไม่ใช่ประวัติสะสม เพราะออเดอร์ที่ถูกปิด/ยืนยันแล้ว
  //    ต้องหายไปจากรอบถัดไปโดยอัตโนมัติ — ตรงข้ามกับ DB_LOCATION_SNAPSHOT ที่เป็น append-only)
}
```

Sheet headers:
- `DB_PENDING_ORDER_DEMAND`: `runId, sku, qty, store, channel, orderTime, sourceUrl`
- `DB_OFFLINE_LOCK`: `runId, sku, qty, lockOrderNo, lockStatus, orderTime, sourceUrl`

**สำคัญ — LockStock มี 2 สถานะย่อยที่ต้องแยก** (ยืนยันจากผู้ใช้ 2026-08-28): พนักงานสร้าง
LockStock ทั้งกรณี "กันของแน่นอนแล้ว" และ "จองรอลูกค้าคอนเฟิร์ม" (ยังไม่แน่ว่าจะซื้อจริง) — สอง
อย่างนี้ต่างกันแค่ชื่อออเดอร์/หมายเหตุที่พนักงานพิมพ์ ไม่มี field สถานะแยกใน BigSeller เอง

- ตอน scrape ให้ตรวจข้อความในชื่อออเดอร์/remark ว่ามีคำว่า **"รอคอนเฟิร์ม"** (หรือคำใกล้เคียงที่ทีม
  ใช้จริง — ต้องเปิดดูออเดอร์ LockStock จริงหลายๆ ใบก่อนเขียน matching logic เพราะพนักงานอาจสะกด/
  เรียกไม่เหมือนกันทุกคน) แล้วเซ็ต `lockStatus = 'pending_confirm'` ถ้าไม่เจอคำนี้ให้เป็น
  `lockStatus = 'confirmed'`
- **แก้ไข (2026-08-31): การคำนวณ `effectiveAvailableStock` ในข้อ 3 ให้หักเฉพาะ `lockStatus ===
  'confirmed'` เท่านั้น — `pending_confirm` (จองรอลูกค้าคอนเฟิร์ม) ไม่หักออกจากสต็อกพร้อมขาย**
  (กลับจากที่ตกลงไว้ก่อนหน้าว่าจะหักทั้งสองสถานะเท่ากัน ผู้ใช้ยืนยันให้เปลี่ยนเป็นแบบนี้) ยังคงเก็บ
  `lockStatus` แยกไว้ในชีตเหมือนเดิม เพื่อให้เห็นในรายงานว่ามีของที่ "จองไว้แต่ยังไม่หัก" อยู่เท่าไหร่
  ต่อ SKU — เผื่อพนักงานอยากรู้ก่อนตัดสินใจสร้างใบย้ายเพิ่ม
- **Trade-off ที่ต้องยอมรับ:** ถ้าลูกค้าคอนเฟิร์มซื้อจริงระหว่างสอง sync cycle ระบบจะยังโชว์ของ
  ชิ้นนั้นเป็น "พร้อมขาย" อยู่ช่วงสั้นๆ จนกว่ารอบ sync ถัดไปจะเห็นว่าออเดอร์เปลี่ยนชื่อ/สถานะเป็น
  confirmed แล้ว — ยอมรับความเสี่ยงนี้แลกกับการไม่บล็อกสต็อกไว้เผื่อออเดอร์ที่สุดท้ายไม่เกิดขึ้นจริง
- ถ้าในอนาคตอยากเปลี่ยนเป็นไม่หัก `pending_confirm` เต็มจำนวน (เช่น หักแค่ 50% เพราะมีโอกาสไม่ซื้อ)
  ทำได้ง่ายเพราะแยก field ไว้แล้ว แต่ **ไม่ทำใน scope นี้** — ต้องคุยเรื่อง business rule ก่อนว่าจะ
  ใช้อัตราไหน ไม่ควรเดาเอง

### 3. แก้ `src/services/transfer-plan-service.ts`
เพิ่มฟังก์ชันคำนวณ effective stock ก่อนส่งเข้า `computeReplenishmentCandidates`:

```typescript
function computeEffectiveAvailableStock(
  skuWarehouseStockBySku: Map<string, SkuWarehouseStock>,
  pendingDemandBySku: Map<string, number>,   // sum qty จาก DB_PENDING_ORDER_DEMAND
  offlineLockBySku: Map<string, number>,      // sum qty จาก DB_OFFLINE_LOCK เฉพาะ lockStatus='confirmed' เท่านั้น — อย่ารวม 'pending_confirm'
): Map<string, SkuWarehouseStock> {
  const result = new Map<string, SkuWarehouseStock>();
  for (const [sku, stock] of skuWarehouseStockBySku) {
    const pending = pendingDemandBySku.get(sku) ?? 0;
    const locked = offlineLockBySku.get(sku) ?? 0;
    result.set(sku, {
      ...stock,
      availableWarehouseStock: Math.max(0, stock.availableWarehouseStock - pending - locked),
    });
  }
  return result;
}
```

เรียกใน `planMoves()` ก่อนส่งเข้า `computeReplenishmentCandidates` — **ห้ามแก้ logic ภายใน
`computeReplenishmentCandidates`, `findSourcePositions`, `buildTransferPlan` เอง** ฟังก์ชันเหล่านี้
ผ่านการปรับจูนกับ edge case จริงมาเยอะแล้ว (ปัดลัง, zone กันของแถม ฯลฯ) แก้แค่ input ที่ป้อนเข้าไปพอ

### 4. ต่อเข้า pipeline
เพิ่ม `syncOrderDemand()` เป็นอีกขั้นใน `syncBigSeller()` (หรือ `runFullTransferPipeline` ถ้าอยู่ใน
`transfer-command-service.ts`) ก่อนเรียก `planMoves()` เสมอ — ถ้า sync ล้มเหลว ต้อง throw ให้ทั้ง
pipeline หยุด (เหมือน `ensureSessionValid` ที่ทำอยู่แล้วกับ sync ตัวอื่น) ห้ามปล่อยให้ `planMoves()`
รันด้วยข้อมูล demand เก่า/ไม่มีเลยแบบเงียบๆ เพราะจะทำให้ตัวเลขเติมสต็อกผิดแบบไม่มีใครรู้

## ห้ามทำ
- ห้ามเดา CSS selector/ข้อความปุ่มเอง — ต้องเปิดหน้าจริงแล้ว inspect DOM ก่อนเขียน locator ทุกตัว
  (ตาม convention ที่มีอยู่แล้วทั้งไฟล์ในโปรเจกต์นี้)
- ห้ามแก้ core algorithm ใน `computeReplenishmentCandidates` / `buildTransferPlan`
- ห้าม hardcode คำว่า "LockStock" แบบไม่ตรวจสอบตัวสะกดจริงจาก DOM ก่อน (อาจมีช่องว่าง/ตัวพิมพ์เล็กใหญ่
  ต่างจากที่เห็นในภาพ screenshot)
- ห้าม auto ปิด/ยกเลิกออเดอร์ LockStock เอง — งานนี้แค่ "อ่าน" ข้อมูล ไม่ใช่ "เขียน" กลับเข้า BigSeller

## วิธีทดสอบ
```bash
npm run login:bigseller
npm run sync:inventory      # ให้ DB_SKU_INVENTORY มีข้อมูลก่อน
npx tsx scripts/sync-order-demand.ts   # (สร้าง script ใหม่นี้เรียก syncOrderDemand ตรงๆ สำหรับทดสอบ)
```
เช็คด้วยตา: เทียบจำนวนแถวใน `DB_PENDING_ORDER_DEMAND` + `DB_OFFLINE_LOCK` กับตัวเลข badge
"คำสั่งซื้อใหม่" และ "LockStock (n)" ที่เห็นในหน้าเว็บ ต้องตรงกัน (หรือใกล้เคียงมาก ถ้าตัวเลขขยับ
ระหว่าง sync เพราะมีออเดอร์ใหม่เข้ามาระหว่างนั้น)

จากนั้นรัน `npm run validate` + planMoves จริง แล้วสุ่มเช็ค SKU ที่รู้อยู่แล้วว่ามี LockStock กันไว้
ว่า `replenishableQty` ในผลลัพธ์ลดลงตามที่ควรจะเป็นจริง

## Addendum (2026-08-31): คลังหลอก "STOCK_ซิงก์ขายออนไลน์" — เพิ่ม 2 การเช็ก ไม่แก้ pipeline เดิม

**บริบท:** ทีมคลังมี workaround อยู่แล้ว — ของชำรุดที่อยู่ใน "ตำแหน่งชำรุด" ของ STOCK_5 (ขายจริง
ไม่ได้) ถูก mirror จำนวนไปคีย์ซ้ำในคลังปลอมชื่อ `STOCK_ซิงก์ขายออนไลน์` (รุ่น+จำนวนเท่ากันเป๊ะ
ทุก SKU) เพื่อยิง sync ไปโชว์ยอด "พร้อมขาย" บนมาร์เก็ตเพลสไม่ให้ขึ้นสินค้าหมด

**ตรวจสอบแล้ว (ไม่ต้องแก้):** `planMoves()` ใน `transfer-plan-service.ts` กรอง
`row.warehouse === WAREHOUSE_NAME` (ค่า default `'STOCK_5'`) ทั้ง `locationRows` และ
`skuWarehouseStockBySku` อยู่แล้ว ตั้งแต่ก่อนงานนี้เริ่ม — คลังหลอกจึง**ไม่เคยถูกนับปนเข้าไปใน
`availableWarehouseStock` ที่ใช้คำนวณเติมสต็อก** ตาม field เป็นค่าต่อคลังอยู่แล้ว (ยืนยันจาก
ข้อมูลจริง: SKU เดียวกันมี 2 แถวคนละคลัง ตัวเลข available ไม่รวมกัน) **ห้ามแก้ตัวกรองนี้ออกโดย
เด็ดขาด** เพราะเป็นสิ่งที่กันปัญหานี้อยู่แล้วโดยไม่ตั้งใจ

**สิ่งที่ต้องเพิ่ม (ของใหม่ ไม่ใช่แก้ของเก่า):**

1. **Reconciliation check ใหม่** (เพิ่มใน `syncOrderDemand()` หรือแยกเป็น
   `scripts/reconcile-decoy-warehouse.ts`) — เทียบทุก SKU ว่า
   `qty(warehouse='STOCK_ซิงก์ขายออนไลน์')` เท่ากับ `qty(ตำแหน่งชำรุด ภายใน STOCK_5)` หรือไม่
   ถ้าไม่เท่ากัน (ของถูกซ่อม/ทิ้ง/นับใหม่แล้วลืมอัปเดตอีกฝั่ง) ให้เขียนลง `SHEET_TRANSFER_EXCEPTIONS`
   ทันทีเป็นรายการแยก — เพราะแปลว่ายอดที่ยิงโชว์ออนไลน์กับของจริงไม่ตรงกันแล้ว
2. **ดึงสถานะ "ของขาด" จากคิวยืนยันออเดอร์เข้ามาด้วย** ตอน scrape หน้า order list (ใช้ page
   object เดียวกับข้อ 1 ของ spec หลัก) — ออเดอร์ที่มี badge/สถานะนี้คือสัญญาณยืนยันจาก BigSeller
   เองว่าเจอ shortage จริงแล้ว ให้ใส่ priority สูงสุดใน exception sheet และใช้เป็นตัวเช็คย้อนกลับว่า
   `effectiveAvailableStock` ที่คำนวณไว้แม่นพอหรือไม่ (ถ้า calc บอกว่าพอ แต่ BigSeller ขึ้นของขาด
   จริง แปลว่ามีบางอย่างตกหล่น ต้องสืบเพิ่ม ไม่ใช่เชื่อ calc เราเฉยๆ)

ทั้งสองอย่างนี้เป็น **safety net เพิ่มเติม** ไม่ใช่การแก้ bug ในโค้ดที่มีอยู่ — คงโครงสร้างเดิมทั้งหมด
ของ spec หลักด้านบนไว้

**สร้างเสร็จแล้วและทดสอบจริงแล้ว (2026-09-02) — เฉพาะข้อ 1 (reconciliation check):**
ใช้ page-object ที่มีอยู่แล้วตรงๆ ไม่ต้องสำรวจ DOM ใหม่ — `BigSellerInventoryPage`
(`selectPositionType('ตำแหน่งวางสินค้าชำรุด')` มีอยู่แล้วจากฟีเจอร์อื่น) สำหรับฝั่ง STOCK_5 กับ
`BigSellerSkuInventoryPage` filtered ไปที่ `STOCK_ซิงก์ขายออนไลน์` สำหรับฝั่งคลังหลอก โค้ด:
`src/services/decoy-reconciliation-service.ts`, `scripts/reconcile-decoy-warehouse.ts`
(`npm run reconcile:decoy-warehouse`) — เขียนลงตาราง Supabase `decoy_reconciliation_exceptions`
ที่มีอยู่แล้ว (replaceAll ทุกรอบ เก็บเฉพาะ SKU ที่ไม่ตรงกันตอนนี้)

**เจอบั๊กจริง 2 ตัวระหว่างทดสอบ:**
1. **Double-navigation race** — เรียก `.goto()` ต่อจาก `ensureSessionValid()` ทันที (ซึ่งไปหน้าเดียวกัน
   อยู่แล้ว) ทำให้ selector หาไม่เจอ แก้โดยเรียก `ensureLocationView()`/`ensureView()` ตรงๆ แทน (ตาม
   pattern ที่ `sync-service.ts` ใช้อยู่แล้ว ไม่ต้อง `.goto()` ซ้ำ)
2. **บั๊กสำคัญกว่า — BigSeller เปลี่ยน UI component ของตัวกรอง "คลังสินค้า"** จาก class
   `bs-antd_multiple_select` (Ant Design เดิม) เป็น `bs-new-select_multiple_select` (component ใหม่)
   ระหว่างวันที่ 26 ส.ค. (ยืนยันจาก log ว่า sync:inventory รันสำเร็จล่าสุดวันนี้) ถึงตอนที่เจอบั๊ก (2 ก.ย.)
   — **แก้ที่ `src/bigseller/inventory-page.ts` โดยตรง (shared code)** เพราะเป็นไฟล์เดียวกับที่
   `sync:inventory` หลักใช้อยู่ ให้ selector match ได้ทั้ง class เก่าและใหม่ — เช็ค log แล้วพบว่า
   scheduled task ของ `sync:inventory` หยุดทำงานไปตั้งแต่ 26 ส.ค. ด้วยเหตุผลอื่น (session หมดอายุ ถูก
   Ctrl+C หยุดเอง) เลยไม่มีหลักฐานว่าบั๊กนี้เคยทำให้ sync จริงพังจริง แต่ตอนนี้ป้องกันไว้ล่วงหน้าแล้ว
   ไม่ว่าจะรันตอนไหนก็ตาม

**ผลทดสอบจริง:** เทียบ 629 SKU เจอ 6 รายการไม่ตรงกันจริง (เช่น `FAN-KEY-MK896-ZORO-BL` คลังหลอกโชว์ 0
แต่ตำแหน่งชำรุดจริงมี 180 ชิ้น — เสี่ยงขายของชำรุดออนไลน์จริง) ยืนยันว่าฟีเจอร์นี้จับปัญหาจริงได้

**ยังไม่ได้ทำ:** ข้อ 2 (ดึงสถานะ "ของขาด" จากคิวยืนยันออเดอร์) — ยังไม่ได้เริ่ม

## Addendum 2 (2026-08-31): LockStock ปนเปื้อนรายงานยอดขาย/อันดับร้านค้าด้วย ไม่ใช่แค่สต็อก

พบเพิ่มเติมจากหน้า "อันดับของร้านค้า" ของ BigSeller เอง: ออเดอร์ LockStock (ซึ่งจริงๆ คือการกันสต็อก
ไม่ใช่การขายจริง) **ถูกนับรวมเป็นยอดขายเหมือนออเดอร์จริงทุกประการ** ในรายงานยอดขาย/อันดับร้านค้า
ของ BigSeller เอง (เคยเห็น LockStock ขึ้นเป็นร้านอันดับ 1 ด้านยอดขายแซงร้านค้าออนไลน์จริงทุกร้าน)

**อัปเดต (2026-08-31 รอบสอง) — ไม่ต้องกรองเองแล้ว มี native filter ให้พร้อมใช้:** หน้า "รายงานสินค้า"
(`web/statis/items.htm` → แท็บ "สรุปตาม SKU Merchant") มีตัวกรอง "กลุ่มร้านค้า" ที่มีตัวเลือก
**"ALL ไม่รวม lockstock,เคลม"** ให้เลือกตรงๆ อยู่แล้ว — ทีม BigSeller เองก็รู้ปัญหานี้และทำ filter
ไว้รองรับแล้ว **ไม่ต้องเขียน logic กรอง LockStock ออกเองจากรายงานยอดขาย** แค่เลือก filter นี้ตอน
scrape/export จากหน้านี้โดยตรง — ยังคงต้องกรองเองในกรณีที่ scrape จากหน้าอื่นที่ไม่มี filter แบบนี้ให้
(เช่นหน้า "อันดับของร้านค้า" ที่เจอปัญหาตอนแรก ยังต้องเช็คว่ามี filter คล้ายกันไหมก่อนใช้ตรงๆ)

รายละเอียดการ sync รายงานยอดขายออนไลน์/ออฟไลน์จากหน้านี้ ดูที่ `FEATURE-sales-online-offline-report.md`

## Addendum 3 (2026-09-09): ชีตเช็คสต็อกตำแหน่งหยิบเทียบคำสั่งซื้อใหม่ ทุกเช้า — สร้างเสร็จแล้ว

**คำขอผู้ใช้:** ทุกเช้า เช็คคำสั่งซื้อใหม่ว่ามี SKU รุ่นไหนบ้าง สรุปจำนวน แล้วเทียบกับสต็อกที่ตำแหน่ง
หยิบจริง (ไม่ใช่สต็อกรวมทั้งคลัง — แพ็คของดึงจากตำแหน่งหยิบเท่านั้น) พร้อมค่าที่ตั้งเติมสูงสุด/ต่ำสุด
ของตำแหน่งนั้น แยกเป็นชีตต่างหากให้พนักงานดู สีแดง = รุ่นที่หยิบไม่พอออเดอร์ ต้องเติมด่วน สีส้ม/เหลือง
= พอออเดอร์แต่ใกล้หมด

**เปิด `syncOrderDemand()` กลับมาอีกครั้ง แต่รันแค่วันละครั้งตอน 08:00 เท่านั้น** (ไม่ใช่กลับไปรันถี่ใน
`syncBigSeller()` เหมือนก่อนถูกปิดวันที่ 1 ก.ย. — คำสั่งปิดครั้งนั้นยังมีผลกับ pipeline หลักเหมือนเดิม
ดู comment ใน `sync-service.ts`) ยืนยันจากผู้ใช้ 2026-09-09 ว่ายอมเปิดกลับมาเฉพาะเพื่องานนี้

**สร้างเสร็จแล้วและทดสอบจริงแล้ว (2026-09-09):**
- `src/services/order-stock-check-service.ts` (`syncOrderStockCheck`) — pure aggregation อ่าน 3 ชีต
  ที่ sync อยู่แล้ว (`DB_PENDING_ORDER_DEMAND`, `DB_LOCATION_CURRENT` กรองเฉพาะ
  `positionType === INVENTORY_POSITION_TYPE_NAME` และ `warehouse === STOCK_5` เท่านั้น — ไม่นับคลังหลอก
  `STOCK_ซิงก์ขายออนไลน์` ตามกฎเดิม, `DB_SKU_INVENTORY`) ไม่เปิด browser เลย
- `scripts/sync-order-stock-check.ts` — เรียก `syncOrderDemand()` สดก่อน แล้วค่อยเรียก
  `syncOrderStockCheck()` ต่อในรันเดียวกัน (กัน race — ไม่ต้องพึ่ง 2 scheduled task แยกกันเรียงเวลา)
- `scripts/migrate-sheet-for-order-stock-check.ts` — one-time, สร้างชีต `EMPLOYEE_STOCK_CHECK_VIEW`
  พร้อม conditional-formatting 2 กฎ (highlight ทั้งแถว ไม่ใช่แค่ cell เดียว): สีแดงถ้า `status="แดง"`,
  สีส้มถ้า `status="ส้ม"` — รันแล้วครั้งเดียว (idempotent, รันซ้ำได้)
- `scripts/install-order-stock-check-task.ps1` — ผู้ใช้ต้องรันเองใน PowerShell แบบ elevated (Claude
  Code sandbox ไม่มีสิทธิ์ตั้ง Task Scheduler) เพื่อตั้ง `BigSeller-Sync-OrderStockCheck` ให้รันทุกวัน
  08:00 — **ยังไม่ได้รัน ผู้ใช้ต้องรันเอง**

**เกณฑ์สถานะ (ยืนยันจากผู้ใช้ 2026-09-09):**
- `แดง`: `pickPositionQty < orderDemandQty` (หยิบไม่พอออเดอร์วันนี้เลย)
- `ส้ม`: พอออเดอร์วันนี้ แต่ `pickPositionQty − orderDemandQty < pickMinStock` (จะเหลือต่ำกว่าเป้าต่ำสุด)
- `ปกติ`: เหลือ ≥ เป้าต่ำสุดหลังหักออเดอร์แล้ว

**ทดสอบจริงกับข้อมูลสด (2026-09-09):** 320 order-demand line → 174 SKU distinct → 14 แดง, 6 ส้ม,
154 ปกติ — เขียนลง `EMPLOYEE_STOCK_CHECK_VIEW` สำเร็จ, เรียงแดงขึ้นก่อนเสมอ

**ห้ามทำ:** ห้ามกลับไปเปิด `syncOrderDemand()` ใน `syncBigSeller()` เอง — ยังปิดไว้ตามคำสั่งเดิม 1 ก.ย.
งานนี้เรียกแยกเป็นสคริปต์ของตัวเองเท่านั้น
(ไฟล์ใหม่ — เป็นอีกงานหนึ่ง ไม่ใช่ส่วนหนึ่งของ spec หลักด้านบน)
