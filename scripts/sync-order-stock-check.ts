import 'dotenv/config';
import { withBigSellerPage } from '../src/utils/browser-runner.js';
import { syncOrderDemand } from '../src/services/order-demand-service.js';
import { syncOrderStockCheck } from '../src/services/order-stock-check-service.js';
import { SheetsClient } from '../src/sheets/sheets-client.js';
import { generateRunId } from '../src/types.js';
import { logger } from '../src/utils/logger.js';

/**
 * Morning-only entry point (Task Scheduler, once at 08:00 — see
 * scripts/run-order-stock-check.bat) for the staff-facing
 * EMPLOYEE_STOCK_CHECK_VIEW sheet.
 *
 * Deliberately re-runs syncOrderDemand() itself here rather than relying on
 * syncBigSeller()'s own (currently disabled, see sync-service.ts) call to
 * it — the user's explicit choice (2026-09-09) was to bring the new-orders
 * scrape back ONLY for this once-a-day check, not to re-enable it on
 * syncBigSeller()'s own (much more frequent) schedule.
 */
async function main() {
  const sheetsClient = await SheetsClient.create();
  const runId = generateRunId();
  await withBigSellerPage('order-stock-check', (page) => syncOrderDemand(page, sheetsClient, runId));
  await syncOrderStockCheck(sheetsClient);
  await logger.info('sync:order-stock-check complete');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
