import type { Tier } from './tiers.js';

/**
 * When a channel is allowed to act, as given by the user on 2026-09-11
 * (the numbered 12-channel list plus the handwritten cutoff note).
 *
 * Three shapes, because that is what was actually described — not a single
 * cutoff model bent to fit:
 *  - `batch_then_immediate`: hold until `batchMin` orders have piled up during
 *    the morning; from `immediateFrom` onward send whatever is there, however
 *    few ("ถ้าบ่ายขึ้นไปมีออเดอร์กี่ชิ้นเข้ามากี่ชิ้นก็สร้างเลย").
 *  - `instant`: the 2-hour Shopee channel. Runs until `morningCutoff`, stops,
 *    and resumes at `resumeAt` ("ตัดรอบเช้า 11:45 เริ่มดึงบ่ายโมง").
 *  - `platform_cutoff`: rides its platform's truck, so it waits until that
 *    truck's time and then goes.
 */
export type ChannelRule =
  | { kind: 'batch_then_immediate'; batchMin: number; immediateFrom: string }
  | { kind: 'instant'; morningCutoff: string; resumeAt: string }
  | { kind: 'platform_cutoff'; cutoff: string };

export interface ChannelPolicy {
  priority: Tier;
  rule: ChannelRule;
  /**
   * Carriers this one may share a wave with. Empty everywhere except the
   * BEST/DHL pair, which the user explicitly allowed to combine
   * ("BEST Express → DHL Domestic สร้างร่วม wave ได้") — the standing rule is
   * still one carrier per wave for everything else.
   */
  shareWaveWith: string[];
}

/** Truck times from the handwritten note: S(hopee) 16:01, L(azada) 13:01, T(ikTok) 14:01. */
export const PLATFORM_CUTOFF = { shopee: '16:01', lazada: '13:01', tiktok: '14:01' } as const;

const AFTERNOON = '13:00';
const BATCH_MIN = 10;

/**
 * The 12 channels in the order the user numbered them, with each one's timing.
 *
 * Keys are the EXACT labels BigSeller shows, verified against the live
 * โลจิสติกส์ filter and the wave page's courier tree on 2026-09-11. Platform
 * cutoffs are derived from the label's own prefix (Shopee-/Lazada-/TikTok-),
 * which is why no per-order platform lookup is needed.
 */
export const DEFAULT_CHANNEL_POLICIES: Record<string, ChannelPolicy> = {
  // 1 — batch of 10 in the morning, then anything goes.
  'Shopee-TH-Express Delivery (SPX)': {
    priority: 1,
    rule: { kind: 'batch_then_immediate', batchMin: BATCH_MIN, immediateFrom: AFTERNOON },
    shareWaveWith: [],
  },

  // 2 — the 2-hour channel. Matched on its stable prefix; the live label
  // carries a "- ส่งทันที (แพ็ก 2 ชั่วโมง)" suffix.
  'Shopee-TH-Instant Delivery': {
    priority: 2,
    rule: { kind: 'instant', morningCutoff: '11:45', resumeAt: AFTERNOON },
    shareWaveWith: [],
  },

  // 3 — same treatment as 1.
  'Shopee-TH-Express Delivery (SHP Food)': {
    priority: 3,
    rule: { kind: 'batch_then_immediate', batchMin: BATCH_MIN, immediateFrom: AFTERNOON },
    shareWaveWith: [],
  },

  // 4 — the one pair allowed to share a wave. They sit on different platforms
  // (BEST is TikTok 14:01, DHL is Shopee 16:01), so both use the EARLIER time:
  // waving them together at 16:01 would miss BEST's truck.
  'TikTok-TH-BEST Express': {
    priority: 4,
    rule: { kind: 'platform_cutoff', cutoff: PLATFORM_CUTOFF.tiktok },
    shareWaveWith: ['Shopee-TH-DHL Domestic'],
  },
  'Shopee-TH-DHL Domestic': {
    priority: 4,
    rule: { kind: 'platform_cutoff', cutoff: PLATFORM_CUTOFF.tiktok },
    shareWaveWith: ['TikTok-TH-BEST Express'],
  },

  // 5-12 — each rides its own platform's truck.
  'Lazada-TH-LEX TH': { priority: 5, rule: { kind: 'platform_cutoff', cutoff: PLATFORM_CUTOFF.lazada }, shareWaveWith: [] },
  'Shopee-TH-SPX Express': { priority: 6, rule: { kind: 'platform_cutoff', cutoff: PLATFORM_CUTOFF.shopee }, shareWaveWith: [] },
  'TikTok-TH-J&T Express': { priority: 7, rule: { kind: 'platform_cutoff', cutoff: PLATFORM_CUTOFF.tiktok }, shareWaveWith: [] },
  'TikTok-TH-Flash Express Thailand': {
    priority: 8,
    rule: { kind: 'platform_cutoff', cutoff: PLATFORM_CUTOFF.tiktok },
    shareWaveWith: [],
  },
  'Lazada-TH-Flash Express': { priority: 9, rule: { kind: 'platform_cutoff', cutoff: PLATFORM_CUTOFF.lazada }, shareWaveWith: [] },
  // SPX is Shopee's own carrier, so it takes the Shopee truck. The label
  // carries no platform prefix of its own — the one entry here that is an
  // inference rather than a reading, and worth correcting if the SPX(TH)
  // parcels actually leave on a different run.
  'SPX Express(TH)': { priority: 10, rule: { kind: 'platform_cutoff', cutoff: PLATFORM_CUTOFF.shopee }, shareWaveWith: [] },
  'TikTok-TH-KEX Express Thailand': {
    priority: 11,
    rule: { kind: 'platform_cutoff', cutoff: PLATFORM_CUTOFF.tiktok },
    shareWaveWith: [],
  },
  'Shopee-TH-Flash Express Bulky': {
    priority: 12,
    rule: { kind: 'platform_cutoff', cutoff: PLATFORM_CUTOFF.shopee },
    shareWaveWith: [],
  },
};
