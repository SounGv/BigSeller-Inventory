import { test, expect } from '@playwright/test';
import { assignPriorities, buildMessages, type DocumentInfo, type TransferBillCreatedInput } from '../src/services/line-notify-service.js';

function doc(overrides: Partial<DocumentInfo> = {}): DocumentInfo {
  return { documentNumber: 'REUJR0000000', zone: 'PC', score: 0, ...overrides };
}

function input(overrides: Partial<TransferBillCreatedInput> = {}): TransferBillCreatedInput {
  return {
    runId: 'RUN1',
    runDateTime: '25 ส.ค. 2569 12:05',
    warehouse: 'STOCK_5',
    skuCount: 1,
    moveRowCount: 1,
    totalMoveQty: 10,
    documents: [doc()],
    ...overrides,
  };
}

test.describe('assignPriorities', () => {
  test('a zero-score document always lands in P4 ("ไม่มียอดขาย"), regardless of how many other documents there are', () => {
    const documents = [
      doc({ documentNumber: 'HAS_SALES', score: 5 }),
      doc({ documentNumber: 'NO_SALES', score: 0 }),
    ];
    const priorities = assignPriorities(documents);
    expect(priorities.get('NO_SALES')).toBe(4);
  });

  test('splits documents WITH sales (score > 0) into 3 even groups for P1/P2/P3', () => {
    const documents = Array.from({ length: 9 }, (_, i) => doc({ documentNumber: `D${i}`, score: 9 - i })); // D0 highest .. D8 lowest, all > 0
    const priorities = assignPriorities(documents);
    expect(priorities.get('D0')).toBe(1);
    expect(priorities.get('D1')).toBe(1);
    expect(priorities.get('D2')).toBe(1);
    expect(priorities.get('D3')).toBe(2);
    expect(priorities.get('D4')).toBe(2);
    expect(priorities.get('D5')).toBe(2);
    expect(priorities.get('D6')).toBe(3);
    expect(priorities.get('D7')).toBe(3);
    expect(priorities.get('D8')).toBe(3);
  });

  test('handles zero documents without throwing', () => {
    expect(assignPriorities([]).size).toBe(0);
  });

  test('every document lands in P4 when no document has any sales data', () => {
    const documents = Array.from({ length: 4 }, (_, i) => doc({ documentNumber: `D${i}`, score: 0 }));
    const priorities = assignPriorities(documents);
    expect(priorities.size).toBe(4);
    for (const p of priorities.values()) expect(p).toBe(4);
  });

  test('a mix of scored and unscored documents never puts a zero-score one ahead of P4, even when scored documents are few', () => {
    const documents = [
      doc({ documentNumber: 'TOP', score: 10 }),
      doc({ documentNumber: 'ZERO1', score: 0 }),
      doc({ documentNumber: 'ZERO2', score: 0 }),
      doc({ documentNumber: 'ZERO3', score: 0 }),
    ];
    const priorities = assignPriorities(documents);
    expect(priorities.get('TOP')).toBe(1); // the only scored doc -> its own single group -> P1
    expect(priorities.get('ZERO1')).toBe(4);
    expect(priorities.get('ZERO2')).toBe(4);
    expect(priorities.get('ZERO3')).toBe(4);
  });
});

test.describe('buildMessages', () => {
  test('a normal-sized run fits in a single message', () => {
    const messages = buildMessages(input());
    expect(messages).toHaveLength(1);
  });

  test('includes the required header fields, excludes anything not in the spec', () => {
    const [text] = buildMessages(input({ warehouse: 'STOCK_5', skuCount: 5, totalMoveQty: 42, documents: [doc()] }));
    expect(text).toContain('📦 แจ้งงานเติมสต็อก');
    expect(text).toContain('รอบงาน: 25 ส.ค. 2569 12:05');
    expect(text).toContain('คลังสินค้า: STOCK_5');
    expect(text).toContain('SKU: 5 รุ่น');
    expect(text).toContain('จำนวนรวม: 42 ชิ้น');
    expect(text).not.toContain('docs.google.com'); // no Google Sheets link, per explicit request
    expect(text).not.toContain('วิธีทำงาน'); // how-to/link block cut per explicit user request (2026-08-25)
    expect(text).not.toContain('bigseller.com/web/inventory/movingGoods'); // link cut too
  });

  test('P1 section lists real document numbers grouped by zone', () => {
    // 5 documents ranked by score -> quartile split puts the top 2 (highest score) in P1.
    const documents = [
      doc({ documentNumber: 'REUJR1', zone: 'PC', score: 25 }),
      doc({ documentNumber: 'REUJR2', zone: 'PC', score: 20 }),
      doc({ documentNumber: 'REUJR3', zone: 'PC', score: 15 }),
      doc({ documentNumber: 'REUJR4', zone: 'PC', score: 10 }),
      doc({ documentNumber: 'REUJR5', zone: 'PC', score: 5 }),
    ];
    const [text] = buildMessages(input({ documents }));
    expect(text).toContain('🔴 P1 ขายดีมาก ทำก่อน');
    expect(text).toContain('โซน PC (2 ใบ): REUJR1, REUJR2');
  });

  test('P2-P4 sections show zone + count only, never individual document numbers', () => {
    // 3 scored documents split 1-each across P1/P2/P3, plus 1 zero-score document -> P4.
    const documents = [
      doc({ documentNumber: 'D1', zone: 'A', score: 30 }),
      doc({ documentNumber: 'D2', zone: 'B', score: 20 }),
      doc({ documentNumber: 'D3', zone: 'C', score: 10 }),
      doc({ documentNumber: 'D4', zone: 'D', score: 0 }),
    ];
    const [text] = buildMessages(input({ documents }));
    expect(text).toContain('โซน B (1 ใบ)');
    expect(text).not.toContain('D2'); // P2's own document number must not leak into the text
    expect(text).toContain('โซน D (1 ใบ)');
    expect(text).not.toContain('D4');
  });

  test('splits into multiple message bubbles, capped at 5, when the combined text would run long', () => {
    // Every document in its own zone maximizes per-line overhead ("โซน X (1 ใบ): ...")
    // relative to document count, reliably blowing past the soft length limit.
    const documents = Array.from({ length: 400 }, (_, i) =>
      doc({ documentNumber: `REUJR${1000 + i}`, zone: `ZONE-${i}`, score: 400 - i }),
    );
    const messages = buildMessages(input({ documents }));
    expect(messages.length).toBeGreaterThan(1);
    expect(messages.length).toBeLessThanOrEqual(5);
    // The header (totals) must survive in the first bubble even when split.
    expect(messages[0]).toContain('📦 แจ้งงานเติมสต็อก');
  });

  test('shows "(ไม่มีรายการ)" for a priority tier with no documents', () => {
    const [text] = buildMessages(input({ documents: [doc({ score: 100 })] })); // only 1 doc -> lands in P1, P2-P4 empty
    expect(text).toContain('(ไม่มีรายการ)');
  });
});
