import type { Page } from '@playwright/test';
import { parseThaiDateTime } from '../utils/thai-date.js';
import { logger } from '../utils/logger.js';

export const REPLENISHMENT_URL = 'https://www.bigseller.com/web/inventory/replenishment/replenishmentShelves.htm';
export const MOVING_GOODS_URL = 'https://www.bigseller.com/web/inventory/movingGoods/index.htm';

const WAREHOUSE_LIST_API = 'https://www.bigseller.com/api/v1/warehouse/getWarehouseInfoVoListV2.json';
const MOVING_LIST_API = 'https://www.bigseller.com/api/v1/inventory/movingPlan/pageList.json';
const REPLETE_COUNT_API = 'https://www.bigseller.com/api/v1/inventory/wms/repletePlan/getRepletePlanStateCount.json';
const REPLETE_LIST_API = 'https://www.bigseller.com/api/v1/inventory/wms/repletePlan/pageList.json';

/**
 * Terminal state codes confirmed live 2026-09-01 for BOTH `movingPlan` and
 * `wms/repletePlan` (same backend convention reused across the two docTypes
 * — verified by cross-checking that an unfiltered movingPlan query's
 * totalSize exactly equals state=2's count + state=3's count, meaning no
 * other state currently has any rows): `2` = เสร็จเรียบร้อย (done, huge
 * all-time count — a terminal state items never leave), `3` = ยกเลิก
 * (cancelled, also terminal). Every other state code (0 confirmed =
 * รอนำเข้า from the page's own default-tab request; 1/4/5 unconfirmed
 * individually — see FEATURE-dashboard-home-page.md 1d) is treated as
 * "still active/backlog" without needing to know which specific pending
 * sub-stage it is, which is enough for the backlog-count/age use case this
 * feature needs.
 */
const TERMINAL_STATES = new Set([2, 3]);

export interface WarehouseBacklogRow {
  slipNo: string;
  warehouse: string;
  docType: 'replenishment' | 'moving';
  skuCount: number;
  statusCode: number;
  creator: string;
  operator: string | null;
  createdAt: string;
  updatedAt: string;
  sourceUrl: string;
}

async function resolveWarehouseId(page: Page, warehouseName: string): Promise<number> {
  const res = await page.request.post(WAREHOUSE_LIST_API, {
    headers: { 'content-type': 'application/json' },
    data: { isAreaSeparate: 1 },
  });
  const body = (await res.json()) as { data?: { id: number; name: string }[] };
  const match = body.data?.find((w) => w.name === warehouseName);
  if (!match) {
    throw new Error(`resolveWarehouseId: no warehouse named "${warehouseName}" in getWarehouseInfoVoListV2.json response`);
  }
  return match.id;
}

function activeStatesFromCountMap(counts: Record<string, number>): number[] {
  return Object.entries(counts)
    .map(([state, count]) => ({ state: Number(state), count }))
    .filter(({ state, count }) => count > 0 && !TERMINAL_STATES.has(state))
    .map(({ state }) => state);
}

interface MovingApiRow {
  movingNo: string;
  warehouseName: string;
  skuCount: number;
  userName: string;
  operatorUserName: string | null;
  movingState: number;
  createTimeStr: string;
  updateTimeStr: string;
}

interface RepleteApiRow {
  repleteNo: string;
  warehouseName: string;
  skuCount: number;
  accountName: string;
  operatorName: string | null;
  planRepleteState: number;
  createTime: string;
  updateTime: string;
}

/**
 * Reads the current backlog (non-terminal rows) from both "ย้ายสินค้า"
 * (internal moves, movingPlan) and "เติมสต็อกชั้นวาง" (shelf replenishment,
 * repletePlan) — FEATURE-dashboard-home-page.md section 1d. Both APIs found
 * live 2026-09-01 the same way as transfer-page.ts and
 * cancelled-orders-page.ts (network capture, not documented). No manual
 * checklist here — unlike 1b/1c, BigSeller already tracks the operator who
 * worked each slip natively (`operatorUserName`/`operatorName`), so this
 * sync is pure read, no staff dropdown/RPC needed.
 */
export class BigSellerWarehouseBacklogPage {
  constructor(private readonly page: Page) {}

