import { parseThaiDateTime } from '../utils/thai-date.js';
import { SELLER_DELIVERY_CHANNEL, type WaveEngineConfig } from './config.js';

/** Priority 1 (most urgent) to 12, as numbered by the user 2026-09-11. */
export type Tier = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12;

/**
 * `skip` is distinct from `flag_manual` on purpose: a skipped order needs NO
 * human action, it is simply not this bot's business. Folding the two together
 * would inflate the manual queue — the number ops actually has to work through
 * — with dozens of reservations that are behaving exactly as intended.
 */
export type EngineAction = 'confirm_now' | 'wait' | 'flag_manual' | 'skip';

/** One order as read off `order/index.htm?status=new`, before any tier logic is applied. */
export interface ScannedOrder {
  orderId: string;
  orderNo: string;
  /** Matched known channel label, or '' when nothing in the map matched (-> manual review). */
  logisticsChannel: string;
  /** Full text of the "การตั้งค่าการจัดส่ง" cell, kept for logging so an unmapped courier is diagnosable. */
  rawShippingCell: string;
  urgentFlag: boolean;
  /** "YYYY-MM-DD" (Asia/Bangkok) parsed from กำหนดส่ง, or null when absent/unparseable. */
  deliveryDate: string | null;
  warehouse: string;
  /** True when the order belongs to the reserved-stock store (ของจอง). Determined by store-filter membership, not by reading the row. */
  isReserved: boolean;
  /** True when the order came from a platform this engine is not allowed to act on. Determined by platform-filter membership. */
  isBlockedPlatform: boolean;
  /** Milliseconds since epoch for the order's placed/paid timestamp, or null when unreadable. Oldest acts first within a priority. */
  orderTime: number | null;
  /** Milliseconds since epoch for the "Expire ..." deadline in the same cell, or null when the cell carries none. Past this, the platform auto-cancels the order — see applyExpiryUrgency. */
  expiresAt: number | null;
}

export interface DecisionContext {
  now: Date;
  /** Waiting order count per channel, for the morning batch-of-N rule. Missing channel = 0. */
  channelPendingCounts: Record<string, number>;
}

export interface Decision {
  tier: Tier | null;
  action: EngineAction;
  /** Stable machine-greppable code + human text, e.g. "GUARD_SELLER_DELIVERY_NO_DATE: ...". Guardrail codes are what the phase-1 DoD spot-checks for in the dry-run log. */
  reason: string;
  /** False for tier 1 — instant delivery is confirmed and waved alone, never batched with other channels (spec §2). */
  batchable: boolean;
  /** บาร์ด่วนพิเศษ override: sorts to the front of its own tier, without changing the tier (spec §2). */
  priorityBoost: boolean;
}

const BANGKOK = 'Asia/Bangkok';

