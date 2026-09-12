import { downloadXlsxWorkbook, readSheetRows } from '../utils/drive-xlsx.js';
import { SupabaseDbClient } from '../db/supabase-db-client.js';
import { logger } from '../utils/logger.js';

const TABLE = 'warehouse_stock_count_kpi';
const SOURCE_URL = 'https://docs.google.com/spreadsheets/d/14MejwCF6OMdro2yFJMLHR1OKgQ0W8Esx/edit';

interface WeekRow {
  weekNumber: number;
  weekRange: string | null;
  skuTarget: number | null;
  skuCounted: number | null;
  stockAccuracy: number | null;
  valueTotal: number | null;
  valueShort: number | null;
  valueOver: number | null;
  valueKpiPct: number | null;
}

function asNumberOrNull(v: unknown): number | null {
  return typeof v === 'number' ? v : null;
}

/** Matches "สัปดาห์ 1".."สัปดาห์ 5" in column A and pulls out the week number. */
function parseWeekLabel(cell: unknown): number | null {
  if (typeof cell !== 'string') return null;
  const m = cell.match(/^สัปดาห์\s*(\d+)$/);
  return m ? Number(m[1]) : null;
}

/**
 * Scans `rows` for a header row matching `isHeader`, then reads every
 * following row whose column A is "สัปดาห์ N" (stops at the first row that
 * isn't) — deliberately NOT a fixed row-index read, so this survives the
 * sheet owner inserting/deleting an explanatory row above the table, as long
 * as the header text itself and the "สัปดาห์ N" row labels stay the same.
 */
function readWeekTable(rows: unknown[][], isHeader: (row: unknown[]) => boolean): Map<number, unknown[]> {
  const headerIdx = rows.findIndex((r) => isHeader(r as unknown[]));
  if (headerIdx === -1) return new Map();
  const out = new Map<number, unknown[]>();
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const week = parseWeekLabel(rows[i][0]);
    if (week === null) break;
    out.set(week, rows[i]);
  }
  return out;
}

function readOptionValue(rows: unknown[][], label: string): number | null {
  const row = rows.find((r) => r[2] === label);
  return row ? asNumberOrNull(row[3]) : null;
}

/** `YYYY-MM` / `MM` in local time (machine confirmed Asia/Bangkok) — same convention as the other services' `formatLocalDate`. */
function monthParts(d: Date): { monthKey: string; suffix: string } {
  const year = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return { monthKey: `${year}-${mm}`, suffix: mm };
}

/**
 * Syncs ฝ่ายคลัง's manually-maintained weekly stock-count KPI workbook
 * (shared 2026-09-02 as an example of ฝ่ายคลัง's real "เป้า") — a raw .xlsx
 * in Drive, NOT BigSeller data and NOT a native Google Sheet (see
 * drive-xlsx.ts). Every month the sheet owner adds a fresh `KPI สต๊อก_MM` /
 * `สรุปรายสัปดาห์_MM` tab pair; this always reads the CURRENT calendar
 * month's pair, so nothing here needs updating when the new month's tabs
 * appear.
 *
 * Reads 3 tabs and joins them by week number (1-5, always all 5 present in
 * the template even before they're counted):
 *   - `KPI สต๊อก_MM`: two week-tables (SKU accuracy section, value-KPI
 *     section) — sku target/counted/accuracy and value total/short/over/KPI%.
 *   - `สรุปรายสัปดาห์_MM`: just for `week_range` (the "01/09 - 02/09" date
 *     span), which isn't in the KPI tab.
 *   - `ตัวเลือก`: the pass/fail targets (currently 90.0% accuracy, 99.9%
 *     value-KPI) — read live, not hardcoded, since the sheet's own note says
 *     these are adjustable there.
 *
 * Pass/fail itself is NOT stored — the dashboard computes it from
 * stock_accuracy/value_kpi_pct vs accuracy_target/value_kpi_target, so
 * there's one source of truth instead of a stored boolean that could drift.
 */
export async function syncWarehouseStockCount(): Promise<void> {
  const start = Date.now();
  const fileId = process.env.GOOGLE_DRIVE_STOCK_COUNT_FILE_ID;
  if (!fileId) {
    await logger.info('syncWarehouseStockCount: GOOGLE_DRIVE_STOCK_COUNT_FILE_ID not set, skipping');
    return;
  }

  const { monthKey, suffix } = monthParts(new Date());
  const workbook = await downloadXlsxWorkbook(fileId);

  const kpiRows = readSheetRows(workbook, `KPI สต๊อก_${suffix}`);
  const weeklyRows = readSheetRows(workbook, `สรุปรายสัปดาห์_${suffix}`);
  const optionRows = readSheetRows(workbook, 'ตัวเลือก');

  const accuracyTarget = readOptionValue(optionRows, 'เป้า Stock Accuracy (นับ SKU)');
  const valueKpiTarget = readOptionValue(optionRows, 'เป้า KPI มูลค่า (Value-based)');
  if (accuracyTarget === null || valueKpiTarget === null) {
    throw new Error('syncWarehouseStockCount: could not read KPI targets from the "ตัวเลือก" tab');
  }

  const accuracyWeeks = readWeekTable(kpiRows, (r) => r[0] === 'สัปดาห์' && r[1] === 'เป้า (SKU)');
  const valueWeeks = readWeekTable(kpiRows, (r) => r[0] === 'สัปดาห์' && r[1] === 'มูลค่ารวม (บาท)');
  const rangeWeeks = readWeekTable(weeklyRows, (r) => r[0] === 'สัปดาห์' && r[1] === 'ช่วงวันที่');

  const weekNumbers = new Set([...accuracyWeeks.keys(), ...valueWeeks.keys(), ...rangeWeeks.keys()]);
  const weeks: WeekRow[] = [...weekNumbers].sort((a, b) => a - b).map((weekNumber) => {
    const acc = accuracyWeeks.get(weekNumber);
    const val = valueWeeks.get(weekNumber);
    const range = rangeWeeks.get(weekNumber);
    return {
      weekNumber,
      weekRange: typeof range?.[1] === 'string' ? (range[1] as string) : null,
      skuTarget: asNumberOrNull(acc?.[1]),
      skuCounted: asNumberOrNull(acc?.[2]),
      stockAccuracy: asNumberOrNull(acc?.[4]),
      valueTotal: asNumberOrNull(val?.[1]),
      valueShort: asNumberOrNull(val?.[2]),
      valueOver: asNumberOrNull(val?.[3]),
      valueKpiPct: asNumberOrNull(val?.[4]),
    };
  });

  await logger.info(`syncWarehouseStockCount: ${monthKey} — ${weeks.length} week row(s), accuracyTarget=${accuracyTarget}, valueKpiTarget=${valueKpiTarget}`);

  const supabase = SupabaseDbClient.create();
  await supabase.upsertRows(
    TABLE,
    weeks.map((w) => ({
      month: monthKey,
      week_number: w.weekNumber,
      week_range: w.weekRange,
      sku_target: w.skuTarget,
      sku_counted: w.skuCounted,
      stock_accuracy: w.stockAccuracy,
      accuracy_target: accuracyTarget,
      value_total: w.valueTotal,
      value_short: w.valueShort,
      value_over: w.valueOver,
      value_kpi_pct: w.valueKpiPct,
      value_kpi_target: valueKpiTarget,
      source_url: SOURCE_URL,
      synced_at: new Date().toISOString(),
    })),
    ['month', 'week_number'],
  );

  await logger.info(`syncWarehouseStockCount: done in ${Date.now() - start}ms`);
}
