import 'dotenv/config';
import { existsSync } from 'node:fs';
import { getStorageStatePath, isSessionValid } from '../src/bigseller/auth.js';
import { launchBigSellerBrowser } from '../src/utils/browser-runner.js';
import { SheetsClient } from '../src/sheets/sheets-client.js';
import { logger } from '../src/utils/logger.js';

const INVENTORY_URL = process.env.BIGSELLER_INVENTORY_URL ?? 'https://www.bigseller.com/web/inventory/warehouseInventory.htm';

const REQUIRED_SHEETS = [
  process.env.SHEET_LOCATION_SNAPSHOT ?? 'DB_LOCATION_SNAPSHOT',
  process.env.SHEET_LOCATION_CURRENT ?? 'DB_LOCATION_CURRENT',
  process.env.SHEET_SYNC_LOG ?? 'SYNC_LOG',
  process.env.SHEET_ERROR_LOG ?? 'ERROR_LOG',
  process.env.SHEET_EMPLOYEE_TASK_VIEW ?? 'EMPLOYEE_TASK_VIEW',
  process.env.SHEET_REPLENISH_TRANSACTION ?? 'DB_REPLENISH_TRANSACTION',
  process.env.SHEET_SALES_SNAPSHOT ?? 'DB_SALES_SNAPSHOT',
  process.env.SHEET_SKU_INVENTORY ?? 'DB_SKU_INVENTORY',
  process.env.SHEET_TRANSFER_PLAN ?? 'DB_TRANSFER_PLAN',
  process.env.SHEET_TRANSFER_EXCEPTION ?? 'TRANSFER_EXCEPTION',
];

/** Read-only environment check: session validity + required env vars + required sheet tabs exist. Never writes data. */
async function main() {
  let ok = true;

  const storageStatePath = getStorageStatePath();
  if (!existsSync(storageStatePath)) {
    console.error(`[FAIL] ไม่พบไฟล์ Session: ${storageStatePath} — รัน "npm run login:bigseller" ก่อน`);
    ok = false;
  } else {
    // Same fingerprint recipe as login-bigseller.ts and the sync runner — see
    // launchBigSellerBrowser's doc comment for why that consistency matters.
    const { browser, context } = await launchBigSellerBrowser({ headless: true, storageState: storageStatePath });
    const page = await context.newPage();
    const valid = await isSessionValid(page, INVENTORY_URL).catch(() => false);
    console.log(valid ? '[OK] BigSeller session ใช้งานได้' : '[FAIL] BigSeller session หมดอายุ');
    ok = ok && valid;
    await browser.close();
  }

  for (const name of ['GOOGLE_SHEETS_SPREADSHEET_ID', 'GOOGLE_APPLICATION_CREDENTIALS', 'INVENTORY_WAREHOUSE_NAME']) {
    if (!process.env[name]) {
      console.error(`[FAIL] ไม่ได้ตั้งค่า .env: ${name}`);
      ok = false;
    }
  }
  if (!process.env.INVENTORY_AREA_NAME) {
    console.log('[OK] INVENTORY_AREA_NAME ไม่ได้ตั้งค่า (ไม่บังคับ) — จะดึงทุกพื้นที่ในคลังที่เลือก');
  }

  try {
    const sheetsClient = await SheetsClient.create();
    for (const sheetName of REQUIRED_SHEETS) {
      const rows = await sheetsClient.readAll(sheetName).catch(() => null);
      if (rows === null) {
        console.error(`[FAIL] ไม่พบชีต: ${sheetName}`);
        ok = false;
      } else {
        console.log(`[OK] พบชีต: ${sheetName}`);
      }
    }
  } catch (error) {
    console.error(`[FAIL] เชื่อมต่อ Google Sheets ไม่สำเร็จ: ${(error as Error).message}`);
    ok = false;
  }

  if (!ok) {
    await logger.error('validate: FAILED');
    process.exit(1);
  }
  await logger.info('validate: OK');
  console.log('ทุกอย่างพร้อมใช้งาน');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
