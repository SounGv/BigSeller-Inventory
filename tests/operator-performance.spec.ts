import { test, expect } from '@playwright/test';
import {
  OPERATOR_PERFORMANCE_EXPORT_HEADERS,
  buildOperatorPerformanceDryRunReport,
  buildOperatorPerformanceKey,
  parseOperatorPerformanceRow,
} from '../src/services/operator-performance-service.js';
import { parseThaiDateToIso } from '../src/utils/thai-date.js';

// Real row copied from the team v2 sheet tab "ผลงานพนักงาน (BigSeller)" (07 ก.ย. 2026).
function buildRealRow(overrides: Record<string, string> = {}): Record<string, string> {
  const values = [
    '07 ก.ย. 2026', 'toon@UJR3010716', '1', '760', '0', '429', '346', '0', '15', '428', '465', '0', '0', '0', '0', '0',
    '19', '757', '841', '0', '0', '0', '403', '24', '1', '0', '0', '0', '695', '21', '41',
  ];
  const row: Record<string, string> = {};
  OPERATOR_PERFORMANCE_EXPORT_HEADERS.forEach((header, index) => {
    row[header] = values[index];
  });
  return { ...row, ...overrides };
}

test.describe('parseThaiDateToIso', () => {
  test('reads a real date-only string', () => {
    expect(parseThaiDateToIso('07 ก.ย. 2026')).toBe('2026-09-07');
  });
  test('rejects garbage and impossible days', () => {
    expect(parseThaiDateToIso('2026-09-07')).toBeNull();
    expect(parseThaiDateToIso('31 ก.พ. 2026')).toBeNull();
    expect(parseThaiDateToIso('')).toBeNull();
  });
});

test.describe('parseOperatorPerformanceRow', () => {
  test('maps a real row to the same keys Apps Script serves', () => {
    const parsed = parseOperatorPerformanceRow(buildRealRow());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.row.date).toBe('2026-09-07');
    expect(parsed.row.operator).toBe('toon@UJR3010716');
    expect(parsed.row.metrics.printLabel).toBe(760);
    expect(parsed.row.metrics.pdaPick).toBe(429);
    expect(parsed.row.metrics.pickParcels).toBe(428);
    expect(parsed.row.metrics.packParcels).toBe(757);
    expect(parsed.row.metrics.packMultiSku).toBe(41);
    expect(Object.keys(parsed.row.metrics)).toHaveLength(29);
  });

  test('skips the export total row ("-") instead of rejecting it', () => {
    const parsed = parseOperatorPerformanceRow(buildRealRow({ 'โอเปอเรเตอร์': '-' }));
    expect(parsed).toEqual({ ok: false, skip: 'total_row' });
  });

  test('blank metric counts as 0, non-numeric text rejects the row', () => {
    const blank = parseOperatorPerformanceRow(buildRealRow({ 'จัดส่ง': '' }));
    expect(blank.ok && blank.row.metrics.ship).toBe(0);
    expect(parseOperatorPerformanceRow(buildRealRow({ 'จัดส่ง': 'n/a' })).ok).toBe(false);
  });

  test('rejects an unreadable date or a missing operator', () => {
    expect(parseOperatorPerformanceRow(buildRealRow({ 'วันที่': 'bad' })).ok).toBe(false);
    expect(parseOperatorPerformanceRow(buildRealRow({ 'โอเปอเรเตอร์': '' })).ok).toBe(false);
  });
});

test.describe('buildOperatorPerformanceDryRunReport', () => {
  test('counts reconcile: rows_in = to_insert + to_update + skipped', () => {
    const report = buildOperatorPerformanceDryRunReport([
      buildRealRow(),
      buildRealRow({ 'โอเปอเรเตอร์': 'u@UJR3010676' }),
      buildRealRow(), // repeat inside the same file
      buildRealRow({ 'โอเปอเรเตอร์': '-' }), // export total row
      buildRealRow({ 'วันที่': 'bad' }), // rejected
    ]);
    expect(report.rows_in).toBe(5);
    expect(report.to_insert).toBe(2);
    expect(report.skipped).toBe(3);
    expect(report.duplicate_count).toBe(1);
    expect(report.total_rows_skipped).toBe(1);
    expect(report.rejected).toHaveLength(1);
    expect(report.null_count['วันที่']).toBe(1);
    expect(report.rows_in).toBe(report.to_insert + report.to_update + report.skipped);
  });

  test('a stored day with the same numbers is skipped; revised numbers are an update', () => {
    const first = parseOperatorPerformanceRow(buildRealRow());
    if (!first.ok) throw new Error('fixture must parse');
    const existing = new Map([[buildOperatorPerformanceKey(first.row), first.row]]);

    const unchanged = buildOperatorPerformanceDryRunReport([buildRealRow()], existing);
    expect(unchanged.matched).toBe(1);
    expect(unchanged.to_insert + unchanged.to_update).toBe(0);

    const revised = buildOperatorPerformanceDryRunReport([buildRealRow({ 'จำนวนรวมพัสดุที่หยิบ': '500' })], existing);
    expect(revised.to_update).toBe(1);
    expect(revised.sample_diff[0].existing?.metrics.pickParcels).toBe(428);
    expect(revised.sample_diff[0].incoming.metrics.pickParcels).toBe(500);
  });
});
