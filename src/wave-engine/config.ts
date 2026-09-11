import { readFileSync } from 'node:fs';
import { logger } from '../utils/logger.js';
import { DEFAULT_CHANNEL_POLICIES, type ChannelPolicy } from './channel-policy.js';
import type { Tier } from './tiers.js';

/**
 * Every value the priority engine decides with, in one place — spec §5
 * requires these to be externalized rather than hardcoded in the bot, because
 * truck cutoff times vary by warehouse and change seasonally, and because a
 * new courier appearing in BigSeller must not silently fall into a tier.
 *
 * Deliberately UNSET by default: CUTOFF_WINDOWS and END_OF_DAY_SWEEP_TIME.
 * Nobody has given real truck times yet, so there is no honest number to put
 * here. Unset, priorities 3/4/5 always evaluate to `wait` with an explicit
 * "not configured" reason rather than acting on a number this repo invented.
 */
export interface TimeWindow {
  start: string; // "HH:MM", Asia/Bangkok
  end: string;
}

export interface WaveEngineConfig {
  /** Exact BigSeller logistics label -> its priority and timing rule. Matched case-insensitively, longest label first (see resolveLogisticsChannel). */
  channelPolicies: Record<string, ChannelPolicy>;
  endOfDaySweepTime: string | null;
  /** Fixed-time safety check before the standard-round cutoffs. Stub only — nothing acts on it yet. */
  forcedTriggerTime: string;
  /** Exactly which priorities may click for real. Empty = full dry run. Nothing self-enables. */
  livePriorities: ReadonlySet<Tier>;
  urgentLoopMinutes: number;
  mainLoopMinutes: number;
  /** ±N seconds of jitter on every loop trigger, so the bot never fires on an exact fixed cadence (spec §5a). */
  jitterSeconds: number;
  /** The only warehouse that actually holds sellable stock. An order allocated anywhere else cannot ship until someone moves goods here. */
  pickingWarehouse: string;
  /** The known decoy warehouse, named in the guardrail message so the reason is unambiguous when it fires. */
  decoyWarehouse: string;
  /** Store whose orders are stock RESERVATIONS (ของจอง), not shipments — excluded from every action. */
  reservedStore: string;
  /**
   * Per wave-type thresholds, because picking effort differs
   * ("คู่ 20 ออเดอร์ เดียว 50 ออเดอร์", 2026-09-11): a single-SKU parcel is
   * grab-and-pack so 50 fit in one trip, while a multi-SKU parcel needs
   * picking and sorting per order, so 20 is a full round.
   */
  minParcelsSingleType: number;
  minParcelsMultiType: number;
  /**
   * How long parcels are collected before a short load is waved anyway
   * ("ครึ่งชั่วโมง ค่อยดึงมาสร้างที"). Measured per carrier from its own last
   * wave, and persisted, so one-shot runs batch the same way a daemon does.
   */
  waveIntervalMinutes: number;
}

export const SELLER_DELIVERY_CHANNEL = 'Seller Delivery';

/** "09:30-10:00,14:00-14:30" -> two windows. Unparseable entries are dropped with a warning rather than silently treated as midnight. */
function parseWindows(raw: string | undefined, label: string): TimeWindow[] {
  if (!raw?.trim()) return [];
  const windows: TimeWindow[] = [];
  for (const part of raw.split(',')) {
    const match = part.trim().match(/^(\d{2}:\d{2})\s*-\s*(\d{2}:\d{2})$/);
    if (!match) {
      void logger.warn(`wave-engine config: ignoring unparseable ${label} window "${part.trim()}" (expected HH:MM-HH:MM)`);
      continue;
    }
    windows.push({ start: match[1], end: match[2] });
  }
  return windows;
}

function parseTimeOfDay(raw: string | undefined, label: string): string | null {
  if (!raw?.trim()) return null;
  if (!/^\d{2}:\d{2}$/.test(raw.trim())) {
    void logger.warn(`wave-engine config: ignoring unparseable ${label}="${raw}" (expected HH:MM)`);
    return null;
  }
  return raw.trim();
}

/**
 * Optional JSON file of `{ "Exact BigSeller label": ChannelPolicy }` merged
 * over the defaults — lets ops add a courier or change a truck time without a
 * code change. Entries missing `priority` or `rule` are dropped with a
 * warning rather than half-applied.
 */
