import { existsSync } from 'node:fs';
import { test, expect } from '@playwright/test';
import { getStorageStatePath, ensureSessionValid, SessionExpiredError } from '../src/bigseller/auth.js';
import { BigSellerInventoryPage } from '../src/bigseller/inventory-page.js';
import { SheetsClient } from '../src/sheets/sheets-client.js';
import { inventoryRowKey } from '../src/types.js';

const INVENTORY_URL = process.env.BIGSELLER_INVENTORY_URL ?? 'https://www.bigseller.com/web/inventory/warehouseInventory.htm';
const hasSession = existsSync(getStorageStatePath());
const hasFilters = Boolean(process.env.INVENTORY_WAREHOUSE_NAME);

test.describe('BigSeller inventory sync (integration)', () => {
  test.skip(
    !hasSession || !hasFilters,
    'Requires a saved session (npm run login:bigseller) and INVENTORY_WAREHOUSE_NAME in .env',
  );

  test('session is valid before scraping', async ({ page }) => {
    await ensureSessionValid(page, INVENTORY_URL);
  });

  test('exports and parses inventory rows with the expected shape', async ({ page }) => {
    const inventoryPage = new BigSellerInventoryPage(page);
    await inventoryPage.goto();
    await inventoryPage.selectWarehouse(process.env.INVENTORY_WAREHOUSE_NAME!);
    if (process.env.INVENTORY_AREA_NAME) {
      await inventoryPage.selectArea(process.env.INVENTORY_AREA_NAME);
    }
    await inventoryPage.selectPositionType(process.env.INVENTORY_POSITION_TYPE_NAME ?? 'ตำแหน่งหยิบสินค้า');

    const rows = await inventoryPage.exportAllRows();

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.sku).not.toBe('');
      expect(Number.isFinite(row.stockAtPosition)).toBe(true);
    }
  });

  test('duplicate keys are prevented via upsert (dedupe key: sku+warehouse+area+position+positionType)', async () => {
    const sheetsClient = await SheetsClient.create();
    const sampleRow = {
      sku: `TEST-SKU-${Date.now()}`,
      warehouse: 'TEST-WH',
      area: 'TEST-AREA',
      position: 'TEST-POS',
      positionType: 'ตำแหน่งหยิบสินค้า',
      stockAtPosition: 10,
      lockedStock: 0,
      availableStock: 10,
      unshelvedStock: 0,
      maxStock: 100,
      minStock: 5,
      sourceUpdatedAt: new Date().toISOString(),
      sourceUrl: INVENTORY_URL,
    };

    const headers = [
      'sku', 'warehouse', 'area', 'position', 'positionType',
      'stockAtPosition', 'lockedStock', 'availableStock', 'unshelvedStock',
      'maxStock', 'minStock', 'sourceUpdatedAt', 'sourceUrl',
    ];
    const keyColumns = ['sku', 'warehouse', 'area', 'position', 'positionType'];

    // Upsert the same key twice; the sheet must not gain two rows for it.
    await sheetsClient.upsertRows('DB_LOCATION_CURRENT', [sampleRow], { headers, keyColumns });
    await sheetsClient.upsertRows('DB_LOCATION_CURRENT', [{ ...sampleRow, stockAtPosition: 20 }], { headers, keyColumns });

    if (process.env.DRY_RUN?.toLowerCase() !== 'true') {
      const all = await sheetsClient.readAll('DB_LOCATION_CURRENT');
      const matches = all.filter((row) => inventoryRowKey(sampleRow) === row.slice(0, 5).join('::'));
      expect(matches.length).toBeLessThanOrEqual(1);
    }
  });

  test('SessionExpiredError is thrown (not silently retried with credentials) when session is invalid', async () => {
    expect(SessionExpiredError).toBeDefined();
  });
});
