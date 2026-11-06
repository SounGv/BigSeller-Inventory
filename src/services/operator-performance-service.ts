import { parseThaiDateToIso } from '../utils/thai-date.js';

/**
 * The 29 metric columns of BigSeller's "รายงานผลการทำงาน" export
 * (`bigseller.com/web/statis/packagedAnalytics.htm`), taken from the
 * "ผลงานพนักงาน (BigSeller)" tab of the team v2 sheet, which is a verbatim
 * paste of that export. `key` matches the field names Apps Script already
 * serves to the dashboard (`WORK_PERFORMANCE_COLUMNS_` in SheetParser.js), so
 * the web needs no change. Headers are matched exactly, not by substring:
 * several share long prefixes (หยิบ / คัดแยก / แพ็ก). Not yet confirmed
 * against a real downloaded file.
 */
export const OPERATOR_PERFORMANCE_METRICS = [
  { header: 'จัดการคำสั่งซื้อ', key: 'manageOrders' },
  { header: 'พิมพ์ใบปะหน้า', key: 'printLabel' },
  { header: 'พิมพ์ Pick List', key: 'printPickList' },
  { header: 'PDA หยิบของ', key: 'pdaPick' },
  { header: 'จัดส่ง', key: 'ship' },
  { header: 'พิมพ์ใบแจ้งหนี้', key: 'printInvoice' },
  { header: 'จำนวน Wave ที่หยิบ', key: 'pickWaveCount' },
  { header: 'จำนวนรวมพัสดุที่หยิบ', key: 'pickParcels' },
  { header: 'จำนวนรวม SKU ที่หยิบ', key: 'pickSku' },
  { header: 'จำนวนคำสั่งซื้อที่สแกนและส่งรูป', key: 'scanPhotoOrders' },
  { header: 'จำนวนข้อความที่สแกนและส่งรูป', key: 'scanPhotoMessages' },
  { header: 'จำนวน Wave ที่คัดแยก', key: 'sortWaveCount' },
  { header: 'จำนวนพัสดุทั้งหมดที่คัดแยก', key: 'sortParcels' },
  { header: 'จำนวนรวม SKU ที่คัดแยก', key: 'sortSku' },
  { header: 'จำนวน Wave ที่แพ็ก', key: 'packWaveCount' },
  { header: 'จำนวนรวมพัสดุที่แพ็ก', key: 'packParcels' },
  { header: 'จำนวนรวม SKU ที่แพ็ก', key: 'packSku' },
  { header: 'จำนวน Wave ที่ผ่านการตรวจสอบ', key: 'inspectWaveCount' },
  { header: 'จำนวนพัสดุที่ตรวจสอบ', key: 'inspectParcels' },
  { header: 'จำนวนรวมของ SKU ที่ถูกตรวจสอบ', key: 'inspectSku' },
  { header: 'จำนวนพัสดุที่หยิบ (สินค้าเดียว (1 ชิ้น))', key: 'pickSingleSkuSingleQty' },
  { header: 'จำนวนพัสดุที่หยิบ (สินค้าเดียว (หลายชิ้น))', key: 'pickSingleSkuMultiQty' },
  { header: 'จำนวนพัสดุที่หยิบ (สินค้าหลายชนิด/ชิ้น)', key: 'pickMultiSku' },
  { header: 'จำนวนพัสดุที่คัดแยก สินค้าเดียว (1 ชิ้น)', key: 'sortSingleSkuSingleQty' },
  { header: 'จำนวนพัสดุที่คัดแยก สินค้าเดียว (หลายชิ้น)', key: 'sortSingleSkuMultiQty' },
  { header: 'จำนวนพัสดุที่คัดแยก สินค้าหลายชนิด/ชิ้น', key: 'sortMultiSku' },
  { header: 'จำนวนพัสดุที่แพ็ก (สินค้าเดียว (1 ชิ้น))', key: 'packSingleSkuSingleQty' },
  { header: 'จำนวนพัสดุที่แพ็ก (สินค้าเดียว (หลายชิ้น))', key: 'packSingleSkuMultiQty' },
  { header: 'จำนวนพัสดุที่แพ็ก (สินค้าหลายชนิด/ชิ้น)', key: 'packMultiSku' },
] as const;

export const OPERATOR_PERFORMANCE_EXPORT_HEADERS = ['วันที่', 'โอเปอเรเตอร์', ...OPERATOR_PERFORMANCE_METRICS.map((m) => m.header)];

export interface OperatorPerformanceRow {
  /** Calendar date of the work, `YYYY-MM-DD` (the data window the row belongs to). */
  date: string;
  operator: string;
  metrics: Record<string, number>;
}

export interface RejectedOperatorPerformanceRow {
  reason: string;
  raw: Record<string, string>;
}

export type OperatorPerformanceParseResult =
  | { ok: true; row: OperatorPerformanceRow }
  | { ok: false; skip: 'total_row' }
  | { ok: false; rejected: RejectedOperatorPerformanceRow };

function readText(raw: Record<string, string>, header: string): string {
  return String(raw[header] ?? '').trim();
}

/**
 * Converts one export row (keyed by header) into a typed row.
 *
 * The export's own daily TOTAL row has operator "-" and is skipped, not
 * rejected: the total is recomputed from the real rows so a stale total can
 * never linger. A blank metric cell counts as 0, matching Apps Script; any
 * other non-integer text rejects the whole row rather than guessing.
 */
