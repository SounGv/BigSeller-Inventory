import 'dotenv/config';
import { SheetsClient } from '../src/sheets/sheets-client.js';
import { getLatestSuccessfulRunId } from '../src/services/run-data.js';
import { exportMoveFiles } from '../src/services/move-export-service.js';
import { validateMoveFiles } from '../src/services/move-validation-service.js';
import { withBigSellerPage } from '../src/utils/browser-runner.js';
import { BigSellerMovingGoodsPage } from '../src/bigseller/moving-goods-page.js';
import { logger } from '../src/utils/logger.js';

const WAREHOUSE_NAME = process.env.INVENTORY_WAREHOUSE_NAME ?? 'STOCK_5';

/**
 * Phase 9, preview mode. Opens the real "ย้ายสินค้า" page and selects the
 * warehouse so you can see it's ready, and lists exactly which files
 * `import:moves` would upload and in what order — but NEVER clicks "นำเข้า".
 * Safe to run any time; creates nothing.
 */
async function main() {
  const sheetsClient = await SheetsClient.create();
  const runId = await getLatestSuccessfulRunId(sheetsClient);
  const dateStamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');

  const files = await exportMoveFiles(sheetsClient, runId, dateStamp);
  const validation = await validateMoveFiles(files);

  console.log(`runId ${runId} — ${files.length} ไฟล์ที่จะนำเข้า (โหมด Preview เท่านั้น ยังไม่นำเข้าจริง):`);
  for (const file of files) console.log(`  - ${file.filePath} (${file.rowCount} แถว)`);
  console.log(validation.ok ? '[OK] ทุกไฟล์ผ่านการตรวจสอบ' : `[FAIL] พบปัญหา ${validation.problems.length} ข้อ — ดูรายละเอียดด้วย "npm run validate:moves"`);

  await withBigSellerPage('preview-moves', async (page) => {
    const movingGoodsPage = new BigSellerMovingGoodsPage(page);
    await movingGoodsPage.goto();
    await movingGoodsPage.selectWarehouse(WAREHOUSE_NAME);
    console.log(`เปิดหน้า "ย้ายสินค้า" และเลือกคลัง ${WAREHOUSE_NAME} แล้ว (ไม่ได้กดปุ่ม "นำเข้า")`);
  });

  await logger.info(`preview:moves complete for runId ${runId} — ${files.length} file(s), validation.ok=${validation.ok}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
