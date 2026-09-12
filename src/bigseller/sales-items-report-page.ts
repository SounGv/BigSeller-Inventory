import type { Page } from '@playwright/test';
import { logger } from '../utils/logger.js';

export const SALES_ITEMS_URL = 'https://www.bigseller.com/web/statis/items.htm';

const SHOP_GROUP_LIST_API = 'https://www.bigseller.com/api/v1/shop/group/page.json';
const SKU_COUNT_API = 'https://www.bigseller.com/api/v1/skuSales/getSkuCountNew.json';
const SKU_PAGE_LIST_API = 'https://www.bigseller.com/api/v1/skuSales/skuPageList.json';

export type ChannelGroup = 'online' | 'offline' | 'all_excl_lockstock';

/**
 * Maps our internal channel_group key to the exact `groupName` string
 * BigSeller shows in the "กลุ่มร้านค้า" checkbox list (confirmed live
 * 2026-09-02) — see FEATURE-sales-online-offline-report.md.
 */
const GROUP_NAME_BY_CHANNEL: Record<ChannelGroup, string> = {
  online: 'ONLINE SHP TIK LAZ',
  offline: 'OFFLINE ALL',
  all_excl_lockstock: 'ALL ไม่รวม lockstock,เคลม',
};

interface ShopGroupApiRow {
  id: number;
  groupName: string;
  shopIds: number[];
}

interface SkuCountMetric {
  currentData: number;
}

interface SkuCountApiResponse {
  code: number;
  msg: string;
  data?: {
    salesCount: SkuCountMetric;
    effectiveSalesAmount: SkuCountMetric;
    salesVolumeCount: SkuCountMetric;
    effectiveSalesQuantity: SkuCountMetric;
    skuCount: SkuCountMetric;
    refundsCount: SkuCountMetric;
    refundsVolumeCount: SkuCountMetric;
    efficientsOrders: SkuCountMetric;
  };
}

interface SkuPageListApiRow {
  sku: string;
  title: string | null;
  sales: number;
  salesVolume: number;
  efficients: number;
  efficientsVolume: number;
  cancels: number;
  cancelsOrders: number;
}

interface SkuPageListApiResponse {
  code: number;
  msg: string;
  // Confirmed live 2026-09-02: rows sit directly under `data`, NOT nested
  // under `data.page` like order/new/pageList.json's shape — a real bug the
  // first time this was written (copied the wrong sibling endpoint's shape).
  data?: {
    totalSize: number;
    rows: SkuPageListApiRow[];
  };
}

export interface BestSellerRow {
  sku: string;
  productTitle: string | null;
  salesAmount: number;
  salesVolume: number;
  effectiveSalesAmount: number;
  effectiveSalesVolume: number;
  cancelsAmount: number;
  cancelsOrders: number;
}

export interface SalesSummaryRow {
  date: string; // YYYY-MM-DD
  channelGroup: ChannelGroup;
  salesCount: number;
  effectiveSalesAmount: number;
  salesVolumeCount: number;
  effectiveSalesQuantity: number;
  skuCount: number;
  refundsCount: number;
  refundsVolumeCount: number;
  efficientsOrders: number;
  sourceUrl: string;
}

/**
 * Reads per-day sales totals split by channel group (online/offline/all)
 * from BigSeller's "รายงานสินค้า" → "สรุปตาม SKU Merchant" page — via its
 * own internal JSON APIs, confirmed live 2026-09-02 (same approach as every
 * other page-object this session; see FEATURE-sales-online-offline-report.md
 * for the reconnaissance that found these two endpoints).
 *
 * The UI's "กลุ่มร้านค้า" checkbox filter has no dedicated API of its own —
 * it just resolves to a flat `shopGroupIds` list (the member shop IDs of
 * whichever group(s) are checked) sent to `getSkuCountNew.json`. That list
 * is looked up here via `shop/group/page.json` (which is what populates the
 * checkbox options in the first place) rather than hardcoding shop IDs, so
 * this keeps working if BigSeller ever renumbers shops within a group —
 * only breaks if someone renames the group itself in BigSeller's UI.
 *
 * IMPORTANT (confirmed live): the UI lets "กลุ่มร้านค้าทั้งหมด" (all
 * groups) stay checked alongside a specific group, which would silently
 * compute over their union — this class only ever sends ONE resolved
 * group's `shopIds`, so that whole failure mode doesn't apply here.
 */
export class BigSellerSalesItemsReportPage {
  constructor(private readonly page: Page) {}

  private async fetchShopGroups(): Promise<ShopGroupApiRow[]> {
    const res = await this.page.request.get(SHOP_GROUP_LIST_API);
    if (!res.ok()) {
      throw new Error(`shop/group/page.json returned HTTP ${res.status()}`);
    }
    const body = (await res.json()) as { code: number; msg: string; data?: ShopGroupApiRow[] };
    if (!body.data) {
      throw new Error(`shop/group/page.json returned code=${body.code}: ${body.msg}`);
    }
    return body.data;
  }

