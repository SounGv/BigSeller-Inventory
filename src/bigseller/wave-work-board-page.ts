import type { Page } from '@playwright/test';

export const WAVE_WORK_BOARD_URL = 'https://www.bigseller.com/web/statis/waveWorkBoard.htm';

const SHIPPED_ORDER_RANK_API = 'https://www.bigseller.com/api/v1/wave/dashboard/shippedOrderRank.json';

export type WaveRankType = 'pick' | 'sort' | 'shipped' | 'package' | 'scan_inspection';

const RANK_KEY_TO_TYPE: Record<string, WaveRankType> = {
  pickRank: 'pick',
  sortRank: 'sort',
  shippedRank: 'shipped',
  packageRank: 'package',
  scanInspectionRank: 'scan_inspection',
};

interface RankVo {
  uid: number;
  employee: string;
  packageNum: number;
  skuNum: number;
}

interface ShippedOrderRankResponse {
  code: number;
  msg: string;
  data?: Record<string, { shippedPackageNum: number; avgShippedPackageNum: number; vos: RankVo[] }>;
}

export interface WaveRankingRow {
  rankType: WaveRankType;
  employee: string;
  packageNum: number;
  skuNum: number;
  sourceUrl: string;
}

/**
 * Reads today's live operator ranking from BigSeller's own "แผงรายงาน Wave"
 * dashboard — found live 2026-09-01 via network capture (undocumented
 * internal API, same caveats as transfer-page.ts/cancelled-orders-page.ts).
 * `pickRank` = อันดับการหยิบวันนี้, `packageRank` = อันดับการบรรจุวันนี้ —
 * confirmed by matching operator names/order-of-magnitude against the real
 * UI screenshot the user sent. This single endpoint covers BOTH online and
 * offline staff (`employee` is the same BigSeller login used as `staff.id`
 * in Supabase) and supersedes the earlier plan in
 * FEATURE-operator-picking-performance.md to scrape `packagedAnalytics.htm`
 * for picking only — that page was chosen specifically because no "packing"
 * report was known to exist at the time; this one has packing too
 * (`packageRank`), so there's no reason to keep both.
 *
 * This is a live "right now, today" snapshot with no date-range filter
 * (unlike packagedAnalytics.htm) — fine for a real-time ranking widget, not
 * suitable for historical backfill.
 */
export class BigSellerWaveWorkBoardPage {
  constructor(private readonly page: Page) {}

  async fetchTodayRanking(): Promise<WaveRankingRow[]> {
    await this.page.goto(WAVE_WORK_BOARD_URL, { waitUntil: 'domcontentloaded' });
    await this.page.waitForTimeout(1500);

    const res = await this.page.request.get(`${SHIPPED_ORDER_RANK_API}?warehouseId=`);
    if (!res.ok()) {
      throw new Error(`shippedOrderRank.json returned HTTP ${res.status()}`);
    }
    const body = (await res.json()) as ShippedOrderRankResponse;
    if (!body.data) {
      throw new Error(`shippedOrderRank.json returned code=${body.code}: ${body.msg}`);
    }

    const rows: WaveRankingRow[] = [];
    for (const [key, section] of Object.entries(body.data)) {
      const rankType = RANK_KEY_TO_TYPE[key];
      if (!rankType) continue; // unrecognized key from a future BigSeller change — skip rather than guess
      for (const vo of section.vos) {
        rows.push({
          rankType,
          employee: vo.employee,
          packageNum: vo.packageNum,
          skuNum: vo.skuNum,
          sourceUrl: WAVE_WORK_BOARD_URL,
        });
      }
    }
    return rows;
  }
}
