import type { Page } from '@playwright/test';
import { BigSellerGenerateWavePage } from '../bigseller/generate-wave-page.js';
import { readFilterPills } from '../bigseller/new-orders-dom.js';
import { assertScanIsComplete, BigSellerOrderPriorityPage, type ScannedOrderRow } from '../bigseller/order-priority-page.js';
import { logger } from '../utils/logger.js';
import { SELLER_DELIVERY_CHANNEL, type WaveEngineConfig } from './config.js';
import { DecisionLog, type LoopName } from './decision-log.js';
import { minParcelsForWaveType, readWaveState, recordWaveCreated, shouldWaveNow } from './wave-state.js';
import {
  bangkokHhMm,
  classifyOrder,
  parseDeliveryDate,
  resolveLogisticsChannel,
  sortByPriority,
  type Decision,
  type ScannedOrder,
} from './tiers.js';

const TIER1_CHANNEL = 'Shopee-TH-Instant Delivery';

/**
 * Tier 1's scope on the สร้าง Wave page, named as a GROUP in that page's
 * โลจิสติกส์ tree.
 *
 * Read live 2026-09-11: the tree groups couriers by shipping speed, and the
 * spec's tier table maps onto those groups one-for-one (`ส่งทันที 2 ชั่วโมง` =
 * tier 1, `จัดส่งภายในวัน` = tier 2, `ส่งด่วน` = tier 3, `ALL Online` = tier 4,
 * `OFFLINE ALL` = Seller Delivery). Scoping by group rather than by courier
 * name is both more accurate and more durable: the courier under this group is
 * actually labelled "Shopee-TH-Instant Delivery - ส่งทันที (แพ็ก 2 ชั่วโมง)",
 * which an exact-name match on the order page's shorter label would miss
 * entirely, and a courier BigSeller later adds to the group is picked up
 * automatically instead of silently falling outside the wave.
 */
const TIER1_WAVE_GROUP = process.env.WAVE_ENGINE_TIER1_WAVE_GROUP ?? 'ส่งทันที 2 ชั่วโมง';

/** Channels the urgent loop narrows to — tier 0 (Seller Delivery) and tier 1 (instant), per spec §5a. */
const URGENT_LOOP_CHANNELS = [SELLER_DELIVERY_CHANNEL, TIER1_CHANNEL];

export interface CycleSummary {
  loop: LoopName;
  scanned: number;
  confirmNow: number;
  waiting: number;
  flaggedManual: number;
  /** Reservations and anything else deliberately not this bot's business — counted apart from flaggedManual, which is real work for a person. */
  skipped: number;
  liveConfirmed: number;
  liveFailed: number;
  wavesCreated: number;
}

interface OrderDecision {
  order: ScannedOrder;
  decision: Decision;
}

/**
 * One cycle of the priority engine: scan → classify → log → (phase 1) act on
 * tier 1 only.
 *
 * Everything except tier 1 is dry-run in this phase — the decision is computed
 * and logged in full, but nothing is clicked. That is deliberate per the phase
 * plan: the dry-run log is compared against what a human operator would have
 * done before any further tier is allowed to act.
 */
