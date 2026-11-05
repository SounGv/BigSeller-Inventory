import { parseThaiDateTime } from '../utils/thai-date.js';

/**
 * Headers of BigSeller's stock-position-movement export
 * (`bigseller.com/web/inventory/warehouseInOutRecord.htm`), taken from the
 * "บันทึกการอัปเดตตำแหน่งสต็อก (BigSeller)" tab of the team v2 sheet, which is a
 * verbatim paste of that export. Not yet confirmed against a real downloaded
 * file — the exporter step must re-check these before trusting them.
 *
 * Quirks confirmed from real rows: BigSeller's own spelling "ปัญชี" (operator
 * account) and a first column labelled "ชื่อSKU" that actually holds the SKU
 * code while "ชื่อ SKU" holds the product name.
 */
export const STOCK_MOVE_EXPORT_HEADERS = [
  'ชื่อSKU',
  'ชื่อ SKU',
  'ปัญชี',
  'เวลา',
  'ชื่อคลังสินค้า',
  'ตำแหน่ง',
  'มิติสต็อกสินค้า',
  'หน่วยพื้นฐาน',
  'สต็อกเดิม',
  'เคลื่อนไหว',
  'สต็อกล่าสุด',
  'ประเภท',
  'หมายเลขเอกสาร',
] as const;

export interface StockMoveRow {
  skuCode: string;
  skuName: string;
  operatorAccount: string;
  /** ISO 8601 with an explicit +07:00 offset, minute precision (the export has no seconds). */
  movedAt: string;
  /** Calendar date of `movedAt` in Thailand time, the data window the row belongs to. */
  snapshotDate: string;
  warehouseCode: string;
  positionCode: string;
  stockDimension: string;
  unit: string;
  stockBefore: number;
  stockChange: number;
  stockAfter: number;
  moveType: string;
  documentNo: string;
  reservedOrderNo: string | null;
}

export interface RejectedStockMoveRow {
  reason: string;
  raw: Record<string, string>;
}

export type StockMoveParseResult =
  | { ok: true; row: StockMoveRow }
  | { ok: false; rejected: RejectedStockMoveRow };

function readText(raw: Record<string, string>, header: string): string {
  return String(raw[header] ?? '').trim();
}

