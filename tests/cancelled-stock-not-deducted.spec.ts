import { test, expect } from '@playwright/test';
import { hasUndeductedStock } from '../src/bigseller/cancelled-orders-page.js';

test.describe('hasUndeductedStock', () => {
  test('label printed, allocated short of quantity — flags as not deducted (real case BSUJR3N91533)', () => {
    expect(
      hasUndeductedStock({
        printLabelMark: 1,
        printShipLabelMark: null,
        orderItemList: [{ quantity: 1, allocated: 0, refundQuantity: null }],
      }),
    ).toBe(true);
  });

  test('label printed, allocated matches quantity — not flagged (real case BSUJR3N90980)', () => {
    expect(
      hasUndeductedStock({
        printLabelMark: 1,
        printShipLabelMark: null,
        orderItemList: [{ quantity: 1, allocated: 1, refundQuantity: null }],
      }),
    ).toBe(false);
  });

  test('label never printed — not flagged even if allocated is short', () => {
    expect(
      hasUndeductedStock({
        printLabelMark: 0,
        printShipLabelMark: null,
        orderItemList: [{ quantity: 1, allocated: 0, refundQuantity: null }],
      }),
    ).toBe(false);
  });

  test('printShipLabelMark alone also counts as printed', () => {
    expect(
      hasUndeductedStock({
        printLabelMark: null,
        printShipLabelMark: 1,
        orderItemList: [{ quantity: 2, allocated: 1, refundQuantity: null }],
      }),
    ).toBe(true);
  });

  test('partial refund lowers the needed amount, so a matching partial allocation is not flagged', () => {
    expect(
      hasUndeductedStock({
        printLabelMark: 1,
        printShipLabelMark: null,
        orderItemList: [{ quantity: 2, allocated: 1, refundQuantity: 1 }],
      }),
    ).toBe(false);
  });

  test('multi-line order flags if any single line is short', () => {
    expect(
      hasUndeductedStock({
        printLabelMark: 1,
        printShipLabelMark: null,
        orderItemList: [
          { quantity: 1, allocated: 1, refundQuantity: null },
          { quantity: 1, allocated: 0, refundQuantity: null },
        ],
      }),
    ).toBe(true);
  });

  test('no order items at all — not flagged', () => {
    expect(hasUndeductedStock({ printLabelMark: 1, printShipLabelMark: null, orderItemList: null })).toBe(false);
  });
});
