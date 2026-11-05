import { test, expect } from '@playwright/test';
import {
  buildStockMoveDryRunReport,
  buildStockMoveKey,
  parseStockMoveRow,
} from '../src/services/stock-move-log-service.js';

// Real rows copied from the team v2 sheet tab "บันทึกการอัปเดตตำแหน่งสต็อก (BigSeller)".
const STOCK_IN_ROW: Record<string, string> = {
  'ชื่อSKU': 'FAN-SPK-GS306-BK',
  'ชื่อ SKU': 'FANTECH # Gaming Speaker GS306 BEAT PRO BT 5.4 and 1.5 M USB-A (Black)',
  'ปัญชี': 'St_ter@UJR3128999',
  'เวลา': '08 ก.ย. 2026 10:23',
  'ชื่อคลังสินค้า': 'STOCK_5',
  'ตำแหน่ง': 'F02-03-08',
  'มิติสต็อกสินค้า': 'สต็อกที่มีอยู่',
  'หน่วยพื้นฐาน': 'PCS',
  'สต็อกเดิม': '167',
  'เคลื่อนไหว': '1',
  'สต็อกล่าสุด': '168',
  'ประเภท': 'Stock-In / APP ย้ายและนำเข้าชั้นวาง',
  'หมายเลขเอกสาร': 'REUJR3208518',
};

const STOCK_OUT_ROW: Record<string, string> = {
  ...STOCK_IN_ROW,
  'มิติสต็อกสินค้า': 'สต็อกที่ยังไม่นำเข้าชั้นวาง',
  'สต็อกเดิม': '1',
  'เคลื่อนไหว': '-1',
  'สต็อกล่าสุด': '0',
  'ประเภท': 'Stock-Out / APP ย้ายและนำเข้าชั้นวาง',
};

test.describe('parseStockMoveRow', () => {
  test('maps a real stock-in row and pins the time to +07:00', () => {
    const parsed = parseStockMoveRow(STOCK_IN_ROW);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.row.skuCode).toBe('FAN-SPK-GS306-BK');
    expect(parsed.row.movedAt).toBe('2026-09-08T10:23:00+07:00');
    expect(parsed.row.snapshotDate).toBe('2026-09-08');
    expect(parsed.row.stockBefore).toBe(167);
    expect(parsed.row.stockChange).toBe(1);
    expect(parsed.row.stockAfter).toBe(168);
    expect(parsed.row.documentNo).toBe('REUJR3208518');
    expect(parsed.row.reservedOrderNo).toBeNull();
  });

  test('reads a negative movement from a real stock-out row', () => {
    const parsed = parseStockMoveRow(STOCK_OUT_ROW);
    expect(parsed.ok && parsed.row.stockChange).toBe(-1);
  });

  test('rejects an unreadable timestamp instead of guessing', () => {
    const parsed = parseStockMoveRow({ ...STOCK_IN_ROW, 'เวลา': '2026-09-08' });
    expect(parsed.ok).toBe(false);
  });

  test('rejects a missing document number and a non-numeric stock figure', () => {
    expect(parseStockMoveRow({ ...STOCK_IN_ROW, 'หมายเลขเอกสาร': '' }).ok).toBe(false);
    expect(parseStockMoveRow({ ...STOCK_IN_ROW, 'สต็อกล่าสุด': 'n/a' }).ok).toBe(false);
  });
});

test.describe('buildStockMoveDryRunReport', () => {
  test('counts reconcile: rows_in = to_insert + to_update + skipped', () => {
    const report = buildStockMoveDryRunReport([
      STOCK_IN_ROW,
      STOCK_OUT_ROW,
      STOCK_IN_ROW, // repeat inside the same file
      { ...STOCK_IN_ROW, 'เวลา': 'bad' }, // rejected
    ]);
    expect(report.rows_in).toBe(4);
    expect(report.to_insert).toBe(2);
    expect(report.to_update).toBe(0);
    expect(report.skipped).toBe(2);
    expect(report.duplicate_count).toBe(1);
    expect(report.rejected).toHaveLength(1);
    expect(report.null_count['เวลา']).toBe(1);
    expect(report.rows_in).toBe(report.to_insert + report.to_update + report.skipped);
  });

  test('a row already stored unchanged is matched and skipped; a changed one is an update', () => {
    const first = parseStockMoveRow(STOCK_IN_ROW);
    if (!first.ok) throw new Error('fixture must parse');
    const existing = new Map([[buildStockMoveKey(first.row), first.row]]);

    const unchanged = buildStockMoveDryRunReport([STOCK_IN_ROW], existing);
    expect(unchanged.matched).toBe(1);
    expect(unchanged.to_insert + unchanged.to_update).toBe(0);
    expect(unchanged.skipped).toBe(1);

    const changed = buildStockMoveDryRunReport([{ ...STOCK_IN_ROW, 'ปัญชี': 'someone_else@UJR1' }], existing);
    expect(changed.matched).toBe(1);
    expect(changed.to_update).toBe(1);
    expect(changed.sample_diff[0].existing?.operatorAccount).toBe('St_ter@UJR3128999');
    expect(changed.sample_diff[0].incoming.operatorAccount).toBe('someone_else@UJR1');
  });

  test('two chained moves in the same minute are not collapsed as duplicates', () => {
    const secondMove = { ...STOCK_IN_ROW, 'สต็อกเดิม': '168', 'สต็อกล่าสุด': '169' };
    const report = buildStockMoveDryRunReport([STOCK_IN_ROW, secondMove]);
    expect(report.duplicate_count).toBe(0);
    expect(report.to_insert).toBe(2);
  });

  test('flags a row whose stock figures do not add up, without rejecting it', () => {
    const report = buildStockMoveDryRunReport([{ ...STOCK_IN_ROW, 'สต็อกล่าสุด': '170' }]);
    expect(report.arithmetic_mismatch_count).toBe(1);
    expect(report.to_insert).toBe(1);
  });
});