function loadChannelOverrides(path: string | undefined): Record<string, ChannelPolicy> {
  if (!path?.trim()) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    const overrides: Record<string, ChannelPolicy> = {};
    for (const [label, value] of Object.entries(parsed)) {
      const policy = value as Partial<ChannelPolicy>;
      const priority = policy.priority;
      const rule = policy.rule;
      const valid = typeof priority === 'number' && Number.isInteger(priority) && priority >= 1 && priority <= 12 && rule;
      if (valid && rule) {
        overrides[label] = { priority: priority as Tier, rule, shareWaveWith: policy.shareWaveWith ?? [] };
      } else {
        void logger.warn(`wave-engine config: channel override "${label}" is missing a valid priority (1-12) or rule — ignored`);
      }
    }
    return overrides;
  } catch (error) {
    void logger.warn(`wave-engine config: could not read WAVE_ENGINE_CHANNEL_MAP_PATH=${path}: ${(error as Error).message}`);
    return {};
  }
}

/**
 * `WAVE_ENGINE_LIVE_PRIORITIES="1,2"` — the only priorities allowed to click
 * for real. Anything absent stays dry-run no matter what else is configured.
 *
 * Named priorities rather than one on/off switch because going live is a
 * per-channel decision with per-channel consequences: approving the 2-hour
 * instant channel says nothing about whether the bot may confirm Shopee Food
 * or the whole standard round. Unset means a full dry run.
 */
function parseLivePriorities(raw: string | undefined): ReadonlySet<Tier> {
  const live = new Set<Tier>();
  for (const part of (raw ?? '').split(',')) {
    const value = Number(part.trim());
    if (part.trim() === '') continue;
    if (Number.isInteger(value) && value >= 1 && value <= 12) {
      live.add(value as Tier);
    } else {
      void logger.warn(`wave-engine config: ignoring unknown priority "${part.trim()}" in WAVE_ENGINE_LIVE_PRIORITIES`);
    }
  }
  return live;
}

export function loadWaveEngineConfig(env: NodeJS.ProcessEnv = process.env): WaveEngineConfig {
  return {
    channelPolicies: { ...DEFAULT_CHANNEL_POLICIES, ...loadChannelOverrides(env.WAVE_ENGINE_CHANNEL_MAP_PATH) },
    endOfDaySweepTime: parseTimeOfDay(env.WAVE_ENGINE_END_OF_DAY_SWEEP, 'END_OF_DAY_SWEEP'),
    forcedTriggerTime: parseTimeOfDay(env.WAVE_ENGINE_FORCED_TRIGGER, 'FORCED_TRIGGER') ?? '15:45',
    livePriorities: parseLivePriorities(env.WAVE_ENGINE_LIVE_PRIORITIES),
    urgentLoopMinutes: Number(env.WAVE_ENGINE_URGENT_LOOP_MINUTES ?? 3),
    mainLoopMinutes: Number(env.WAVE_ENGINE_MAIN_LOOP_MINUTES ?? 12),
    jitterSeconds: Number(env.WAVE_ENGINE_JITTER_SECONDS ?? 25),
    // Same default and env var the rest of the repo already uses for "the real
    // warehouse" (move-export-service.ts, import-moves.ts), so this feature
    // can't drift to a different idea of which warehouse is real.
    pickingWarehouse: env.WAVE_ENGINE_PICKING_WAREHOUSE ?? env.INVENTORY_WAREHOUSE_NAME ?? 'STOCK_5',
    // Name kept identical to decoy-reconciliation-service.ts's DECOY_WAREHOUSE.
    decoyWarehouse: env.WAVE_ENGINE_DECOY_WAREHOUSE ?? 'STOCK_ซิงก์ขายออนไลน์',
    // The store order-demand-service already treats as a special case for the
    // same underlying reason (its orders are reservations priced at THB 0, not
    // real shipments).
    reservedStore: env.WAVE_ENGINE_RESERVED_STORE ?? 'LockStock',
    minParcelsSingleType: Number(env.WAVE_ENGINE_MIN_PARCELS_SINGLE ?? 50),
    minParcelsMultiType: Number(env.WAVE_ENGINE_MIN_PARCELS_MULTI ?? 20),
    waveIntervalMinutes: Number(env.WAVE_ENGINE_WAVE_INTERVAL_MINUTES ?? 30),
  };
}
