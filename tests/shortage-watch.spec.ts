import { test, expect } from '@playwright/test';
import {
  buildDemand,
  buildPrealertMessage,
  buildStockBySku,
  excludeBufferSkus,
  findShortages,
  formatNowText,
  isWithinWatchHours,
  planPrealert,
  urgentShortagesOnly,
  type RawOrder,
  type ShelfRow,
  type Shortage,
} from '../src/services/shortage-watch-service.js';

const shelf = (over: Partial<ShelfRow>): ShelfRow => ({ sku: 'A', shelfType: 0, shelfName: 'P-01', onhand: 10, available: 10, ...over });

const order = (over: Partial<RawOrder> & { items?: RawOrder['items'] }): RawOrder => ({
  platform: 'shopee',
  warehouseId: 49484,
  shipmentWarehouse: 'STOCK_5',
  carrier: 'Shopee-TH-SPX Express',
  option: '',
  items: [],
  ...over,
});
const item = (sku: string, quantity: number, allocated = 0) => ({ quantity, allocated, inventorySku: sku, group: [] });

test.describe('buildStockBySku', () => {
  test('splits pick / storage / ZZZZ / damaged and uses AVAILABLE for the pick position', () => {
    const s = buildStockBySku([
      shelf({ shelfType: 0, onhand: 10, available: 7 }),
      shelf({ shelfType: 0, shelfName: 'P-02', onhand: 5, available: 5 }),
      shelf({ shelfType: 1, shelfName: 'S-01', onhand: 100 }),
      shelf({ shelfType: 1, shelfName: 'ZZZZ', onhand: 40 }),
      shelf({ shelfType: 2, shelfName: 'D-01', onhand: 3 }),
    ]);
    expect(s['A']).toEqual({ pickOn: 15, pickAv: 12, storOn: 140, damOn: 3, zzzz: 40 });
  });
  test('ignores rows with no SKU', () => {
    expect(buildStockBySku([shelf({ sku: '' })])).toEqual({});
  });
});

test.describe('buildDemand — only what BigSeller has not locked yet', () => {
  test('quantity minus allocated; fully allocated lines add nothing', () => {
    const d = buildDemand([order({ items: [item('A', 10, 4), item('B', 3, 3), item('C', 2, 9)] })]);
    expect(d.demand).toEqual({ A: 6 });
  });
  test('only STOCK_5 orders count (by id or by name)', () => {
    const d = buildDemand([
      order({ items: [item('A', 1)] }),
      order({ warehouseId: 1, shipmentWarehouse: 'Test01', items: [item('A', 5)] }),
      order({ warehouseId: 1, shipmentWarehouse: 'STOCK_5', items: [item('A', 2)] }),
    ]);
    expect(d.demand['A']).toBe(3);
    expect(d.ordersUsed).toBe(2);
  });
  test('only Shopee / Lazada / TikTok orders count; manual and other platforms are ignored', () => {
    const d = buildDemand([
      order({ platform: 'shopee', items: [item('A', 1)] }),
      order({ platform: 'Lazada', items: [item('A', 2)] }),
      order({ platform: 'tiktok', items: [item('A', 4)] }),
      order({ platform: 'manual', items: [item('A', 100)] }),
      order({ platform: undefined, items: [item('A', 200)] }),
    ]);
    expect(d.demand['A']).toBe(7);
    expect(d.ordersUsed).toBe(3);
  });
  test('a bundle line is split into its child SKUs x num x remaining quantity', () => {
    const d = buildDemand([
      order({ items: [{ quantity: 3, allocated: 1, inventorySku: 'GIFT-1', group: [{ varSku: 'X', num: 2 }, { varSku: 'Y', num: 1 }] }] }),
    ]);
    expect(d.demand).toEqual({ X: 4, Y: 2 });
  });
  test('urgent carriers are tracked per carrier; ordinary carriers are not urgent', () => {
    const d = buildDemand([
      order({ carrier: 'Shopee-TH-Instant Delivery - Grab', items: [item('A', 2)] }),
      order({ carrier: 'Shopee-TH-Express Delivery (SPX)', items: [item('A', 3)] }),
      order({ carrier: 'Lazada-TH-LEX', items: [item('A', 7)] }),
      order({ carrier: 'TikTok-TH-J&T Express', items: [item('A', 1)] }),
    ]);
    expect(d.demand['A']).toBe(13);
    expect(d.urgent['A']).toBe(5);
    expect(d.urgentOrders).toBe(2);
    expect(Object.keys(d.urgentBy['A']).sort()).toEqual(['Express Delivery (SPX)', 'Grab']);
  });
});

