import type { Page } from '@playwright/test';
import { BigSellerOrderPrintAlertPage } from '../bigseller/order-print-alert-page.js';
import { ensureSessionValid } from '../bigseller/auth.js';
import { SheetsClient } from '../sheets/sheets-client.js';
import { logger } from '../utils/logger.js';

const SHEET_ORDER_PRINT_ALERT = process.env.SHEET_ORDER_PRINT_ALERT ?? 'DB_ORDER_PRINT_ALERT';
const WINDOW_DAYS = Number(process.env.ORDER_PRINT_ALERT_DAYS ?? 30);

const HEADERS = [
  'packageNo', 'orderNo', 'store', 'platform', 'buyer', 'status', 'warehouse',
  'printNum', 'printTimes', 'orderCreatedAt', 'trackingNo', 'sourceUpdatedAt',
] as const;

export async function syncOrderPrintAlert(page: Page, sheetsClient: SheetsClient): Promise<void> {
  const start = Date.now();
  await ensureSessionValid(page, 'https://www.bigseller.com/web/order/index.htm?status=shipped');
  const alertPage = new BigSellerOrderPrintAlertPage(page);
  await alertPage.goto();
  const rows = await alertPage.fetchReprintedRows(WINDOW_DAYS);
  await logger.info(`syncOrderPrintAlert: ${rows.length} order(s) with a shipping label printed more than once (last ${WINDOW_DAYS} day(s))`);

  const sourceUpdatedAt = new Date().toISOString();
  const records = rows
    .sort((a, b) => b.printNum - a.printNum)
    .map((r) => ({ ...r, sourceUpdatedAt }));
  await sheetsClient.replaceAll(SHEET_ORDER_PRINT_ALERT, [...HEADERS], records);
  await logger.info(`syncOrderPrintAlert: wrote ${records.length} row(s), done in ${Date.now() - start}ms`);
}