  /**
   * `movingPlan/count.json` (checked live 2026-09-01) uses NAMED keys
   * (`notStarted`, `progressing`, `picking`, `storing`, `finish`,
   * `canceled`) instead of the numeric state codes `pageList.json` actually
   * takes as a query param — so unlike `fetchReplenishmentBacklog` below,
   * there is no confirmed way to translate "which named buckets are
   * non-zero" into the specific `state=N` values to query (the numeric
   * codes for progressing/picking/storing were never observed non-zero
   * during investigation, so they were never confirmed). Sidesteps the
   * problem entirely: fetch recent rows with NO `state` filter (returns
   * every state) over a short day window, then filter out the two
   * confirmed terminal state codes (2, 3) client-side. Cheap because
   * moving-goods slips are created steadily but not in huge daily volume.
   */
  async fetchMovingBacklog(warehouseName: string): Promise<WarehouseBacklogRow[]> {
    await this.page.goto(MOVING_GOODS_URL, { waitUntil: 'domcontentloaded' });
    await this.page.waitForTimeout(1500);

    const warehouseId = await resolveWarehouseId(this.page, warehouseName);

    const rows: MovingApiRow[] = [];
    let pageNo = 1;
    for (;;) {
      const res = await this.page.request.post(MOVING_LIST_API, {
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        form: { pageNo: String(pageNo), pageSize: '100', warehouseId: String(warehouseId), beginDate: '', endDate: '', days: '2', searchType: 'sku', inquireType: '0', searchContent: '', orderBy: 'createTime', desc: '1' },
      });
      const body = (await res.json()) as { data?: { rows: MovingApiRow[]; totalSize: number } };
      const pageRows = body.data?.rows ?? [];
      rows.push(...pageRows);
      const totalSize = body.data?.totalSize ?? 0;
      if (pageRows.length < 100 || pageNo * 100 >= totalSize) break;
      pageNo += 1;
      await this.page.waitForTimeout(800);
    }

    const activeRows = rows.filter((r) => !TERMINAL_STATES.has(r.movingState));
    await logger.info(`fetchMovingBacklog: scanned ${rows.length} row(s) over the last 2 days, ${activeRows.length} non-terminal`);

    return activeRows.map((r) => ({
      slipNo: r.movingNo,
      warehouse: r.warehouseName,
      docType: 'moving' as const,
      skuCount: r.skuCount,
      statusCode: r.movingState,
      creator: r.userName,
      operator: r.operatorUserName,
      createdAt: parseThaiDateTime(r.createTimeStr)?.toISOString() ?? r.createTimeStr,
      updatedAt: parseThaiDateTime(r.updateTimeStr)?.toISOString() ?? r.updateTimeStr,
      sourceUrl: MOVING_GOODS_URL,
    }));
  }

  async fetchReplenishmentBacklog(warehouseName: string): Promise<WarehouseBacklogRow[]> {
    await this.page.goto(REPLENISHMENT_URL, { waitUntil: 'domcontentloaded' });
    await this.page.waitForTimeout(1500);

    const warehouseId = await resolveWarehouseId(this.page, warehouseName);

    const countRes = await this.page.request.post(REPLETE_COUNT_API, {
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      form: { warehouseId: String(warehouseId), type: '', searchType: '', inquireType: '2', searchContent: '', orderBy: 'createTime', desc: '', pageNo: '1', pageSize: '50', beginDate: '', endDate: '', days: '' },
    });
    const countBody = (await countRes.json()) as { data?: Record<string, number> };
    const activeStates = activeStatesFromCountMap(countBody.data ?? {});
    await logger.info(`fetchReplenishmentBacklog: active (non-terminal) state codes with rows: ${JSON.stringify(activeStates)}`);

    const rows: RepleteApiRow[] = [];
    for (const state of activeStates) {
      const res = await this.page.request.post(REPLETE_LIST_API, {
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        form: { warehouseId: String(warehouseId), type: '', searchType: '', inquireType: '2', searchContent: '', orderBy: 'createTime', desc: '1', pageNo: '1', pageSize: '100', repleteState: String(state), beginDate: '', endDate: '', days: '' },
      });
      const body = (await res.json()) as { data?: { rows: RepleteApiRow[] } };
      rows.push(...(body.data?.rows ?? []));
      await this.page.waitForTimeout(800);
    }

    return rows.map((r) => ({
      slipNo: r.repleteNo,
      warehouse: r.warehouseName,
      docType: 'replenishment' as const,
      skuCount: r.skuCount,
      statusCode: r.planRepleteState,
      creator: r.accountName,
      operator: r.operatorName,
      createdAt: parseThaiDateTime(r.createTime)?.toISOString() ?? r.createTime,
      updatedAt: parseThaiDateTime(r.updateTime)?.toISOString() ?? r.updateTime,
      sourceUrl: REPLENISHMENT_URL,
    }));
  }
}