  private async resolveShopGroupIds(channel: ChannelGroup, groups: ShopGroupApiRow[]): Promise<string> {
    const targetName = GROUP_NAME_BY_CHANNEL[channel];
    const match = groups.find((g) => g.groupName === targetName);
    if (!match) {
      throw new Error(
        `resolveShopGroupIds: no shop group named "${targetName}" found in shop/group/page.json — it may have been renamed in BigSeller's UI. Available: ${groups.map((g) => g.groupName).join(', ')}`,
      );
    }
    // The `shopGroupIds` param takes the GROUP's own `id` (e.g. 57014 for
    // "ONLINE SHP TIK LAZ"), not its expanded member `shopIds` list —
    // confirmed live 2026-09-02 after sending the expanded shop-id list
    // produced all-zero results for every metric on every day tested; a
    // captured real UI request instead showed a short list of group `id`
    // values (161978, 102675, 86764, 57014, ...) matching this table's own
    // `id` column, not any shop's id.
    return String(match.id);
  }

  /** `date` is a single day, `YYYY-MM-DD` — from = to, matching the spec's decision to control exactly which day is pulled rather than trusting the UI's own "วันนี้/เมื่อวาน" presets. */
  async fetchDailySummary(channel: ChannelGroup, date: string): Promise<SalesSummaryRow> {
    const groups = await this.fetchShopGroups();
    const shopGroupIds = await this.resolveShopGroupIds(channel, groups);

    const res = await this.page.request.post(SKU_COUNT_API, {
      headers: { 'content-type': 'application/json' },
      data: {
        currency: 'THB',
        platform: '',
        searchType: 'sku',
        searchContent: '',
        inquireType: 0,
        beginDate: date,
        endDate: date,
        categoryList: '',
        warehouseIds: '',
        evalationOrder: '0',
        shopGroupIds,
        groupType: 0,
      },
    });
    if (!res.ok()) {
      throw new Error(`getSkuCountNew.json returned HTTP ${res.status()}`);
    }
    const body = (await res.json()) as SkuCountApiResponse;
    if (!body.data) {
      throw new Error(`getSkuCountNew.json returned code=${body.code}: ${body.msg}`);
    }

    await logger.info(`fetchDailySummary: ${channel} ${date} — sales=${body.data.effectiveSalesAmount.currentData}`);

    return {
      date,
      channelGroup: channel,
      salesCount: body.data.salesCount.currentData,
      effectiveSalesAmount: body.data.effectiveSalesAmount.currentData,
      salesVolumeCount: body.data.salesVolumeCount.currentData,
      effectiveSalesQuantity: body.data.effectiveSalesQuantity.currentData,
      skuCount: body.data.skuCount.currentData,
      refundsCount: body.data.refundsCount.currentData,
      refundsVolumeCount: body.data.refundsVolumeCount.currentData,
      efficientsOrders: body.data.efficientsOrders.currentData,
      sourceUrl: SALES_ITEMS_URL,
    };
  }

  /**
   * Top-N best-selling SKUs for a single day, ranked by effective (net,
   * post-cancellation) sales value — confirmed live 2026-09-02 via
   * `skuSales/skuPageList.json`, the same per-SKU table backing the
   * "ข้อมูลการขาย SKU Merchant" list under the summary cards on this page.
   * `channel` reuses the same group-name resolution as `fetchDailySummary`.
   */
  async fetchBestSellers(channel: ChannelGroup, date: string, limit = 10): Promise<BestSellerRow[]> {
    const groups = await this.fetchShopGroups();
    const shopGroupIds = await this.resolveShopGroupIds(channel, groups);

    const res = await this.page.request.post(SKU_PAGE_LIST_API, {
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      form: {
        currency: 'THB',
        pageSize: String(limit),
        pageNo: '1',
        platform: '',
        searchType: 'sku',
        searchContent: '',
        inquireType: '0',
        beginDate: date,
        endDate: date,
        orderBy: 'effectiveSalesAmount',
        desc: '1',
        categoryList: '',
        warehouseIds: '',
        evalationOrder: '0',
        groupFields: 'sku',
        spuId: '',
        shopGroupIds,
        groupType: '0',
        dimension: '',
      },
    });
    if (!res.ok()) {
      throw new Error(`skuPageList.json returned HTTP ${res.status()}`);
    }
    const body = (await res.json()) as SkuPageListApiResponse;
    if (!body.data) {
      throw new Error(`skuPageList.json returned code=${body.code}: ${body.msg}`);
    }

    await logger.info(`fetchBestSellers: ${channel} ${date} — ${body.data.rows.length} row(s)`);

    return body.data.rows.map((r) => ({
      sku: r.sku,
      productTitle: r.title,
      salesAmount: r.sales,
      salesVolume: r.salesVolume,
      effectiveSalesAmount: r.efficients,
      effectiveSalesVolume: r.efficientsVolume,
      cancelsAmount: r.cancels,
      cancelsOrders: r.cancelsOrders,
    }));
  }
}