/** "YYYY-MM-DD" in Asia/Bangkok regardless of the host machine's timezone. */
export function bangkokDateKey(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: BANGKOK,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** "HH:MM" (24h) in Asia/Bangkok. */
export function bangkokHhMm(now: Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: BANGKOK,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(now);
}

/**
 * Finds which known channel the shipping cell's text refers to.
 *
 * Substring (not equality) matching, because the real cell contains tracking
 * numbers and other shipping text around the courier name. Longest label first
 * so a broad shorthand can't shadow a specific one — "SPX" (tier 4) must not
 * win over "SPX Express(TH)" or "Shopee-TH-SPX (รับที่จุดบริการ)" (both tier 2).
 * Returns '' when nothing matches, which the caller must treat as manual-review
 * (spec §7), never as a default tier.
 */
/**
 * Courier names that CONTAIN a ranked channel's name but are a different job.
 *
 * "Shopee-TH-SPX Express - ผู้ซื้อรับที่จุดบริการ SPX" contains
 * "Shopee-TH-SPX Express" word for word, so plain containment handed it
 * priority 6 and would have confirmed and waved it as an ordinary SPX parcel.
 * It is not one — the buyer collects it from a service point — and it was
 * named on 2026-09-11 as a courier with no priority yet. Seen live in the
 * queue on 2026-09-12.
 *
 * A marker here means "never inherit a rank from the name you sit inside":
 * the order falls to manual review, which is the safe outcome for a courier
 * nobody has ranked.
 */
const UNRANKED_VARIANT_MARKERS = ['ผู้ซื้อรับที่จุดบริการ'];

export function resolveLogisticsChannel(rawShippingCell: string, config: WaveEngineConfig): string {
  const haystack = rawShippingCell.toLowerCase();
  if (UNRANKED_VARIANT_MARKERS.some((marker) => haystack.includes(marker.toLowerCase()))) return '';
  const labels = [SELLER_DELIVERY_CHANNEL, ...Object.keys(config.channelPolicies)].sort((a, b) => b.length - a.length);
  return labels.find((label) => haystack.includes(label.toLowerCase())) ?? '';
}

const NUMERIC_DATE = /(\d{1,4})[-/](\d{1,2})[-/](\d{1,4})/;

/**
 * Parses whatever the กำหนดส่ง field renders into "YYYY-MM-DD".
 *
 * The real format of this field is NOT confirmed (spec §8 open question 1), so
 * this accepts the shapes BigSeller is known to use elsewhere in this repo —
 * Thai "DD MMM YYYY [HH:mm]" (see thai-date.ts) and numeric DD/MM/YYYY or
 * YYYY-MM-DD — and returns null on anything else. Null is a safe outcome: a
 * Seller Delivery order with no usable date is flagged for manual input rather
 * than guessed at (spec §7).
 */
export function parseDeliveryDate(raw: string | null | undefined): string | null {
  if (!raw?.trim()) return null;
  const text = raw.trim();

  const thai = parseThaiDateTime(text) ?? parseThaiDateTime(`${text} 00:00`);
  if (thai) return formatDateParts(thai.getFullYear(), thai.getMonth() + 1, thai.getDate());

  const numeric = text.match(NUMERIC_DATE);
  if (numeric) {
    const [, a, b, c] = numeric;
    // YYYY-MM-DD when the first group is a 4-digit year, otherwise DD/MM/YYYY —
    // Thai UI convention, and the only reading that makes a day > 12 valid.
    const [year, month, day] = a.length === 4 ? [Number(a), Number(b), Number(c)] : [Number(c), Number(b), Number(a)];
    if (year > 2000 && month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return formatDateParts(year, month, day);
    }
  }

  return null;
}

function formatDateParts(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * The whole spec §2 priority table as one pure function: no page, no clock of
 * its own, no side effects — so every tier and guardrail is unit-testable
 * without a browser (see tests/wave-engine-tiers.spec.ts).
 *
 * Returns what the bot WOULD do. Whether that actually gets clicked is the
 * executor's call (phase 1: tier 1 only, and only behind ENABLE_LIVE_TIER1).
 */
export function classifyOrder(order: ScannedOrder, config: WaveEngineConfig, ctx: DecisionContext): Decision {
  return applyPlatformGuard(
    order,
    applyReservedStoreGuard(
      order,
      applyWarehouseGuard(order, applyExpiryUrgency(order, classifyByTier(order, config, ctx), config, ctx.now), config),
      config,
    ),
    config,
  );
}

/**
 * An order the platform will auto-cancel if left unconfirmed past its own
 * "หมดอายุใน ..." deadline loses the sale entirely — worse than any batching
 * or truck-cutoff rule this engine otherwise honours. Requested 2026-09-14
 * ("เรื่องคำสั่งซื้อ ที่มาก่อนและใกล้หมดอายุ"): inside `expiryUrgentMinutes` of
 * that deadline, the order jumps its own tier's queue instead of waiting for
 * a batch size, a truck cutoff, or the morning "wait for N" rule.
 *
 * Only promotes a `wait` decision. It does not reach into `flag_manual` or
 * `skip` — those come from a hard fact (wrong warehouse, a reservation, a
 * blocked platform, an unclassified courier) that being close to expiry does
 * not change; a reservation about to expire is still not this engine's order
 * to confirm. Applied BEFORE the warehouse/reserved/platform guards precisely
 * so those guards still win over it.
 */
function applyExpiryUrgency(order: ScannedOrder, decision: Decision, config: WaveEngineConfig, now: Date): Decision {
  if (decision.action !== 'wait' || order.expiresAt === null) return decision;
  const minutesLeft = (order.expiresAt - now.getTime()) / 60000;
  if (minutesLeft > config.expiryUrgentMinutes) return decision;
  const readable = minutesLeft <= 0 ? 'already past its deadline' : `${Math.round(minutesLeft)} min left`;
  return {
    ...decision,
    action: 'confirm_now',
    priorityBoost: true,
    reason: `URGENT_EXPIRING_SOON: ${readable} before this order auto-cancels (threshold ${config.expiryUrgentMinutes} min) — jumping ahead of "${decision.reason}"`,
  };
}

/**
 * Only the marketplace platforms may be acted on — Shopee, Lazada and TikTok
 * ("ที่วงไว้ร้านอื่น ห้ามแตะ", 2026-09-11). Everything else on the platform
 * filter (คำสั่งซื้อด้วยตนเอง, WooCommerce, POS, ทางแชท) is somebody else's
 * process.
 *
 * This matters beyond the reserved store: on 2026-09-11 the queue held 79
 * manual orders while only ~60 of them were LockStock reservations, so ~19
 * were already inside the engine's reach with nothing stopping it.
 *
 * Applied LAST, so it overrides every other outcome including `skip` — the
 * platform decides whether this engine has any business with the order at
 * all.
 */
function applyPlatformGuard(order: ScannedOrder, decision: Decision, config: WaveEngineConfig): Decision {
  if (!order.isBlockedPlatform) return decision;
  return {
    ...decision,
    action: 'skip',
    reason: `EXCLUDED_PLATFORM: not one of ${config.allowedPlatforms.join(' / ')} — this engine only handles marketplace orders`,
  };
}

/**
 * Orders in the reserved-stock store (`LockStock`) are stock RESERVATIONS a
 * salesperson opened to hold goods for a customer — not shipments. Instructed
 * 2026-09-11: leave them alone entirely ("ของจอง เซลล์ไม่ต้อง เว้นไว้").
 * Confirming one would push a reservation into picking and ship stock that was
 * being held for someone else.
 *
 * Applied LAST so it wins over every other outcome: a reservation is not a
 * shipment no matter what tier or warehouse it sits in, and there is nothing
 * for anyone to fix about it. The tier is kept in the record for the audit
 * trail.
 */
function applyReservedStoreGuard(order: ScannedOrder, decision: Decision, config: WaveEngineConfig): Decision {
  if (!order.isReserved) return decision;
  return {
    ...decision,
    action: 'skip',
    reason:
      `EXCLUDED_RESERVED_STORE: belongs to the "${config.reservedStore}" store (ของจอง — stock a salesperson is holding), ` +
      'never confirmed or waved, and needs no human follow-up',
  };
}

/**
 * Stock reality overrides tier urgency: only `pickingWarehouse` (STOCK_5) holds
 * sellable stock, so an order allocated to any other warehouse cannot ship
 * until a human physically moves goods — most often the decoy warehouse
 * `STOCK_ซิงก์ขายออนไลน์`, which mirrors quantities of DAMAGED stock sitting in
 * STOCK_5's ตำแหน่งชำรุด (see decoy-reconciliation-service.ts). Confirming such
 * an order would promise a customer stock that is either elsewhere or broken.
 *
 * The bot never moves stock itself — instructed 2026-09-10: report it and a
 * human moves it. There is deliberately no transfer code path here, and this
 * repo's transfer pipeline (plan:moves / import:moves) is NOT called from the
 * wave engine.
 *
 * Applied as an override AFTER tier classification, not instead of it, so the
 * audit log still records which tier the order belonged to (e.g. "tier=1
 * action=flag_manual") — useful when deciding how urgently to move the stock.
 * No-ops while `warehouse` is unknown (''), which is the honest default until
 * the คลังสินค้า filter supplies it.
 */
function applyWarehouseGuard(order: ScannedOrder, decision: Decision, config: WaveEngineConfig): Decision {
  if (!order.warehouse || order.warehouse === config.pickingWarehouse) return decision;

  const decoyNote =
    order.warehouse === config.decoyWarehouse
      ? ` This is the decoy warehouse that mirrors damaged stock held in ${config.pickingWarehouse}'s ตำแหน่งชำรุด, so the goods are not sellable as-is.`
      : '';

  return {
    ...decision,
    action: 'flag_manual',
    reason:
      `GUARD_WRONG_WAREHOUSE: allocated to "${order.warehouse}", not ${config.pickingWarehouse} — stock must be moved to ` +
      `${config.pickingWarehouse} by a human before this can ship; the bot never moves stock itself.${decoyNote} ` +
      `(tier ${String(decision.tier)} would otherwise have been "${decision.action}")`,
  };
}

function classifyByTier(order: ScannedOrder, config: WaveEngineConfig, ctx: DecisionContext): Decision {
  const nowHhMm = bangkokHhMm(ctx.now);
  const today = bangkokDateKey(ctx.now);
  const boost = order.urgentFlag;

  if (!order.logisticsChannel) {
    return {
      tier: null,
      action: 'flag_manual',
      reason: `GUARD_UNCLASSIFIED_CHANNEL: no known logistics channel matched — likely a new courier in BigSeller. Raw cell: "${truncate(order.rawShippingCell)}"`,
      batchable: false,
      priorityBoost: boost,
    };
  }

  if (order.logisticsChannel === SELLER_DELIVERY_CHANNEL) {
    return classifySellerDelivery(order, config, { nowHhMm, today, boost });
  }

  const policy = config.channelPolicies[order.logisticsChannel];
  if (!policy) {
    return {
      tier: null,
      action: 'flag_manual',
      reason: `GUARD_UNCLASSIFIED_CHANNEL: channel "${order.logisticsChannel}" has no policy — add it before it can be acted on`,
      batchable: false,
      priorityBoost: boost,
    };
  }

  const { priority, rule } = policy;

  if (rule.kind === 'batch_then_immediate') {
    // From the afternoon on, however few there are, go
    // ("ถ้าบ่ายขึ้นไปมีออเดอร์กี่ชิ้นเข้ามากี่ชิ้นก็สร้างเลย").
    if (nowHhMm >= rule.immediateFrom) {
      return {
        tier: priority,
        action: 'confirm_now',
        reason: `CONFIRM_P${priority}_AFTERNOON: ${nowHhMm} >= ${rule.immediateFrom} — any quantity goes from here on`,
        batchable: true,
        priorityBoost: boost,
      };
    }
    // Morning: hold until the batch fills.
    const pending = ctx.channelPendingCounts[order.logisticsChannel] ?? 0;
    if (pending >= rule.batchMin) {
      return {
        tier: priority,
        action: 'confirm_now',
        reason: `CONFIRM_P${priority}_BATCH: ${pending} waiting >= batch of ${rule.batchMin} (morning rule)`,
        batchable: true,
        priorityBoost: boost,
      };
    }
    return {
      tier: priority,
      action: 'wait',
      reason: `WAIT_P${priority}_BATCH: ${pending}/${rule.batchMin} waiting, and ${nowHhMm} < ${rule.immediateFrom}`,
      batchable: true,
      priorityBoost: boost,
    };
  }

  if (rule.kind === 'instant') {
    // Runs up to the morning cutoff, pauses, resumes in the afternoon
    // ("ตัดรอบเช้า 11:45 เริ่มดึงบ่ายโมง").
    const paused = nowHhMm >= rule.morningCutoff && nowHhMm < rule.resumeAt;
    if (paused) {
      return {
        tier: priority,
        action: 'wait',
        reason: `WAIT_P${priority}_BETWEEN_ROUNDS: past the ${rule.morningCutoff} morning cutoff, next round opens ${rule.resumeAt}`,
        batchable: false,
        priorityBoost: boost,
      };
    }
    return {
      tier: priority,
      action: 'confirm_now',
      reason: `CONFIRM_P${priority}_INSTANT: 2-hour channel, inside a round (cutoff ${rule.morningCutoff}, resumes ${rule.resumeAt})`,
      batchable: false,
      priorityBoost: boost,
    };
  }

  // platform_cutoff — rides its platform's truck, so it waits for that time
  // and then everything accumulated goes out together.
  if (nowHhMm >= rule.cutoff) {
    return {
      tier: priority,
      action: 'confirm_now',
      reason: `CONFIRM_P${priority}_CUTOFF: ${nowHhMm} >= truck cutoff ${rule.cutoff}`,
      batchable: true,
      priorityBoost: boost,
    };
  }
  return {
    tier: priority,
    action: 'wait',
    reason: `WAIT_P${priority}_BEFORE_CUTOFF: ${nowHhMm} < truck cutoff ${rule.cutoff}`,
    batchable: true,
    priorityBoost: boost,
  };
}

function classifySellerDelivery(
  order: ScannedOrder,
  config: WaveEngineConfig,
  { nowHhMm, today, boost }: { nowHhMm: string; today: string; boost: boolean },
): Decision {
  if (!order.deliveryDate) {
    return {
      tier: null,
      action: 'flag_manual',
      reason:
        'GUARD_SELLER_DELIVERY_NO_DATE: Seller Delivery with no กำหนดส่ง date — routed to manual queue, never auto-confirmed (guessing risks either making a walk-in customer wait or wasting a Wave slot)',
      batchable: false,
      priorityBoost: boost,
    };
  }

  if (order.deliveryDate === today || order.urgentFlag) {
    return {
      tier: 5,
      action: 'confirm_now',
      reason:
        order.deliveryDate === today
          ? `CONFIRM_TIER0_TODAY: Seller Delivery due today (${order.deliveryDate})`
          : `CONFIRM_TIER0_URGENT: Seller Delivery carrying the urgent flag (กำหนดส่ง ${order.deliveryDate})`,
      batchable: false,
      priorityBoost: boost,
    };
  }

  if (order.deliveryDate < today) {
    // Not covered by §2. An already-overdue walk-in is not something to
    // silently auto-confirm on the bot's own reading of an unverified date
    // field — a human should see it.
    return {
      tier: null,
      action: 'flag_manual',
      reason: `GUARD_SELLER_DELIVERY_PAST_DATE: กำหนดส่ง ${order.deliveryDate} is before today (${today}) — not covered by the priority table, needs a human`,
      batchable: false,
      priorityBoost: boost,
    };
  }

  if (!config.endOfDaySweepTime) {
    return {
      tier: 5,
      action: 'wait',
      reason: `WAIT_NO_EOD_CONFIGURED: priority 5 (Seller Delivery due ${order.deliveryDate}) needs WAVE_ENGINE_END_OF_DAY_SWEEP set before it can act`,
      batchable: true,
      priorityBoost: boost,
    };
  }

  if (nowHhMm >= config.endOfDaySweepTime) {
    return {
      tier: 5,
      action: 'confirm_now',
      reason: `CONFIRM_PRIORITY5_EOD: ${nowHhMm} >= end-of-day sweep ${config.endOfDaySweepTime} (due ${order.deliveryDate})`,
      batchable: true,
      priorityBoost: boost,
    };
  }

  return {
    tier: 5,
    action: 'wait',
    reason: `WAIT_BEFORE_EOD: ${nowHhMm} < end-of-day sweep ${config.endOfDaySweepTime} (due ${order.deliveryDate})`,
    batchable: true,
    priorityBoost: boost,
  };
}

/**
 * Execution order: lowest priority number first (1 = most urgent), then
 * urgent-flagged orders ahead of the rest within that same priority, then
 * original scan order.
 *
 * Sorting by the urgent flag ALONE — as this did until 2026-09-11 — quietly
 * ignores the whole 1-5 ranking: with a confirm cap in play it would pick a
 * priority-2 order while priority-1 Shopee Food orders sat waiting, which is
 * precisely backwards. Unclassified rows (tier null) sort last; they are never
 * confirmed anyway.
 */
export function sortByPriority<T extends { decision: Decision; order?: ScannedOrder }>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    const tierOf = (decision: Decision) => decision.tier ?? Number.POSITIVE_INFINITY;
    if (tierOf(a.decision) !== tierOf(b.decision)) return tierOf(a.decision) - tierOf(b.decision);
    if (a.decision.priorityBoost !== b.decision.priorityBoost) {
      return Number(b.decision.priorityBoost) - Number(a.decision.priorityBoost);
    }
    // Nearest to its own expiry deadline first — a real per-order fact, not an
    // approximation. Only meaningful when both sides have one; either side
    // missing it falls through to placed-time.
    const expiryOf = (item: T) => item.order?.expiresAt ?? Number.POSITIVE_INFINITY;
    if (expiryOf(a) !== expiryOf(b)) return expiryOf(a) - expiryOf(b);
    // Oldest order first ("เวลาออเดอร์ที่มาก่อน"): the order that has been
    // waiting longest goes next. Orders with no readable timestamp sort last
    // rather than jumping the queue on a parse failure.
    const timeOf = (item: T) => item.order?.orderTime ?? Number.POSITIVE_INFINITY;
    return timeOf(a) - timeOf(b);
  });
}

function truncate(text: string, max = 200): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}
