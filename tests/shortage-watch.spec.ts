import { test, expect } from '@playwright/test';
import {
  aggregatePickStock,
  buildShortageMessages,
  findShortages,
  isWithinWatchHours,
  planShortageAlerts,
  sumDemandBySku,
  type ShortageState,
} from '../src/services/shortage-watch-service.js';
import type { PickPositionAgg } from '../src/services/order-stock-check-service.js';
import type { InventoryRow } from '../src/types.js';

const pick = (stockAtPosition: number, minStock = 0, positions = ['A-01']): PickPositionAgg => ({
  stockAtPosition,
  maxStock: 100,
  minStock,
  positions,
});

const invRow = (over: Partial<InventoryRow>): InventoryRow => ({
  sku: 'SKU-1',
  warehouse: 'STOCK_5',
  area: 'A',
  position: 'A-01',
  positionType: 'ตำแหน่งหยิบสินค้า',
  stockAtPosition: 5,
  lockedStock: 0,
  availableStock: 5,
  unshelvedStock: 0,
  maxStock: 50,
  minStock: 2,
  sourceUpdatedAt: '',
  sourceUrl: '',
  ...over,
});

test.describe('findShortages — a SKU is short when pending orders exceed pick-position stock', () => {
  test('exactly enough is not short; one more ordered is short by one', () => {
    const demand = new Map([['ENOUGH', 5], ['SHORT1', 6]]);
    const picks = new Map([['ENOUGH', pick(5)], ['SHORT1', pick(5)]]);
    const result = findShortages(demand, picks);
    expect(result.map((r) => r.sku)).toEqual(['SHORT1']);
    expect(result[0].short).toBe(1);
  });

  test('a SKU with no pick position at all is short by its whole order quantity', () => {
    const result = findShortages(new Map([['NOPOS', 4]]), new Map());
    expect(result).toEqual([{ sku: 'NOPOS', orderDemandQty: 4, pickPositionQty: 0, short: 4, positions: '' }]);
  });

  test('worst gap first, ties by SKU', () => {
    const demand = new Map([['B', 10], ['A', 10], ['C', 30]]);
    const picks = new Map([['A', pick(5)], ['B', pick(5)], ['C', pick(5)]]);
    expect(findShortages(demand, picks).map((r) => r.sku)).toEqual(['C', 'A', 'B']);
  });

  test('orange (above zero but below min stock) is NOT a shortage', () => {
    expect(findShortages(new Map([['ORANGE', 4]]), new Map([['ORANGE', pick(5, 3)]]))).toEqual([]);
  });
});

test.describe('planShortageAlerts — announce once, forget when resolved', () => {
  const shortage = (sku: string) => ({ sku, orderDemandQty: 9, pickPositionQty: 1, short: 8, positions: 'A-01' });
  const empty: ShortageState = { alerted: {} };

  test('first sight is announced and remembered', () => {
    const plan = planShortageAlerts([shortage('X')], empty, '2026-11-24T08:00:00Z');
    expect(plan.toAlert.map((s) => s.sku)).toEqual(['X']);
    expect(Object.keys(plan.nextState.alerted)).toEqual(['X']);
  });

  test('still short next round: not announced again', () => {
    const first = planShortageAlerts([shortage('X')], empty, '2026-11-24T08:00:00Z');
    const second = planShortageAlerts([shortage('X')], first.nextState, '2026-11-24T08:10:00Z');
    expect(second.toAlert).toEqual([]);
    expect(second.alreadyAlertedCount).toBe(1);
    expect(second.nextState.alerted['X'].firstAlertedAt).toBe('2026-11-24T08:00:00Z');
  });

  test('stops being short, then short again: announced again', () => {
    const first = planShortageAlerts([shortage('X')], empty, '2026-11-24T08:00:00Z');
    const resolved = planShortageAlerts([], first.nextState, '2026-11-24T08:10:00Z');
    expect(resolved.nextState.alerted).toEqual({});
    const again = planShortageAlerts([shortage('X')], resolved.nextState, '2026-11-24T08:20:00Z');
    expect(again.toAlert.map((s) => s.sku)).toEqual(['X']);
  });

  test('limit caps what is announced and remembered; the rest stay pending for the next round', () => {
    const many = ['A', 'B', 'C', 'D'].map(shortage);
    const plan = planShortageAlerts(many, empty, '2026-11-24T08:00:00Z', 2);
    expect(plan.toAlert.map((s) => s.sku)).toEqual(['A', 'B']);
    expect(Object.keys(plan.nextState.alerted).sort()).toEqual(['A', 'B']);
  });

  test('keeps the session-expiry date it was given', () => {
    const plan = planShortageAlerts([], { alerted: {}, lastSessionAlertDate: '2026-11-24' }, '2026-11-24T08:00:00Z');
    expect(plan.nextState.lastSessionAlertDate).toBe('2026-11-24');
  });
});