test.describe('excludeBufferSkus — SKUs with buffer stock are not pre-alerted', () => {
  test('a short SKU with damaged-position stock is left out; one without it stays', () => {
    const stock = buildStockBySku([
      shelf({ sku: 'WITH', available: 0, onhand: 0 }),
      shelf({ sku: 'WITH', shelfType: 2, shelfName: 'P/01', onhand: 27, available: 27 }),
      shelf({ sku: 'WITHOUT', available: 0, onhand: 0 }),
    ]);
    const d = buildDemand([order({ items: [item('WITH', 1), item('WITHOUT', 1), item('NOROW', 1)] })]);
    const kept = excludeBufferSkus(findShortages(d, stock), stock);
    expect(kept.map((x) => x.sku).sort()).toEqual(['NOROW', 'WITHOUT']);
  });
});

test.describe('findShortages / urgentShortagesOnly', () => {
  const stock = buildStockBySku([shelf({ sku: 'A', available: 5, onhand: 5 }), shelf({ sku: 'B', available: 9, onhand: 9 })]);

  test('short only when remaining demand exceeds AVAILABLE pick stock; exactly enough is fine', () => {
    const d = buildDemand([order({ items: [item('A', 6), item('B', 9)] })]);
    const s = findShortages(d, stock);
    expect(s.map((x) => x.sku)).toEqual(['A']);
    expect(s[0]).toMatchObject({ need: 6, pick: 5, gap: 1 });
  });
  test('a SKU with no stock row is short by its whole demand', () => {
    const s = findShortages(buildDemand([order({ items: [item('NEW', 4)] })]), stock);
    expect(s[0]).toMatchObject({ sku: 'NEW', pick: 0, gap: 4 });
  });
  test('refill = storage minus ZZZZ (still being produced)', () => {
    const st = buildStockBySku([shelf({ sku: 'A', available: 0 }), shelf({ sku: 'A', shelfType: 1, shelfName: 'S', onhand: 50 }), shelf({ sku: 'A', shelfType: 1, shelfName: 'ZZZZ', onhand: 20 })]);
    const s = findShortages(buildDemand([order({ items: [item('A', 5)] })]), st);
    expect(s[0]).toMatchObject({ storage: 50, zzzz: 20 });
  });
  test('worst gap first; only shortages that include an urgent order go to LINE', () => {
    const d = buildDemand([
      order({ items: [item('A', 6)] }),
      order({ carrier: 'Shopee-TH-Instant Delivery', items: [item('B', 30)] }),
    ]);
    const all = findShortages(d, stock);
    expect(all.map((x) => x.sku)).toEqual(['B', 'A']);
    expect(urgentShortagesOnly(all).map((x) => x.sku)).toEqual(['B']);
  });
});

test.describe('planPrealert — once per SKU per day', () => {
  const sh = (sku: string): Shortage => ({ sku, need: 9, pick: 1, gap: 8, storage: 0, zzzz: 0, urgent: 9, by: { Grab: 9 } });

  test('first sight of the day is announced and remembered', () => {
    const p = planPrealert([sh('X')], { sent: [] }, '2026-11-24');
    expect(p.toAlert.map((s) => s.sku)).toEqual(['X']);
    expect(p.nextState).toEqual({ date: '2026-11-24', sent: ['X'] });
  });
  test('same day, still short: not announced again', () => {
    const p = planPrealert([sh('X')], { date: '2026-11-24', sent: ['X'] }, '2026-11-24');
    expect(p.toAlert).toEqual([]);
    expect(p.alreadyAlertedCount).toBe(1);
  });
  test('next day: announced again', () => {
    const p = planPrealert([sh('X')], { date: '2026-11-23', sent: ['X'] }, '2026-11-24');
    expect(p.toAlert.map((s) => s.sku)).toEqual(['X']);
    expect(p.nextState.sent).toEqual(['X']);
  });
  test('stops being short and short again the same day: still NOT repeated (the older routine\'s rule)', () => {
    const p = planPrealert([sh('X')], { date: '2026-11-24', sent: ['X'] }, '2026-11-24');
    expect(p.toAlert).toEqual([]);
  });
  test('limit caps what is announced and remembered', () => {
    const p = planPrealert(['A', 'B', 'C'].map(sh), { sent: [] }, '2026-11-24', 2);
    expect(p.toAlert.map((s) => s.sku)).toEqual(['A', 'B']);
    expect(p.nextState.sent).toEqual(['A', 'B']);
  });
});

