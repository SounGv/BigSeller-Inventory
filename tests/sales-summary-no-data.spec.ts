import { test, expect } from '@playwright/test';
import { dropTodayWithoutData } from '../src/services/sales-summary-service.js';

const row = (date: string, channel: string, amount: number, orders = amount > 0 ? 10 : 0) => ({
  date,
  channel,
  salesCount: amount,
  salesVolumeCount: orders,
  effectiveSalesAmount: amount,
  efficientsOrders: orders,
});

test.describe('dropTodayWithoutData', () => {
  test("leaves out today when BigSeller shows nothing for any channel yet", () => {
    const rows = [
      row('2026-11-18', 'online', 0), row('2026-11-18', 'offline', 0), row('2026-11-18', 'all', 0),
      row('2026-11-17', 'online', 1015203.51), row('2026-11-17', 'all', 3735985.31),
    ];
    expect(dropTodayWithoutData(rows, '2026-11-18').map((r) => r.date)).toEqual(['2026-11-17', '2026-11-17']);
  });

  test('keeps today once any channel has a figure', () => {
    const rows = [row('2026-11-18', 'online', 5200), row('2026-11-18', 'offline', 0), row('2026-11-17', 'all', 100)];
    expect(dropTodayWithoutData(rows, '2026-11-18')).toHaveLength(3);
  });

  test('keeps an older day with zero sales, because that is a real figure', () => {
    const rows = [row('2026-11-17', 'online', 0), row('2026-11-17', 'all', 0), row('2026-11-18', 'all', 900)];
    expect(dropTodayWithoutData(rows, '2026-11-18')).toHaveLength(3);
  });

  test('changes nothing when there are no rows for today', () => {
    const rows = [row('2026-11-17', 'all', 100)];
    expect(dropTodayWithoutData(rows, '2026-11-18')).toEqual(rows);
  });
});