export async function runCycle(
  page: Page,
  loop: 'urgent' | 'main',
  config: WaveEngineConfig,
  decisionLog: DecisionLog,
): Promise<CycleSummary> {
  const priorityPage = new BigSellerOrderPriorityPage(page);
  const now = new Date();

  // Collected BEFORE any other filter narrows the list, so the exclusion set is
  // complete rather than "reservations that happen to also match this scan".
  const reservedOrderIds = await priorityPage.collectStoreOrderIds(config.reservedStore).catch(async (error: Error) => {
    // Fail closed: without this set the engine cannot tell a reservation from a
    // real order, and confirming a reservation ships stock a salesperson is
    // holding for a customer. Better to skip the cycle than guess.
    await logger.error(`wave-engine [${loop}]: could not read the "${config.reservedStore}" exclusion list — ${error.message}`);
    throw error;
  });

  const rows = loop === 'urgent' ? await scanUrgentChannels(priorityPage, config) : await scanEverything(priorityPage, config);
  const orders = rows.map((row) => toDomainOrder(row, config, reservedOrderIds));

  const channelPendingCounts = countByChannel(orders);
  const classified: OrderDecision[] = orders.map((order) => ({
    order,
    decision: classifyOrder(order, config, { now, channelPendingCounts }),
  }));

  // The urgent loop's narrowed scan is only authoritative for the tiers it
  // filtered for, plus unclassified rows (a guardrail worth logging wherever it
  // shows up). A tier-2.5 row that slipped in through the unfiltered fallback
  // would otherwise get logged with a pending count of 0 the loop never
  // actually counted — a wrong reading in the audit log is worse than none.
  const decided =
    loop === 'urgent'
      ? classified.filter(({ decision }) => decision.tier === 1 || decision.tier === 2 || decision.tier === null)
      : classified;

  for (const { order, decision } of decided) {
    await decisionLog.record(loop, order, decision);
  }

  const summary: CycleSummary = {
    loop,
    scanned: rows.length,
    confirmNow: decided.filter((d) => d.decision.action === 'confirm_now').length,
    waiting: decided.filter((d) => d.decision.action === 'wait').length,
    flaggedManual: decided.filter((d) => d.decision.action === 'flag_manual').length,
    skipped: decided.filter((d) => d.decision.action === 'skip').length,
    liveConfirmed: 0,
    liveFailed: 0,
    wavesCreated: 0,
  };

  const liveReady = decided.filter(
    (d) => d.decision.action === 'confirm_now' && d.decision.tier !== null && config.livePriorities.has(d.decision.tier),
  );
  const wouldAct = decided.filter((d) => d.decision.action === 'confirm_now');

  const dryRunOnly = wouldAct.length - liveReady.length;
  if (dryRunOnly > 0) {
    await logger.info(
      `wave-engine [${loop}]: ${dryRunOnly} order(s) would be confirmed + waved now, but their priority is not in ` +
        `WAVE_ENGINE_LIVE_PRIORITIES (${[...config.livePriorities].join(',') || 'none'}) — nothing clicked for them`,
    );
  }

  if (liveReady.length > 0) {
    const result = await executeTier1(page, priorityPage, liveReady, decisionLog, loop, config);
    summary.liveConfirmed = result.confirmed;
    summary.liveFailed = result.failed;
    summary.wavesCreated = result.wavesCreated;
  }

  await logger.info(
    `wave-engine [${loop}]: scanned=${summary.scanned} confirm_now=${summary.confirmNow} wait=${summary.waiting} ` +
      `manual=${summary.flaggedManual} skipped=${summary.skipped} live_confirmed=${summary.liveConfirmed} ` +
      `live_failed=${summary.liveFailed} waves=${summary.wavesCreated}`,
  );
  return summary;
}

/**
 * The fast path: read the counts BigSeller already prints, act on the single
 * highest-priority courier that has orders, and touch nothing else.
 *
 * The full cycle takes ~2 minutes (50s counting the reserved store, 80s
 * walking every row), and staff working the same queue confirm the urgent
 * orders inside that window — three live runs in a row on 2026-09-11 found
 * their target already gone or already handled. This does the same job in
 * ~20s: the filter counts replace the scan, and only the chosen courier's
 * handful of rows is ever read.
 *
 * The reserved-store scan — the single most expensive step — is skipped
 * entirely when the store filter reports zero reservations inside the chosen
 * courier's scope, which is the normal case since reservations are Seller
 * Delivery. It still runs, in full, the moment that count is non-zero.
 */