test.describe('buildPrealertMessage — the older routine\'s template', () => {
  const sh = (n: number, over: Partial<Shortage> = {}): Shortage => ({ sku: `S${String(n).padStart(3, '0')}`, need: 1200, pick: 3, gap: 1197, storage: 50, zzzz: 0, urgent: 40, by: { 'Express Delivery (SPX)': 30, Grab: 10 }, ...over });

  test('nothing to announce means no message', () => {
    expect(buildPrealertMessage([], 'NOW')).toBeNull();
  });
  test('one block shows need, urgent carriers, pick stock, gap and refill advice', () => {
    const text = buildPrealertMessage([sh(1)], '🕐 24/11/2026 15:29 น.')!;
    expect(text.startsWith('⏰ เร่งเติมตำแหน่งหยิบ\nออเดอร์ด่วน (ยังไม่ยืนยัน) ทำให้ของในตำแหน่งหยิบไม่พอ\n🕐 24/11/2026 15:29 น.')).toBe(true);
    expect(text).toContain('1) S001\nต้องใช้ 1,200 ชิ้น');
    expect(text).toContain('🚚 ด่วน 40 ชิ้น: Express Delivery (SPX) 30, Grab 10');
    expect(text).toContain('ตำแหน่งหยิบมี 3 ชิ้น\n❗ ขาด 1,197 ชิ้น');
    expect(text).toContain('✅ เติมจากที่จัดเก็บได้ 50 ชิ้น');
  });
  test('refill advice: ZZZZ wait, or nothing to refill', () => {
    expect(buildPrealertMessage([sh(1, { storage: 0, zzzz: 20 })], 'N')).toContain('⏳ รอของจาก ZZZZ 20 ชิ้น (ยังผลิตไม่เสร็จ)');
    expect(buildPrealertMessage([sh(1, { storage: 0, zzzz: 0 })], 'N')).toContain('🚫 ที่จัดเก็บไม่มีของ ต้องหาของ');
  });
  test('shows at most 15 SKUs and counts the rest', () => {
    const text = buildPrealertMessage(Array.from({ length: 20 }, (_, i) => sh(i)), 'N')!;
    expect(text).toContain('15) S014');
    expect(text).not.toContain('16) ');
    expect(text).toContain('…และอีก 5 รุ่น');
    expect(text.length).toBeLessThanOrEqual(4500);
  });
});

test.describe('formatNowText / isWithinWatchHours (Asia/Bangkok, Mon–Sat)', () => {
  test('formats Bangkok time, not the host clock', () => {
    expect(formatNowText(new Date('2026-11-24T08:29:00Z'))).toBe('🕐 24/11/2026 15:29 น.');
  });
  test('inside the window on a weekday; before opening and after closing', () => {
    expect(isWithinWatchHours(new Date('2026-11-24T07:00:00Z'))).toBe(true); // 14:00
    expect(isWithinWatchHours(new Date('2026-11-24T00:30:00Z'))).toBe(false); // 07:30
    expect(isWithinWatchHours(new Date('2026-11-24T11:00:00Z'))).toBe(false); // 18:00
  });
  test('Saturday counts, Sunday does not', () => {
    expect(isWithinWatchHours(new Date('2026-11-28T07:00:00Z'))).toBe(true);
    expect(isWithinWatchHours(new Date('2026-11-29T07:00:00Z'))).toBe(false);
  });
  test('23:00Z Monday is already Tuesday 06:00 in Bangkok — closed', () => {
    expect(isWithinWatchHours(new Date('2026-11-23T23:00:00Z'))).toBe(false);
  });
});
