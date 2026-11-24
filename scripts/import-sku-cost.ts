import 'dotenv/config';
import { readTabularFile, validateReportFile } from '../src/bigseller/extract-table.js';
import { SheetsClient } from '../src/sheets/sheets-client.js';
import { logger } from '../src/utils/logger.js';

const SHEET_SKU_COST = process.env.SHEET_SKU_COST ?? 'DB_SKU_COST';

/**
 * Bulk-fills `DB_SKU_COST` from the same "SKU Merchant" export
 * import-carton-qty.ts already reads (สินค้าคงคลัง > SKU Merchant > ส่งออก >
 * ส่งออกทั้งหมด) — confirmed live 2026-11-09 that this export already carries
 * a per-SKU cost ("อ้างอิงราคาต้นทุน") and its currency
 * ("สกุลเงินของราคาต้นทุน", THB on every row seen so far), separate from
 * import-carton-qty.ts's own carton-size columns. Kept as its own script
 * rather than folded into that one — they serve different sheets/features
 * and have no logic in common beyond reading the same file.
 *
 * Built for FEATURE request (2026-11-09): "ชิงค์สต๊อกสินค้าขึ้นมาไว้ดูมูลค่าสินค้า
 * แต่ละคลัง" (stock value per warehouse) — see
 * `scripts/migrate-sheet-for-stock-value.ts` for the sheet that joins this
 * against quantity.
 *
 * Same re-run expectation as import-carton-qty.ts: the user re-downloads
 * this export periodically as costs get corrected; upsert-by-sku means a
 * newer file simply overwrites older values for the same SKU.
 */
const EXPECTED_HEADERS = ['เลข SKU', 'อ้างอิงราคาต้นทุน', 'สกุลเงินของราคาต้นทุน'];

async function main() {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error('Usage: tsx scripts/import-sku-cost.ts "<path to SKU Merchant export .xlsx>"');
    process.exit(1);
  }

  await validateReportFile(filePath, { expectedHeaders: EXPECTED_HEADERS });
  const rows = await readTabularFile(filePath);

  const seen = new Set<string>();
  const entries: { sku: string; costPrice: number; currency: string }[] = [];

  for (const row of rows) {
    const sku = String(row['เลข SKU'] ?? '').trim();
    if (!sku || seen.has(sku)) continue;
    seen.add(sku);

    const costPrice = Number(row['อ้างอิงราคาต้นทุน']);
    if (!Number.isFinite(costPrice)) continue;
    entries.push({ sku, costPrice, currency: String(row['สกุลเงินของราคาต้นทุน'] ?? '').trim() });
  }

  console.log(`${filePath}: ${rows.length} rows read, ${entries.length} SKUs with a readable cost price.`);

  if (entries.length > 0) {
    const sheetsClient = await SheetsClient.create();
    await sheetsClient.upsertRows(
      SHEET_SKU_COST,
      entries.map((e) => ({ sku: e.sku, costPrice: e.costPrice, currency: e.currency })),
      { headers: ['sku', 'costPrice', 'currency'], keyColumns: ['sku'] },
    );
    await logger.info(`import-sku-cost: upserted ${entries.length} SKU cost prices from ${filePath}`);
    console.log(`[OK] Upserted ${entries.length} rows into ${SHEET_SKU_COST}.`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