export async function runFastCycle(
  page: Page,
  config: WaveEngineConfig,
  decisionLog: DecisionLog,
): Promise<CycleSummary> {
  const loop: LoopName = 'urgent';
  const priorityPage = new BigSellerOrderPriorityPage(page);
  const summary: CycleSummary = {
    loop,
    scanned: 0,
    confirmNow: 0,
    waiting: 0,
    flaggedManual: 0,
    skipped: 0,
    liveConfirmed: 0,
    liveFailed: 0,
    wavesCreated: 0,
  };

  await priorityPage.goto();
  const pills = await readFilterPills(page, 'โลจิสติกส์');
  const target = pills
    .filter((pill) => (pill.count ?? 0) > 0)
    .map((pill) => ({ pill, priority: config.channelPolicies[resolveLogisticsChannel(pill.label, config)]?.priority }))
    .filter((entry) => entry.priority !== undefined && config.livePriorities.has(entry.priority))
    .sort((a, b) => (a.priority as number) - (b.priority as number))[0];

  if (!target) {
    await logger.info(
      `wave-engine [${loop}]: nothing waiting in the live priorities (${[...config.livePriorities].join(',') || 'none'}) — ` +
        `queue right now: ${pills.filter((p) => (p.count ?? 0) > 0).map((p) => `${p.label}=${p.count}`).join(', ') || 'empty'}`,
    );
    return summary;
  }

  await logger.info(
    `wave-engine [${loop}]: acting on priority ${target.priority} — "${target.pill.label}" (${target.pill.count} order(s) waiting)`,
  );

  await priorityPage.selectWarehouses([config.pickingWarehouse]);
  await priorityPage.selectLogisticsFilter(target.pill.label);

  // The exclusion list is always collected in full.
  //
  // An earlier version tried to skip this when the ร้านค้า row showed zero
  // reservations "in scope", but those pill counts are NOT narrowed by the
  // other filter rows: with the logistics filter on a courier holding 3
  // orders, the LockStock pill still read 60. The number was the whole
  // queue's, so the check could never have been a safe basis for skipping
  // the scan — and its log line wrongly implied 60 reservations sat inside a
  // 3-order scope. Reservations are never confirmed on a guess.
  const reservedOrderIds = await priorityPage.collectStoreOrderIds(config.reservedStore);
  await priorityPage.selectLogisticsFilter(target.pill.label);

  const rows = await priorityPage.scanOrders({ depth: 'light', warehouseScope: config.pickingWarehouse });
  const now = new Date();
  const scopedOrders = rows.map((row) => toDomainOrder(row, config, reservedOrderIds));
  // The batch-of-N morning rule counts orders waiting in that channel. This
  // scan is already filtered to one courier, so its own rows ARE that count.
  const channelPendingCounts = countByChannel(scopedOrders);
  const classified = scopedOrders.map((order) => ({
    order,
    decision: classifyOrder(order, config, { now, channelPendingCounts }),
  }));

  for (const { order, decision } of classified) {
    await decisionLog.record(loop, order, decision);
  }

  summary.scanned = rows.length;
  summary.confirmNow = classified.filter((d) => d.decision.action === 'confirm_now').length;
  summary.waiting = classified.filter((d) => d.decision.action === 'wait').length;
  summary.flaggedManual = classified.filter((d) => d.decision.action === 'flag_manual').length;
  summary.skipped = classified.filter((d) => d.decision.action === 'skip').length;

  const liveReady = classified.filter(
    (d) => d.decision.action === 'confirm_now' && d.decision.tier !== null && config.livePriorities.has(d.decision.tier),
  );
  if (liveReady.length > 0) {
    const result = await executeTier1(page, priorityPage, liveReady, decisionLog, loop, config);
    summary.liveConfirmed = result.confirmed;
    summary.liveFailed = result.failed;
    summary.wavesCreated = result.wavesCreated;
  }

  await logger.info(
    `wave-engine [${loop}]: scanned=${summary.scanned} confirm_now=${summary.confirmNow} wait=${summary.waiting} ` +
      `manual=${summary.flaggedManual} skipped=${summary.skipped} live_confirmed=${summary.liveConfirmed} ` +
      `live_failed=${summary.liveFailed} waves=${summary.wavesCreated}`,
  );
  return summary;
}

/**
 * Urgent loop scan (spec §5a): narrow to the tier-0/1 channels with the
 * "โลจิสติกส์" filter and read only the top of the list, so this can run every
 * 2-3 minutes without walking the whole ~950-row queue.
 *
 * Falls back to an unfiltered light scan when a channel's filter pill isn't
 * found — with a warning, because that fallback sees only the first page and
 * could therefore MISS an urgent order rather than just being slower. Whether
 * these exact pill labels exist in the โลจิสติกส์ row is unconfirmed.
 */