function readInteger(raw: Record<string, string>, header: string): number | null {
  const text = readText(raw, header).replace(/,/g, '');
  if (!/^-?\d+$/.test(text)) return null;
  return Number(text);
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * Converts one row of the export (keyed by header) into a typed row, or says
 * why it cannot. A row is rejected, never guessed at, when the timestamp, the
 * document number, the SKU code or any of the three stock figures is missing
 * or unreadable — those are the fields the dashboard counts and sums.
 *
 * The wall-clock digits of `parseThaiDateTime` are read back with local
 * getters and written out with a fixed +07:00 offset, so the result does not
 * depend on the time zone of the machine that runs the export.
 */
export function parseStockMoveRow(raw: Record<string, string>): StockMoveParseResult {
  const reject = (reason: string): StockMoveParseResult => ({ ok: false, rejected: { reason, raw } });

  const moved = parseThaiDateTime(readText(raw, 'เวลา'));
  if (!moved) return reject('unreadable or missing เวลา');
  const skuCode = readText(raw, 'ชื่อSKU');
  if (!skuCode) return reject('missing SKU code');
  const documentNo = readText(raw, 'หมายเลขเอกสาร');
  if (!documentNo) return reject('missing หมายเลขเอกสาร');
  const stockBefore = readInteger(raw, 'สต็อกเดิม');
  const stockChange = readInteger(raw, 'เคลื่อนไหว');
  const stockAfter = readInteger(raw, 'สต็อกล่าสุด');
  if (stockBefore === null || stockChange === null || stockAfter === null) {
    return reject('unreadable stock figure (สต็อกเดิม / เคลื่อนไหว / สต็อกล่าสุด)');
  }

  const snapshotDate = `${moved.getFullYear()}-${pad2(moved.getMonth() + 1)}-${pad2(moved.getDate())}`;
  return {
    ok: true,
    row: {
      skuCode,
      skuName: readText(raw, 'ชื่อ SKU'),
      operatorAccount: readText(raw, 'ปัญชี'),
      movedAt: `${snapshotDate}T${pad2(moved.getHours())}:${pad2(moved.getMinutes())}:00+07:00`,
      snapshotDate,
      warehouseCode: readText(raw, 'ชื่อคลังสินค้า'),
      positionCode: readText(raw, 'ตำแหน่ง'),
      stockDimension: readText(raw, 'มิติสต็อกสินค้า'),
      unit: readText(raw, 'หน่วยพื้นฐาน'),
      stockBefore,
      stockChange,
      stockAfter,
      moveType: readText(raw, 'ประเภท'),
      documentNo,
      reservedOrderNo: readText(raw, 'เลขคำสั่งซื้อที่จองไว้') || null,
    },
  };
}

/**
 * Identity of one movement. The export has no row id, so the key is every
 * field that tells two movements apart. `stockBefore` and `stockAfter` are in
 * it on purpose: two genuine moves of the same SKU into the same position
 * within the same minute and document are chained (the second starts where the
 * first ended), so they differ there and are not collapsed as duplicates.
 */
export function buildStockMoveKey(row: StockMoveRow): string {
  return [
    row.documentNo,
    row.skuCode,
    row.positionCode,
    row.stockDimension,
    row.moveType,
    row.movedAt,
    row.stockBefore,
    row.stockAfter,
  ].join('|');
}

const NON_KEY_FIELDS: (keyof StockMoveRow)[] = [
  'skuName',
  'operatorAccount',
  'warehouseCode',
  'unit',
  'stockChange',
  'reservedOrderNo',
];

function differsOutsideKey(existing: StockMoveRow, incoming: StockMoveRow): boolean {
  return NON_KEY_FIELDS.some((field) => existing[field] !== incoming[field]);
}

export interface StockMoveDryRunReport {
  rows_in: number;
  matched: number;
  to_insert: number;
  to_update: number;
  skipped: number;
  /** Count of unreadable/missing values per column that the dashboard counts or sums. */
  null_count: Record<string, number>;
  /** Rows repeating a key already seen earlier in the same file. */
  duplicate_count: number;
  /** Up to 5 rows: `existing` is null for a new row, the stored row for an update. */
  sample_diff: { key: string; existing: StockMoveRow | null; incoming: StockMoveRow }[];
  /** Valid rows whose stockAfter is not stockBefore + stockChange; reported, not rejected. */
  arithmetic_mismatch_count: number;
  rejected: RejectedStockMoveRow[];
  /** Rows to write: new rows and changed rows, in file order. */
  writable: StockMoveRow[];
}

const NULL_COUNT_COLUMNS = ['เวลา', 'ชื่อSKU', 'หมายเลขเอกสาร', 'สต็อกเดิม', 'เคลื่อนไหว', 'สต็อกล่าสุด'] as const;

function isBlankOrUnreadable(raw: Record<string, string>, header: string): boolean {
  const text = readText(raw, header);
  if (text === '') return true;
  if (header === 'เวลา') return parseThaiDateTime(text) === null;
  if (header === 'สต็อกเดิม' || header === 'เคลื่อนไหว' || header === 'สต็อกล่าสุด') {
    return readInteger(raw, header) === null;
  }
  return false;
}

/**
 * Classifies every incoming export row against what the target table already
 * holds, without writing anything (DryRun step 2). `existingByKey` is the
 * stored rows keyed by `buildStockMoveKey`; pass an empty map when the target
 * is empty or not reachable yet.
 *
 * The counts reconcile: `rows_in = to_insert + to_update + skipped`, where
 * skipped covers rejected rows, repeats inside the file, and rows already
 * stored unchanged. `matched` is the part of the file whose key already exists
 * in the target (changed or not).
 */
export function buildStockMoveDryRunReport(
  rawRows: Record<string, string>[],
  existingByKey: Map<string, StockMoveRow> = new Map(),
): StockMoveDryRunReport {
  const nullCount: Record<string, number> = Object.fromEntries(NULL_COUNT_COLUMNS.map((header) => [header, 0]));
  const rejected: RejectedStockMoveRow[] = [];
  const seenKeys = new Set<string>();
  const writable: StockMoveRow[] = [];
  const sampleDiff: StockMoveDryRunReport['sample_diff'] = [];
  let matched = 0;
  let toInsert = 0;
  let toUpdate = 0;
  let duplicateCount = 0;
  let arithmeticMismatchCount = 0;

  for (const raw of rawRows) {
    for (const header of NULL_COUNT_COLUMNS) {
      if (isBlankOrUnreadable(raw, header)) nullCount[header] += 1;
    }

    const parsed = parseStockMoveRow(raw);
    if (!parsed.ok) {
      rejected.push(parsed.rejected);
      continue;
    }
    const row = parsed.row;
    if (row.stockAfter !== row.stockBefore + row.stockChange) arithmeticMismatchCount += 1;

    const key = buildStockMoveKey(row);
    if (seenKeys.has(key)) {
      duplicateCount += 1;
      continue;
    }
    seenKeys.add(key);

    const existing = existingByKey.get(key) ?? null;
    if (existing) matched += 1;
    if (existing && !differsOutsideKey(existing, row)) continue;

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
    arithmetic_mismatch_count: arithmeticMismatchCount,
    rejected,
    writable,
  };
}
