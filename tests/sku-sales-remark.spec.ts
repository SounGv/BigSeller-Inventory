import { test, expect } from '@playwright/test';
import { buildPriorityRemark } from '../src/services/sku-sales-service.js';

test.describe('buildPriorityRemark', () => {
  test('P1 shows the ขายดีมาก label with the 15-day total and daily average', () => {
    expect(buildPriorityRemark(1, 8)).toBe('[P1 ทำก่อน] ขายดีมาก | ยอดขาย15วัน 120 ชิ้น | เฉลี่ย 8/วัน');
  });

  test('P2 shows the ขายดี label, non-integer average keeps one decimal', () => {
    expect(buildPriorityRemark(2, 3.7)).toBe('[P2 ทำถัดไป] ขายดี | ยอดขาย15วัน 56 ชิ้น | เฉลี่ย 3.7/วัน');
  });

  test('P3 shows the มียอดขาย label', () => {
    expect(buildPriorityRemark(3, 0.8)).toBe('[P3 ทำตามคิว] มียอดขาย | ยอดขาย15วัน 12 ชิ้น | เฉลี่ย 0.8/วัน');
  });

  test('P4 shows no sales, ignores whatever avgDailySales is passed', () => {
    expect(buildPriorityRemark(4, 0)).toBe('[P4 ทำหลัง] ไม่มียอดขาย 15 วัน');
  });
});