test.describe('buildShortageMessages', () => {
  const shortage = (n: number) => ({ sku: `S${String(n).padStart(3, '0')}`, orderDemandQty: 9, pickPositionQty: 1, short: 8, positions: 'A-01, B-02' });

  test('nothing to announce means no message', () => {
    expect(buildShortageMessages([], '14:30')).toEqual([]);
  });

  test('one bubble, header shows count and time, line shows first position', () => {
    const [msg] = buildShortageMessages([shortage(1)], '14:30');
    expect(msg).toContain('14:30');
    expect(msg).toContain('1 รายการ');
    expect(msg).toContain('• S001  สั่ง 9 / ตำแหน่งหยิบมี 1  ขาด 8  [A-01]');
  });

  test('long lists are split into bubbles and the overflow is counted, never silently dropped', () => {
    const many = Array.from({ length: 100 }, (_, i) => shortage(i));
    const bubbles = buildShortageMessages(many, '14:30');
    expect(bubbles.length).toBe(4); // 4 x 20 = 80 shown
    expect(bubbles[3]).toContain('และอีก 20 รายการ');
    for (const b of bubbles) expect(b.length).toBeLessThan(5000);
  });
});

test.describe('isWithinWatchHours (Asia/Bangkok, Mon–Sat)', () => {
  // 2026-11-24 is a Tuesday; Bangkok is UTC+7, so 07:00Z = 14:00 local.
  test('inside the window on a weekday', () => {
    expect(isWithinWatchHours(new Date('2026-11-24T07:00:00Z'))).toBe(true);
  });
  test('before opening and after closing', () => {
    expect(isWithinWatchHours(new Date('2026-11-24T01:00:00Z'))).toBe(false); // 08:00
    expect(isWithinWatchHours(new Date('2026-11-24T11:45:00Z'))).toBe(false); // 18:45
  });
  test('Saturday counts, Sunday does not', () => {
    expect(isWithinWatchHours(new Date('2026-11-28T07:00:00Z'))).toBe(true);
    expect(isWithinWatchHours(new Date('2026-11-29T07:00:00Z'))).toBe(false);
  });
  test('uses Bangkok time, not the host clock: 23:00Z Monday is already Tuesday 06:00 — closed', () => {
    expect(isWithinWatchHours(new Date('2026-11-23T23:00:00Z'))).toBe(false);
  });
});

test.describe('aggregatePickStock and sumDemandBySku', () => {
  test('sums a SKU across its pick positions and drops other warehouses, storage positions and placeholders', () => {
    const map = aggregatePickStock([
      invRow({ position: 'A-01', stockAtPosition: 5 }),
      invRow({ position: 'A-02', stockAtPosition: 3 }),
      invRow({ warehouse: 'STOCK_ซิงก์ขายออนไลน์', stockAtPosition: 99 }),
      invRow({ positionType: 'ตำแหน่งเก็บสินค้า', stockAtPosition: 77 }),
      invRow({ position: 'ไม่มีตำแหน่งหยิบ', stockAtPosition: 66 }),
      invRow({ position: 'ของแถม-1', stockAtPosition: 55 }),
    ]);
    expect(map.get('SKU-1')?.stockAtPosition).toBe(8);
    expect(map.get('SKU-1')?.positions).toEqual(['A-01', 'A-02']);
  });

  test('totals demand per SKU and ignores unreadable lines', () => {
    const map = sumDemandBySku([
      { sku: 'A', qty: 2 },
      { sku: 'A', qty: 3 },
      { sku: ' ', qty: 9 },
      { sku: 'B', qty: Number.NaN },
    ]);
    expect([...map.entries()]).toEqual([['A', 5]]);
  });
});
