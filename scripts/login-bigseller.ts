import 'dotenv/config';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { getStorageStatePath, checkIsLoggedIn } from '../src/bigseller/auth.js';
import { launchBigSellerBrowser } from '../src/utils/browser-runner.js';
import { logger } from '../src/utils/logger.js';

const INVENTORY_URL = process.env.BIGSELLER_INVENTORY_URL ?? 'https://www.bigseller.com/web/inventory/warehouseInventory.htm';
const POLL_INTERVAL_MS = 3000;
const MAX_WAIT_MS = 5 * 60 * 1000; // 5 minutes to complete manual login + OTP + CAPTCHA

/**
 * Opens a HEADED browser so an authorized staff member can log in manually
 * (username, password, OTP, CAPTCHA). This script never reads or stores those
 * values — it only waits for the resulting session to become valid, then saves
 * the storage state for headless scripts to reuse.
 */
async function main() {
  const storageStatePath = getStorageStatePath();
  await mkdir(path.dirname(storageStatePath), { recursive: true });

  console.log('เปิดเบราว์เซอร์แล้ว กรุณาล็อกอินเข้า BigSeller ด้วยตนเอง (Username / Password / OTP / CAPTCHA)');
  console.log(`รอสูงสุด ${MAX_WAIT_MS / 60000} นาที ระบบจะตรวจสอบสถานะการล็อกอินให้อัตโนมัติ...`);

  // Must use the exact same fingerprint (UA/viewport/locale/timezone/stealth) as
  // the automated sync runner — see launchBigSellerBrowser's doc comment. Logging
  // in under one fingerprint and replaying the session under another is what was
  // getting the saved session rejected on every sync run.
  const { browser, context } = await launchBigSellerBrowser({ headless: false });
  const page = await context.newPage();
  await page.goto(INVENTORY_URL, { waitUntil: 'domcontentloaded' });

  const deadline = Date.now() + MAX_WAIT_MS;
  let loggedIn = false;

  // Deliberately does NOT re-navigate on every poll tick (unlike isSessionValid) —
  // confirmed live (2026-08-24) that reloading the page every 3s out from under a
  // human mid-login wipes their in-progress form input/OTP/CAPTCHA before they can
  // finish ("กดไม่ทัน" / couldn't click in time). This just asks the current page
  // whether it's authenticated yet, leaving whatever the human is doing untouched.
  while (Date.now() < deadline) {
    await page.waitForTimeout(POLL_INTERVAL_MS);
    loggedIn = await checkIsLoggedIn(page).catch(() => false);
    if (loggedIn) break;
  }

  if (!loggedIn) {
    await browser.close();
    console.error('หมดเวลารอการล็อกอิน กรุณารันคำสั่งนี้ใหม่');
    process.exit(1);
  }

  await context.storageState({ path: storageStatePath });
  await logger.info(`Saved BigSeller session to ${storageStatePath}`);
  console.log(`บันทึก Session สำเร็จที่ ${storageStatePath}`);

  await browser.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