async function scanUrgentChannels(
  priorityPage: BigSellerOrderPriorityPage,
  config: WaveEngineConfig,
): Promise<ScannedOrderRow[]> {
  const byOrderId = new Map<string, ScannedOrderRow>();

  // This is the loop that can actually confirm orders live, so it scans ONLY
  // the picking warehouse: that both restricts it to orders whose stock really
  // exists, and makes the warehouse stamp below trustworthy enough for the
  // STOCK_5 guardrail to mean something. Urgent orders parked in another
  // warehouse are not confirmable at all — the main loop reports those for a
  // human to move. Throws if the filter can't be verified, which fails the
  // cycle rather than scanning an unknown scope.
  await priorityPage.selectWarehouses([config.pickingWarehouse]);

  for (const channel of URGENT_LOOP_CHANNELS) {
    try {
      await priorityPage.selectLogisticsFilter(channel);
    } catch (error) {
      await logger.warn(
        `wave-engine [urgent]: could not apply the "${channel}" logistics filter (${(error as Error).message}) — ` +
          'falling back to an unfiltered first-page scan, which may miss urgent orders further down the queue',
      );
    }
    for (const row of await priorityPage.scanOrders({ depth: 'light', warehouseScope: config.pickingWarehouse })) {
      byOrderId.set(row.orderId, row);
    }
  }

  await priorityPage.selectLogisticsFilter('ทั้งหมด').catch(() => undefined);
  return [...byOrderId.values()];
}

/**
 * Main loop scan, split by warehouse so every row carries a TRUSTWORTHY
 * warehouse stamp (the row itself never says which of our warehouses holds the
 * stock — see toScannedOrder).
 *
 * Only `pickingWarehouse` (STOCK_5) holds sellable stock, so:
 *  - the picking warehouse is scanned in full — these are the only orders that
 *    can actually be confirmed;
 *  - every OTHER warehouse with a non-zero count gets its own light scan, so
 *    those orders are reported with the real warehouse name and land on the
 *    "someone must move stock" list instead of being silently absent.
 *
 * The per-warehouse counts come from the filter itself, so a normal day (all
 * stock in STOCK_5) costs exactly one extra read and no extra scans.
 */
async function scanEverything(
  priorityPage: BigSellerOrderPriorityPage,
  config: WaveEngineConfig,
): Promise<ScannedOrderRow[]> {
  await priorityPage.selectLogisticsFilter('ทั้งหมด').catch(() => undefined);

  const options = await priorityPage.readWarehouseOptions();
  const misplaced = options.filter((option) => option.name !== config.pickingWarehouse && option.count > 0);
  if (misplaced.length > 0) {
    await logger.warn(
      `wave-engine: ${misplaced.reduce((sum, option) => sum + option.count, 0)} order(s) sit outside ${config.pickingWarehouse} — ` +
        `${misplaced.map((option) => `${option.name}=${option.count}`).join(', ')}. Stock must be moved by a human; the bot will not confirm these.`,
    );
  }

  await priorityPage.selectWarehouses([config.pickingWarehouse]);
  const countBefore = options.find((option) => option.name === config.pickingWarehouse)?.count;
  const rows = await priorityPage.scanOrders({ depth: 'full', warehouseScope: config.pickingWarehouse });

  // Checked against the SMALLER of the counts either side of the scan.
  //
  // Staff work this same queue by hand, so rows legitimately disappear
  // mid-scan — 146 collected against a pre-scan count of 160 aborted a cycle
  // on 2026-09-11 for no better reason than fourteen orders being confirmed
  // by a person while the bot read the page. Comparing against the post-scan
  // count absorbs that, while still catching the failure this guard exists
  // for: a structurally broken scan (81 rows against 1,619) leaves the count
  // high at both ends.
  const countAfter = (await priorityPage.readWarehouseOptions()).find(
    (option) => option.name === config.pickingWarehouse,
  )?.count;
  const expected = [countBefore, countAfter].filter((count): count is number => count !== undefined);
  assertScanIsComplete(rows.length, expected.length > 0 ? Math.min(...expected) : undefined);

  for (const option of misplaced) {
    await priorityPage.selectWarehouses([option.name]);
    rows.push(
      ...(await priorityPage.scanOrders({ depth: 'full', warehouseScope: option.name, expectedCount: option.count })),
    );
  }

  // Deduped again across the per-warehouse scans: an order can move warehouse
  // between two of them, and one duplicate in this list is one order confirmed
  // twice (the 2026-09-11 06:07 cycle did exactly that).
  const unique = new Map<string, ScannedOrderRow>();
  for (const row of rows) {
    if (!unique.has(row.orderId)) unique.set(row.orderId, row);
  }
  if (unique.size !== rows.length) {
    await logger.info(`wave-engine: dropped ${rows.length - unique.size} duplicate row(s) across warehouse scans`);
  }
  rows.length = 0;
  rows.push(...unique.values());

  await priorityPage.selectWarehouses('all');
  return rows;
}