export function parseOperatorPerformanceRow(raw: Record<string, string>): OperatorPerformanceParseResult {
  const reject = (reason: string): OperatorPerformanceParseResult => ({ ok: false, rejected: { reason, raw } });

  const operator = readText(raw, 'โอเปอเรเตอร์');
  if (operator === '-') return { ok: false, skip: 'total_row' };
  if (!operator) return reject('missing โอเปอเรเตอร์');
  const date = parseThaiDateToIso(readText(raw, 'วันที่'));
  if (!date) return reject('unreadable or missing วันที่');

  const metrics: Record<string, number> = {};
  for (const metric of OPERATOR_PERFORMANCE_METRICS) {
    const text = readText(raw, metric.header).replace(/,/g, '');
    if (text === '') {
      metrics[metric.key] = 0;
    } else if (/^-?\d+$/.test(text)) {
      metrics[metric.key] = Number(text);
    } else {
      return reject(`unreadable number in "${metric.header}"`);
    }
  }
  return { ok: true, row: { date, operator, metrics } };
}

/** Identity of one row: one operator, one day. */
export function buildOperatorPerformanceKey(row: OperatorPerformanceRow): string {
  return `${row.date}|${row.operator}`;
}

function metricsDiffer(existing: OperatorPerformanceRow, incoming: OperatorPerformanceRow): boolean {
  return OPERATOR_PERFORMANCE_METRICS.some((metric) => existing.metrics[metric.key] !== incoming.metrics[metric.key]);
}

export interface OperatorPerformanceDryRunReport {
  rows_in: number;
  matched: number;
  to_insert: number;
  to_update: number;
  skipped: number;
  /** Unreadable/missing values per column the dashboard ranks or compares on. */
  null_count: Record<string, number>;
  /** Rows repeating an (date, operator) already seen earlier in the same file. */
  duplicate_count: number;
  /** Up to 5 rows: `existing` is null for a new row, the stored row for an update. */
  sample_diff: { key: string; existing: OperatorPerformanceRow | null; incoming: OperatorPerformanceRow }[];
  /** Export total rows ("-") left out; counted inside `skipped`. */
  total_rows_skipped: number;
  rejected: RejectedOperatorPerformanceRow[];
  /** Rows to write: new rows and changed rows, in file order. */
  writable: OperatorPerformanceRow[];
}

const NULL_COUNT_COLUMNS = ['วันที่', 'โอเปอเรเตอร์', 'PDA หยิบของ', 'จำนวนรวมพัสดุที่หยิบ', 'จำนวนรวมพัสดุที่แพ็ก'] as const;

/**
 * Classifies every export row against what the target holds, without writing
 * anything (DryRun step 2). The counts reconcile:
 * `rows_in = to_insert + to_update + skipped`, where skipped covers total
 * rows, rejected rows, repeats inside the file and rows already stored
 * unchanged. A stored day can legitimately change (BigSeller revises a day's
 * counts when pulled early), so a changed row is an update, not a duplicate.
 */
export function buildOperatorPerformanceDryRunReport(
  rawRows: Record<string, string>[],
  existingByKey: Map<string, OperatorPerformanceRow> = new Map(),
): OperatorPerformanceDryRunReport {
  const nullCount: Record<string, number> = Object.fromEntries(NULL_COUNT_COLUMNS.map((header) => [header, 0]));
  const rejected: RejectedOperatorPerformanceRow[] = [];
  const seenKeys = new Set<string>();
  const writable: OperatorPerformanceRow[] = [];
  const sampleDiff: OperatorPerformanceDryRunReport['sample_diff'] = [];
  let matched = 0;
  let toInsert = 0;
  let toUpdate = 0;
  let duplicateCount = 0;
  let totalRowsSkipped = 0;

  for (const raw of rawRows) {
    const isTotalRow = readText(raw, 'โอเปอเรเตอร์') === '-';
    if (!isTotalRow) {
      if (!readText(raw, 'โอเปอเรเตอร์')) nullCount['โอเปอเรเตอร์'] += 1;
      if (parseThaiDateToIso(readText(raw, 'วันที่')) === null) nullCount['วันที่'] += 1;
      for (const header of ['PDA หยิบของ', 'จำนวนรวมพัสดุที่หยิบ', 'จำนวนรวมพัสดุที่แพ็ก']) {
        const text = readText(raw, header).replace(/,/g, '');
        if (text !== '' && !/^-?\d+$/.test(text)) nullCount[header] += 1;
      }
    }

    const parsed = parseOperatorPerformanceRow(raw);
    if (!parsed.ok) {
      if ('skip' in parsed) totalRowsSkipped += 1;
      else rejected.push(parsed.rejected);
      continue;
    }
    const row = parsed.row;
    const key = buildOperatorPerformanceKey(row);
    if (seenKeys.has(key)) {
      duplicateCount += 1;
      continue;
    }
    seenKeys.add(key);

    const existing = existingByKey.get(key) ?? null;
    if (existing) matched += 1;
    if (existing && !metricsDiffer(existing, row)) continue;

    if (existing) toUpdate += 1;
    else toInsert += 1;
    writable.push(row);
    if (sampleDiff.length < 5) sampleDiff.push({ key, existing, incoming: row });
  }

  return {
    rows_in: rawRows.length,
    matched,
    to_insert: toInsert,
    to_update: toUpdate,
    skipped: rawRows.length - toInsert - toUpdate,
    null_count: nullCount,
    duplicate_count: duplicateCount,
    sample_diff: sampleDiff,
    total_rows_skipped: totalRowsSkipped,
    rejected,
    writable,
  };
}
