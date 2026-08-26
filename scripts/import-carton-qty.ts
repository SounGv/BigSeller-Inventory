import 'dotenv/config';
import { readTabularFile, validateReportFile } from '../src/bigseller/extract-table.js';
import { SheetsClient } from '../src/sheets/sheets-client.js';
import { logger } from '../src/utils/logger.js';

const SHEET_SKU_CARTON_QTY = process.env.SHEET_SKU_CARTON_QTY ?? 'DB_SKU_CARTON_QTY';

/**
 * Bulk-fills `DB_SKU_CARTON_QTY` from a real "SKU Merchant" export the user
 * downloads by hand from BigSeller (สินค้าคงคลัง > SKU Merchant > ส่งออก >
 * ส่งออกทั้งหมด — confirmed live 2026-08-25, no way to trigger this
 * automatically found yet, see [[bigseller_carton_rounding_feature]]).
 *
 * Confirmed live (2026-08-25) against a real downloaded file: BigSeller DOES
 * track a per-SKU carton size after all — it's just not in any report this
 * project had pulled before. Every SKU with "การจัดการสินค้าหลายหน่วย" (multi-unit
 * management) enabled has up to 5 "หน่วยเสริม N" (secondary unit N) /
 * "กฎการแปลงหน่วย N" (conversion rule N) column pairs; whichever slot has
 * หน่วยเสริม N === "Carton" gives the units-per-carton in กฎการแปลงหน่วย N. On
 * the real file that prompted this, 1,605 of 2,913 SKUs had this set (the
 * rest don't use multi-unit management at all, i.e. genuinely no carton
 * packaging defined for them — normal per-unit behavior for those is
 * correct, not a gap to fill).
 *
 * The user expects to re-download and re-run this periodically as box
 * quantities/barcodes get corrected on their end ("ถ้ามีข้อมูลใหม่ จำนวนกล่องกับ
 * รุ่นบาร์โค้ดจะแก้ เดียวมาบอก") — safe to re-run any time, upsert-by-sku means a
 * newer file simply overwrites older values for the same SKU.
 */
const EXPECTED_HEADERS = ['เลข SKU', 'หน่วยเสริม 1', 'กฎการแปลงหน่วย 1'];
const MAX_UNIT_SLOTS = 5;

function findCartonQty(row: Record<string, string>): number | null {
  for (let i = 1; i <= MAX_UNIT_SLOTS; i++) {
    const unitName = String(row[`หน่วยเสริม ${i}`] ?? '').trim();
    if (unitName.toLowerCase() === 'carton') {
      const qty = Number(row[`กฎการแปลงหน่วย ${i}`]);
      if (Number.isFinite(qty) && qty > 0) return qty;
    }
  }
  return null;
}

async function main() {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error('Usage: tsx scripts/import-carton-qty.ts "<path to SKU Merchant export .xlsx>"');
    process.exit(1);
  }

  await validateReportFile(filePath, { expectedHeaders: EXPECTED_HEADERS });
  const rows = await readTabularFile(filePath);

  const seen = new Set<string>();
  const entries: { sku: string; unitsPerCarton: number }[] = [];
  let withoutCarton = 0;

  for (const row of rows) {
    const sku = String(row['เลข SKU'] ?? '').trim();
    if (!sku || seen.has(sku)) continue;
    seen.add(sku);

    const qty = findCartonQty(row);
    if (qty !== null) {
      entries.push({ sku, unitsPerCarton: qty });
    } else {
      withoutCarton++;
    }
  }

  console.log(`${filePath}: ${rows.length} rows read, ${entries.length} SKUs with a Carton size, ${withoutCarton} without (left unaffected — normal per-unit behavior).`);

  if (entries.length > 0) {
    const sheetsClient = await SheetsClient.create();
    await sheetsClient.upsertRows(
      SHEET_SKU_CARTON_QTY,
      entries.map((e) => ({ sku: e.sku, unitsPerCarton: e.unitsPerCarton, key: e.sku })),
      { headers: ['sku', 'unitsPerCarton'], keyColumns: ['sku'] },
    );
    await logger.info(`import-carton-qty: upserted ${entries.length} SKU carton sizes from ${filePath}`);
    console.log(`[OK] Upserted ${entries.length} rows into ${SHEET_SKU_CARTON_QTY}.`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