/**
 * Has this channel's trigger time passed, i.e. is it time to send whatever is
 * on hand rather than wait for a fuller wave?
 *
 * The 2-hour instant channel is the one that never waits: its SLA is measured
 * in hours, so holding its parcels back for a bigger round is exactly the
 * failure it exists to avoid.
 */
function isPastTrigger(rule: WaveEngineConfig['channelPolicies'][string]['rule'], nowHhMm: string): boolean {
  if (rule.kind === 'instant') return true;
  if (rule.kind === 'batch_then_immediate') return nowHhMm >= rule.immediateFrom;
  return nowHhMm >= rule.cutoff;
}

/** Waiting-order count per resolved channel — the input the morning batch rule needs. */
function countByChannel(orders: ScannedOrder[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const order of orders) {
    if (!order.logisticsChannel || order.isReserved) continue;
    counts[order.logisticsChannel] = (counts[order.logisticsChannel] ?? 0) + 1;
  }
  return counts;
}

export function toDomainOrder(
  row: ScannedOrderRow,
  config: WaveEngineConfig,
  reservedOrderIds: ReadonlySet<string> = new Set(),
): ScannedOrder {
  return {
    orderId: row.orderId,
    orderNo: row.orderNo,
    logisticsChannel: resolveLogisticsChannel(row.rawShippingCell, config),
    rawShippingCell: row.rawShippingCell,
    urgentFlag: row.urgentFlag,
    deliveryDate: parseDeliveryDate(row.deliveryDateRaw),
    warehouse: row.warehouse,
    isReserved: reservedOrderIds.has(row.orderId),
  };
}

/**
 * Confirms tier-1 orders and creates their Wave (spec §2: instant delivery is
 * confirmed immediately and waved alone, never batched).
 *
 * Reloads the list first, then re-reads each order's own row immediately before
 * clicking it — the idempotency guard from spec §7. A poll cycle can overlap a
 * human doing the same work by hand, and confirming an order twice is not
 * something this bot gets to do.
 */
