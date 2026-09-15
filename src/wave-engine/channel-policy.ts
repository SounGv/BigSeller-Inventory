import type { Tier } from './tiers.js';

/**
 * When a channel is allowed to act, as given by the user on 2026-09-11
 * (the numbered 12-channel list plus the handwritten cutoff note), CORRECTED
 * 2026-09-15: the platform truck times (16:01/13:01/14:01) are the courier's
 * own cutoff for still ACCEPTING parcels that day — "ตัดรอบรับงาน" — not a
 * time this engine should wait for before confirming anything. "ครบจำนวนก็
 * สร้างได้เลย" (once enough have piled up, go immediately) and "พวกที่ไม่ใช่
 * ด่วนไม่ต้องรอถึง 16:01 น. หน้างานจริงจะบ้าหรือไง" (waiting until the truck
 * time for non-urgent channels would be crazy in a real warehouse) — every
 * platform-riding channel (4 through 12) used to be `platform_cutoff`, which
 * did exactly that: sat on hundreds of ready-to-wave orders all day doing
 * nothing, waiting for a clock. It is now `batch_then_immediate` — the same
 * shape channel 1 already used correctly — so it goes the moment enough have
 * piled up, any time of day, and the truck time is only a final deadline: if
 * the batch still hasn't filled by then, send whatever is left anyway rather
 * than miss that day's pickup entirely.
 *
 * Two shapes now, both meaning "don't sit on a full batch waiting for a
 * clock":
 *  - `batch_then_immediate`: hold until `batchMin` orders have piled up;
 *    from `immediateFrom` onward (a truck cutoff, or channel 1's own 13:00)
 *    send whatever is there, however few.
 *  - `instant`: the 2-hour Shopee channel. Runs until `morningCutoff`, stops,
 *    and resumes at `resumeAt` ("ตัดรอบเช้า 11:45 เริ่มดึงบ่ายโมง").
 */
export type ChannelRule =
  | { kind: 'batch_then_immediate'; batchMin: number; immediateFrom: string }
  | { kind: 'instant'; morningCutoff: string; resumeAt: string };

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

/** Truck times from the handwritten note: S(hopee) 16:01, L(azada) 13:01, T(ikTok) 14:01 — deadlines to still be ACCEPTED that day, not start times. */
export const PLATFORM_CUTOFF = { shopee: '16:01', lazada: '13:01', tiktok: '14:01' } as const;

const AFTERNOON = '13:00';
const BATCH_MIN = 10;
/**
 * "Worth a wave" for channels 4-12, whose own rule doesn't otherwise say a
 * number — mirrors WAVE_ENGINE_MIN_PARCELS_MULTI's default (20). Reaching
 * this is what makes going immediately worth doing; below it, hold rather
 * than fire on every small trickle.
 */
const WAVE_BATCH_MIN = 20;

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
  // (BEST is TikTok 14:01, DHL is Shopee 16:01), so both use the EARLIER time
  // as their deadline: leaving it to 16:01 would miss BEST's truck.
  'TikTok-TH-BEST Express': {
    priority: 4,
    rule: { kind: 'batch_then_immediate', batchMin: WAVE_BATCH_MIN, immediateFrom: PLATFORM_CUTOFF.tiktok },
    shareWaveWith: ['Shopee-TH-DHL Domestic'],
  },
  'Shopee-TH-DHL Domestic': {
    priority: 4,
    rule: { kind: 'batch_then_immediate', batchMin: WAVE_BATCH_MIN, immediateFrom: PLATFORM_CUTOFF.tiktok },
    shareWaveWith: ['TikTok-TH-BEST Express'],
  },

  // 5-12 — each rides its own platform's truck, whose time is now a
  // last-call DEADLINE, not a start signal: confirm+wave as soon as
  // WAVE_BATCH_MIN piles up, any time of day.
  'Lazada-TH-LEX TH': {
    priority: 5,
    rule: { kind: 'batch_then_immediate', batchMin: WAVE_BATCH_MIN, immediateFrom: PLATFORM_CUTOFF.lazada },
    shareWaveWith: [],
  },
  'Shopee-TH-SPX Express': {
    priority: 6,
    rule: { kind: 'batch_then_immediate', batchMin: WAVE_BATCH_MIN, immediateFrom: PLATFORM_CUTOFF.shopee },
    shareWaveWith: [],
  },
  'TikTok-TH-J&T Express': {
    priority: 7,
    rule: { kind: 'batch_then_immediate', batchMin: WAVE_BATCH_MIN, immediateFrom: PLATFORM_CUTOFF.tiktok },
    shareWaveWith: [],
  },
  'TikTok-TH-Flash Express Thailand': {
    priority: 8,
    rule: { kind: 'batch_then_immediate', batchMin: WAVE_BATCH_MIN, immediateFrom: PLATFORM_CUTOFF.tiktok },
    shareWaveWith: [],
  },
  'Lazada-TH-Flash Express': {
    priority: 9,
    rule: { kind: 'batch_then_immediate', batchMin: WAVE_BATCH_MIN, immediateFrom: PLATFORM_CUTOFF.lazada },
    shareWaveWith: [],
  },
  // SPX is Shopee's own carrier, so it takes the Shopee truck. The label
  // carries no platform prefix of its own — the one entry here that is an
  // inference rather than a reading, and worth correcting if the SPX(TH)
  // parcels actually leave on a different run.
  'SPX Express(TH)': {
    priority: 10,
    rule: { kind: 'batch_then_immediate', batchMin: WAVE_BATCH_MIN, immediateFrom: PLATFORM_CUTOFF.shopee },
    shareWaveWith: [],
  },
  'TikTok-TH-KEX Express Thailand': {
    priority: 11,
    rule: { kind: 'batch_then_immediate', batchMin: WAVE_BATCH_MIN, immediateFrom: PLATFORM_CUTOFF.tiktok },
    shareWaveWith: [],
  },
  'Shopee-TH-Flash Express Bulky': {
    priority: 12,
    rule: { kind: 'batch_then_immediate', batchMin: WAVE_BATCH_MIN, immediateFrom: PLATFORM_CUTOFF.shopee },
    shareWaveWith: [],
  },
};
