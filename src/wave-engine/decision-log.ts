import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { logger } from '../utils/logger.js';
import type { Decision, ScannedOrder } from './tiers.js';

const LOG_DIR = process.env.LOG_DIR ?? './logs';

export type LoopName = 'urgent' | 'main' | 'forced-trigger' | 'eod-sweep' | 'dump';

/**
 * The phase-1 deliverable: one auditable line per order saying which tier it
 * matched, what the bot would (or did) do, and why.
 *
 * Written to its own `logs/wave-engine-YYYY-MM-DD.jsonl` rather than the shared
 * daily log — at ~950 open orders re-scanned every few minutes, per-order lines
 * would bury every other job's output. The shared log still gets a per-cycle
 * summary, and every guardrail hit, so nothing safety-relevant is only in the
 * JSONL.
 *
 * Repeats are suppressed per order for as long as the process lives: a line is
 * written the first time an order is seen and again only when its tier or
 * action CHANGES (e.g. tier 2.5 flipping from `wait` to `confirm_now` at the
 * cutoff). That keeps the file readable for the manual spot-check the phase-1
 * sign-off calls for, instead of thousands of identical `wait` lines.
 */
export class DecisionLog {
  private readonly lastSignature = new Map<string, string>();

  async record(loop: LoopName, order: ScannedOrder, decision: Decision, extra: Record<string, unknown> = {}): Promise<void> {
    const signature = `${String(decision.tier)}|${decision.action}`;
    if (this.lastSignature.get(order.orderId) === signature && Object.keys(extra).length === 0) return;
    this.lastSignature.set(order.orderId, signature);

    await this.append({
      ts: new Date().toISOString(),
      loop,
      orderId: order.orderId,
      orderNo: order.orderNo,
      tier: decision.tier,
      action: decision.action,
      reason: decision.reason,
      channel: order.logisticsChannel,
      // The raw cell travels with every line, not just unclassified ones: the
      // channel match is a substring match, so "which real label produced this
      // tier" is only answerable from the raw text. That is exactly the
      // question when a broad label like "SPX" could be shadowing a specific
      // same-day variant with a different tier.
      shippingCell: order.rawShippingCell.slice(0, 160),
      urgentFlag: order.urgentFlag,
      deliveryDate: order.deliveryDate,
      warehouse: order.warehouse,
      isReserved: order.isReserved,
      ...extra,
    });

    // Guardrails must be visible without opening the JSONL — this is the line
    // the phase-1 definition of done spot-checks for.
    if (decision.action === 'flag_manual') {
      await logger.warn(`wave-engine [${loop}] order ${order.orderNo || order.orderId}: ${decision.reason}`);
    }
  }

  /** For rows the engine acted on — always written, never deduped, since these are real actions taken against BigSeller. */
  async recordAction(loop: LoopName, entry: Record<string, unknown>): Promise<void> {
    await this.append({ ts: new Date().toISOString(), loop, kind: 'action', ...entry });
  }

  private async append(entry: Record<string, unknown>): Promise<void> {
    await mkdir(LOG_DIR, { recursive: true });
    const file = path.join(LOG_DIR, `wave-engine-${new Date().toISOString().slice(0, 10)}.jsonl`);
    await appendFile(file, `${JSON.stringify(entry)}\n`, 'utf8');
  }
}