async function executeTier1(
  page: Page,
  priorityPage: BigSellerOrderPriorityPage,
  tier1Ready: OrderDecision[],
  decisionLog: DecisionLog,
  loop: LoopName,
  config: WaveEngineConfig,
): Promise<{ confirmed: number; failed: number; wavesCreated: number }> {
  // Reload for fresh status, but keep the warehouse filter and page size the
  // scan ran under — a bare reload leaves a different list on screen, and the
  // row lookup below then reports a confirmable order as gone.
  await priorityPage.refreshKeepingScope(config.pickingWarehouse);

  let confirmed = 0;
  let failed = 0;
  // Which couriers actually got an order confirmed — that, not a fixed group,
  // is what decides which waves to build.
  const confirmedChannels = new Set<string>();

  // A trial run confirms a couple of orders, not the whole queue. The first
  // live outing of any click that writes to BigSeller should be small enough
  // that a person can eyeball the result before it happens 14 more times.
  // Unlimited unless set.
  const maxConfirms = Number(process.env.WAVE_ENGINE_MAX_LIVE_CONFIRMS ?? Number.POSITIVE_INFINITY);
  const queue = sortByPriority(tier1Ready);
  if (queue.length > maxConfirms) {
    await logger.warn(
      `wave-engine [${loop}]: WAVE_ENGINE_MAX_LIVE_CONFIRMS=${maxConfirms} — confirming the ${maxConfirms} most urgent ` +
        `of ${queue.length} live-eligible order(s) [${[...new Set(queue.map((entry) => `p${String(entry.decision.tier)}`))].join(',')}]; ` +
        'the rest stay untouched this cycle',
    );
  }

  const attempted = new Set<string>();

  for (const { order } of queue.slice(0, maxConfirms)) {
    // Final defence against a duplicate reaching this loop at all. The scan
    // dedupes by order id now, but this is the click that cannot be taken
    // back, so it does not rely on that.
    if (attempted.has(order.orderId)) {
      await logger.warn(
        `wave-engine [${loop}] order ${order.orderNo || order.orderId}: already attempted in this cycle — not clicking again`,
      );
      continue;
    }
    attempted.add(order.orderId);

    // Last line of defence, immediately before the only click that writes to
    // BigSeller. A reservation must never be confirmed ("ของจอง ห้ามแตะ
    // เด็ดขาด ทุกครั้ง", 2026-09-11) — it is stock a salesperson is holding for
    // a named customer, and confirming it ships their goods to someone else.
    // classifyOrder already returns `skip` for these, so reaching here means a
    // bug upstream; refuse the click rather than trust that it cannot happen.
    if (order.isReserved) {
      await logger.error(
        `wave-engine [${loop}] order ${order.orderNo || order.orderId}: BLOCKED_RESERVED_AT_CLICK — a reserved order ` +
          'reached the confirm step. Nothing was clicked. This is an upstream bug in the classification, please report it.',
      );
      failed++;
      continue;
    }

    const state = await priorityPage.readOrderState(order.orderId);
    if (!state.present || !state.hasConfirmControl) {
      await logger.warn(
        `wave-engine [${loop}] order ${order.orderNo || order.orderId}: GUARD_STATUS_CHANGED: no longer confirmable ` +
          `(present=${state.present} confirmControl=${state.hasConfirmControl} status="${state.statusText}") — skipped`,
      );
      await decisionLog.recordAction(loop, {
        orderId: order.orderId,
        orderNo: order.orderNo,
        tier: 1,
        outcome: 'skipped',
        reason: 'GUARD_STATUS_CHANGED: order left status=new between scan and confirm',
        statusText: state.statusText,
      });
      continue;
    }

    const result = await priorityPage.confirmOrder(order.orderId);
    if (result.confirmed) {
      confirmed++;
      confirmedChannels.add(order.logisticsChannel);
    } else {
      failed++;
    }

    await decisionLog.recordAction(loop, {
      orderId: order.orderId,
      orderNo: order.orderNo,
      tier: 1,
      outcome: result.confirmed ? 'confirmed' : 'confirm_unverified',
      reason: result.note,
      warehouse: order.warehouse,
    });
    await logger[result.confirmed ? 'info' : 'error'](
      `wave-engine [${loop}] order ${order.orderNo || order.orderId}: confirm ${result.confirmed ? 'OK' : 'UNVERIFIED'} — ${result.note}`,
    );
  }

  let wavesCreated = 0;
  if (confirmed > 0) {
    const wavePage = new BigSellerGenerateWavePage(page);
    await wavePage.goto();
    // Wave the couriers whose orders were just confirmed.
    //
    // This used to wave a single hardcoded group (the 2-hour channel) no
    // matter what had been confirmed, which meant confirming e.g. Lazada LEX
    // orders produced no wave at all — they would have sat confirmed and
    // unpicked. Pinned to the picking warehouse too, so a wave can never be
    // built for stock that isn't there, and still strictly one carrier per
    // wave (spec hard rule).
    //
    // The wave page's tree labels a courier slightly differently from the
    // order list (the instant channel gains a "- ส่งทันที (แพ็ก 2 ชั่วโมง)"
    // suffix), so leaves are matched by containment either way round.
    const tree = await wavePage.readLogisticsTree();
    const carriers = tree.filter(
      (node) =>
        !node.isGroup &&
        [...confirmedChannels].some((channel) => node.title.includes(channel) || channel.includes(node.title)),
    );
    if (carriers.length === 0) {
      await logger.error(
        `wave-engine [${loop}]: confirmed [${[...confirmedChannels].join(', ')}] but none of them appear in the wave ` +
          `page's courier tree (${tree.filter((n) => !n.isGroup).map((n) => n.title).join(', ') || 'empty'}) — nothing waved.`,
      );
    }

    const now = new Date();
    const waveState = await readWaveState();

    for (const carrier of carriers) {
      // The wave page has no reserved-store exclusion of its own — its ร้านค้า
      // filter stays "ทั้งหมด" — so the only thing keeping a reservation out
      // of a wave is never waving the carrier they live under. Reservations
      // are Seller Delivery orders (60 of the 67 Seller Delivery rows in the
      // queue on 2026-09-11), and a wave is built from whatever is confirmed,
      // no matter who confirmed it. One mis-click by a person would otherwise
      // be enough to put held stock into a picking list.
      if (carrier.title.includes(SELLER_DELIVERY_CHANNEL)) {
        await logger.warn(
          `wave-engine [${loop}]: refusing to wave "${carrier.title}" — reserved orders (${config.reservedStore}) ` +
            'live under this carrier and must never end up in a wave. Seller Delivery is waved by a human.',
        );
        continue;
      }

      // Go now on a full load, otherwise collect for the batching window and
      // send it in one trip — never a wave per trickled-in order.
      const pending = await wavePage.parcelsWaitingFor(
        { title: carrier.title, group: carrier.group },
        config.pickingWarehouse,
      );
      const lastWaveAt = waveState.lastWaveAt[carrier.title];
      const windowElapsed =
        lastWaveAt !== undefined &&
        (now.getTime() - new Date(lastWaveAt).getTime()) / 60000 >= config.waveIntervalMinutes;
      const verdict = shouldWaveNow({
        parcels: pending,
        minParcels: config.minParcelsMultiType,
        intervalMinutes: config.waveIntervalMinutes,
        lastWaveAt,
        now,
      });
      if (!verdict.wave) {
        await logger.info(`wave-engine [${loop}]: holding "${carrier.title}" — ${verdict.reason}`);
        continue;
      }
      await logger.info(`wave-engine [${loop}]: waving "${carrier.title}" — ${verdict.reason}`);

      const wave = await wavePage.createWave(
        { title: carrier.title, group: carrier.group },
        {
          shippingWarehouse: config.pickingWarehouse,
          // Per-row, per-type: a single-SKU row needs many more parcels than a
          // multi-SKU one before a trip up the floor is worth it. Once the
          // batching window has elapsed the whole point is to send what is
          // there, so the per-row threshold steps aside.
          minParcelsFor: windowElapsed
            ? undefined
            : (row) =>
                minParcelsForWaveType(row.waveType, {
                  single: config.minParcelsSingleType,
                  multi: config.minParcelsMultiType,
                }).min,
        },
      );

      for (const row of wave.rows) {
        await decisionLog.recordAction(loop, {
          tier: 1,
          carrier: carrier.title,
          outcome: wave.created ? 'wave_row_created' : 'wave_row_previewed',
          zone: row.zone,
          crossZone: row.crossZone,
          parcelCount: row.parcelCount,
          skuTypeCount: row.skuTypeCount,
          itemCount: row.itemCount,
        });
        await logger.info(
          `wave-engine [${loop}] wave row: carrier="${carrier.title}" zone="${row.zone}" ` +
            `parcels=${row.parcelCount} skuTypes=${row.skuTypeCount} items=${row.itemCount}`,
        );
      }

      if (wave.created) {
        wavesCreated++;
        await recordWaveCreated(carrier.title, now);
        await logger.info(`wave-engine [${loop}]: created wave for "${carrier.title}" — ${wave.note}`);
      } else {
        // Holding a short load back is the rule working, not a failure — only
        // a genuine problem is logged as an error, so the log stays readable.
        const holding = wave.note.includes('too small') || wave.note.includes('big enough') || wave.note.includes('0 parcels');
        await logger[holding ? 'info' : 'error'](
          `wave-engine [${loop}]: no wave for "${carrier.title}" — ${wave.note}`,
        );
      }
    }

    // Hand the page back neutral.
    //
    // The engine narrows the โลจิสติกส์ tree to one carrier to do its work. Left
    // that way (seen 2026-09-11: the page sitting on "ส่งทันที 2 ชั่วโมง" alone,
    // showing 1 parcel), the next person to open it sees a scope they did not
    // set and a "สร้าง" button that would build a wave out of it. Restoring the
    // root re-checks everything, which is how a human expects to find it.
    await wavePage
      .setLogisticsScope([{ title: 'โลจิสติกส์ทั้งหมด' }])
      .catch(async (error: Error) =>
        logger.warn(`wave-engine [${loop}]: could not restore the wave page's courier tree — ${error.message}`),
      );

    await priorityPage.goto();
  }

  return { confirmed, failed, wavesCreated };
}
