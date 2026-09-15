import 'dotenv/config';
import type { Page } from '@playwright/test';
import { assertStorageStateExists, checkIsLoggedIn, ensureSessionValid, getStorageStatePath } from '../src/bigseller/auth.js';
import { BigSellerGenerateWavePage, GENERATE_WAVE_URL } from '../src/bigseller/generate-wave-page.js';
import { NEW_ORDERS_URL, readFilterPills } from '../src/bigseller/new-orders-dom.js';
import { BigSellerOrderPriorityPage } from '../src/bigseller/order-priority-page.js';
import { launchBigSellerBrowser } from '../src/utils/browser-runner.js';
import { logger } from '../src/utils/logger.js';
import { loadWaveEngineConfig, SELLER_DELIVERY_CHANNEL } from '../src/wave-engine/config.js';
import { PLATFORM_CUTOFF } from '../src/wave-engine/channel-policy.js';
import { DecisionLog } from '../src/wave-engine/decision-log.js';
import { startScheduler } from '../src/wave-engine/scheduler.js';
import { runCycle, runFastCycle, toDomainOrder } from '../src/wave-engine/wave-engine-service.js';
import { minParcelsForWaveType } from '../src/wave-engine/wave-state.js';
import { bangkokHhMm, classifyOrder, resolveLogisticsChannel } from '../src/wave-engine/tiers.js';
import { floorsForOrder, loadSkuFloors } from '../src/wave-engine/sku-floor.js';
import { acquireRunLock } from '../src/wave-engine/run-lock.js';

/**
 * BigSeller-WaveEngine phase 1 (see BigSeller-WaveEngine/TASK-BigSeller-WaveEngine-phase1.md).
 *
 * Modes:
 *   npm run wave-engine              — daemon: urgent + main loops until Ctrl+C
 *   npm run wave-engine -- --once    — one main-loop cycle, then exit
 *   npm run wave-engine -- --dump    — print raw order rows and their parsed
 *                                      fields, then exit (no decisions, no clicks)
 *
 * Holds ONE browser context for its whole life, launched through
 * `launchBigSellerBrowser` — the same fingerprint/locale/stealth setup every
 * other script here uses, which is what the session fix depends on. It does
 * NOT re-save storageState: `npm run keep-alive` (scripts/session-keeper.ts)
 * owns that file, and two processes writing the same session snapshot is a
 * corruption risk. Run keep-alive alongside this.
 *
 * Never re-logs in. A dead session stops the daemon and asks for a human, same
 * policy as every other job in this repo.
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const once = args.includes('--once');
  const dump = args.includes('--dump');
  const waveDryRun = args.includes('--wave-dry-run');
  const board = args.includes('--board');
  const fast = args.includes('--fast');
  const zones = args.includes('--zones');
  const bulk = args.includes('--bulk');
  const bulkLoop = args.includes('--bulk-loop');
  const expiring = args.includes('--expiring');
  const dumpLimit = Number(args.find((arg) => /^\d+$/.test(arg)) ?? 5);

  const config = loadWaveEngineConfig();
  assertStorageStateExists();

  const mode = bulkLoop ? 'bulk-loop' : expiring ? 'expiring' : bulk ? 'bulk' : zones ? 'zones' : board ? 'board' : waveDryRun ? 'wave-dry-run' : dump ? 'dump' : fast ? 'fast' : once ? 'once' : 'daemon';
  await logger.info(
    `wave-engine: starting (mode=${mode}) ` +
      `live_priorities=${[...config.livePriorities].join(',') || 'none (full dry run)'} urgent=${config.urgentLoopMinutes}min main=${config.mainLoopMinutes}min ` +
      `jitter=±${config.jitterSeconds}s channels=${Object.keys(config.channelPolicies).length} ` +
      `eod=${config.endOfDaySweepTime ?? 'unset'}`,
  );
  if (config.livePriorities.size > 0) {
    await logger.warn(
      `wave-engine: WAVE_ENGINE_LIVE_PRIORITIES=${[...config.livePriorities].join(',')} — orders in ` +
        'those priorities WILL be confirmed and waved for real. Every other priority stays dry-run.',
    );
  } else {
    await logger.info('wave-engine: full dry run — every decision is logged, nothing is clicked');
  }

  // Read-only modes are safe to run beside a working engine; anything that can
  // click is not.
  const readOnly = board || waveDryRun || dump || zones || expiring;
  const releaseLock = readOnly ? () => undefined : await acquireRunLock(mode);

  const headless = (process.env.BIGSELLER_HEADLESS ?? 'false').toLowerCase() === 'true';
  // Runs unattended for hours, so Chrome's own permission bubble ("wants to
  // access other apps and services on this device") would just sit there every
  // launch with nobody to click it away. The engine never prints, so denying
  // costs it nothing — other jobs in this repo keep the default.
  const { browser, context } = await launchBigSellerBrowser({
    headless,
    storageState: getStorageStatePath(),
    denyPermissionPrompts: true,
  });
  const page = await context.newPage();

  try {
    if (board) {
      await printPriorityBoard(page, config);
      return;
    }

    if (waveDryRun) {
      await inspectWavePage(page, config);
      return;
    }

    if (zones) {
      await printZonePlan(page, config);
      return;
    }

    if (bulk) {
      await runBulkRound(page, config);
      return;
    }

    if (bulkLoop) {
      await runBulkLoop(page, config);
      return;
    }

    if (expiring) {
      await printExpiringSoon(page, config);
      return;
    }

    await ensureSessionValid(page, NEW_ORDERS_URL);
    const priorityPage = new BigSellerOrderPriorityPage(page);
    await priorityPage.goto();

    if (dump) {
      await dumpRawRows(priorityPage, config, dumpLimit);
      return;
    }

    const decisionLog = new DecisionLog();

    if (fast) {
      await runFastCycle(page, config, decisionLog);
      return;
    }

    if (once) {
      await runCycle(page, 'main', config, decisionLog);
      return;
    }

    await runDaemon(page, config, decisionLog);
  } finally {
    await context.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
    releaseLock();
  }
}

/**
 * Prints raw rows next to what the scanner made of them — the honest way to
 * close spec §8's first open question (where กำหนดส่ง actually lives) and to
 * confirm the urgent-flag and warehouse-code signals, before any tier is
 * trusted to act on them.
 */
/**
 * `--wave-dry-run`: reads the สร้าง Wave page and reports what is waveable
 * right now. Strictly read-only — it does not touch a filter, and above all it
 * never clicks "สร้าง", which would put a real picking task in front of
 * warehouse staff.
 *
 * This is the dry run for step 2 of the flow (order confirmation being step 1),
 * and the only way to check the โลจิสติกส์ tree without creating anything. The
 * tree lists only couriers that currently have waveable orders, so its contents
 * change with the queue.
 */
/**
 * `--board`: what is waiting right now, in priority order, read straight from
 * the filter counts BigSeller already prints.
 *
 * Two seconds instead of the ~2 minutes a row scan takes, because the page has
 * done the counting itself. It answers the only question that matters at the
 * start of a round — which courier to confirm first — and it touches nothing.
 */
/**
 * `--bulk`: one courier, the way the warehouse actually works it.
 *
 * Narrow the platform filter, narrow the logistics filter to a single courier,
 * check the count has reached the target, press the page's own ยืนยัน button
 * once, then build that courier's wave (instructed 2026-09-12: "กรอง
 * แพลตฟอร์ม โลจิสติกส์ ครบจำนวนตามที่งานที่ตั้งไว้", then "เลือกออเดอร์ยืนยัน
 * ไปสร้าง wave").
 *
 * This replaces confirming row by row, which was slower than a person and, on
 * the two orders it was tried on live, did not land at all.
 *
 * Narrowing to one courier is also what keeps reservations out: LockStock
 * orders are Seller Delivery, so any other courier's filter excludes them by
 * construction rather than by the bot remembering to.
 */
/**
 * `--bulk-loop`: repeats `--bulk` on a timer instead of a daemon that scans
 * every excluded order by name.
 *
 * Requested 2026-09-15 ("ให้กรองที่วงให้ไม่ต้องเสียเวลาสแกนทั้งหมด แค่ดู
 * คอลัมน์ที่วงให้") — the plain daemon (`npm run wave-engine`, no flag) has
 * to enumerate every LockStock and blocked-platform ORDER ID because it
 * confirms one row at a time, so it cannot skip that full scan. `--bulk`
 * clicks BigSeller's own ยืนยัน button once per courier, so it only ever
 * needs a COUNT to know a reservation or a blocked platform is inside the
 * current filter — the same badges a person glances at, never a row scan.
 * That is what makes it fast enough to repeat every few minutes instead of
 * running as a long-lived process.
 *
 * Same lock as every other live mode, held for the loop's whole life — one
 * courier is confirmed per tick (runBulkRound's own one-per-round rule), then
 * it waits out the interval and looks again with a fresh scan.
 */
async function runBulkLoop(page: Page, config: ReturnType<typeof loadWaveEngineConfig>): Promise<void> {
  const minutes = Number(process.env.WAVE_ENGINE_BULK_LOOP_MINUTES ?? 4);
  let stopping = false;
  await logger.info(`wave-engine [bulk-loop]: repeating --bulk every ~${minutes} min. Press Ctrl+C to stop.`);

  const stop = () => {
    stopping = true;
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  while (!stopping) {
    if (!(await checkIsLoggedIn(page))) {
      await logger.error(
        'wave-engine [bulk-loop]: session expired — stopping. A human must run "npm run login:bigseller" (and keep "npm run keep-alive" running), then restart this.',
      );
      break;
    }
    try {
      await runBulkRound(page, config);
    } catch (error) {
      await logger.error(`wave-engine [bulk-loop]: round failed: ${(error as Error).message}`);
    }
    // ±25s jitter, same reasoning as the daemon's own loops: never fire on an
    // exact fixed cadence against BigSeller.
    const jitterMs = (Math.random() * 2 - 1) * 25_000;
    const delayMs = Math.max(30_000, minutes * 60_000 + jitterMs);
    await logger.info(`wave-engine [bulk-loop]: next round in ${Math.round(delayMs / 1000)}s`);
    for (let waited = 0; waited < delayMs && !stopping; waited += 1000) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(1000, delayMs - waited)));
    }
  }
  await logger.info('wave-engine [bulk-loop]: stopped');
}

async function runBulkRound(page: Page, config: ReturnType<typeof loadWaveEngineConfig>): Promise<void> {
  await ensureSessionValid(page, NEW_ORDERS_URL);
  const priorityPage = new BigSellerOrderPriorityPage(page);
  await priorityPage.goto();

  const now = new Date();
  const nowHhMm = bangkokHhMm(now);
  const logistics = await readFilterPills(page, 'โลจิสติกส์');

  // Rank what is waiting, best first, and keep only couriers whose own timing
  // rule says they may go now.
  const candidates = logistics
    .filter((pill) => pill.label !== 'ทั้งหมด' && (pill.count ?? 0) > 0)
    .map((pill) => {
      const channel = resolveLogisticsChannel(pill.label, config);
      return { pill, channel, policy: config.channelPolicies[channel] };
    })
    .filter((entry) => entry.policy !== undefined)
    .sort((a, b) => a.policy!.priority - b.policy!.priority);

  const lines: string[] = ['', `=== รอบยืนยันรวม (${nowHhMm}) ===`];
  let acted = false;

  // Every line here also goes through logger.info, on top of the console
  // table below — the console output only ever reaches whoever's terminal
  // ran the command, and on 2026-09-15 that left a bulk round's own decisions
  // (which courier it looked at, why it skipped one) completely invisible in
  // logs/, with nothing to check afterwards beyond "did it crash or not".
  const note = (text: string) => {
    lines.push(text);
    void logger.info(`wave-engine [bulk]: ${text.trim()}`);
  };

  for (const { pill, channel, policy } of candidates) {
    const count = pill.count ?? 0;
    const live = config.livePriorities.has(policy!.priority);
    const target = config.minParcelsMultiType;

    if (count < target) {
      note(`  ลำดับ ${policy!.priority}  ${pill.label}: ${count} ใบ — ยังไม่ถึงเป้า ${target} ใบ ข้ามไปก่อน`);
      continue;
    }
    if (!live) {
      note(
        `  ลำดับ ${policy!.priority}  ${pill.label}: ${count} ใบ ครบเป้าแล้ว — แต่ลำดับนี้ยังไม่ได้เปิดโหมดทำงานจริง ไม่กด`,
      );
      continue;
    }

    note(`  ลำดับ ${policy!.priority}  ${pill.label}: ${count} ใบ ครบเป้า — ยืนยันรวมแล้วสร้าง Wave`);
    await priorityPage.selectLogisticsFilter(pill.label);
    const result = await priorityPage.bulkConfirmFiltered({
      expectedCourier: pill.label,
      allowedPlatforms: config.allowedPlatforms,
      reservedStore: config.reservedStore,
      maxOrders: Number(process.env.WAVE_ENGINE_MAX_LIVE_CONFIRMS ?? count),
    });
    note(`           ยืนยัน ${result.confirmed} ใบ — ${result.note}`);

    if (result.confirmed > 0) {
      const wavePage = new BigSellerGenerateWavePage(page);
      await wavePage.goto();
      const tree = await wavePage.readLogisticsTree();
      const carrier = tree.find((node) => !node.isGroup && resolveLogisticsChannel(node.title, config) === channel);
      if (!carrier) {
        note('           หาขนส่งเจ้านี้ในหน้าสร้าง Wave ไม่เจอ — ยังไม่ได้สร้าง Wave');
      } else {
        const wave = await wavePage.createWave(
          { title: carrier.title, group: carrier.group },
          {
            shippingWarehouse: config.pickingWarehouse,
            minParcelsFor: (row) =>
              minParcelsForWaveType(row.waveType, {
                single: config.minParcelsSingleType,
                multi: config.minParcelsMultiType,
              }).min,
          },
        );
        note(`           Wave: ${wave.created ? 'สร้างแล้ว' : 'ไม่ได้สร้าง'} — ${wave.note}`);
        for (const row of wave.rows) {
          note(`             โซน ${row.zone} · ${row.parcelCount} พัสดุ · ${row.itemCount} ชิ้น`);
        }
      }
      await wavePage
        .setLogisticsScope([{ title: 'โลจิสติกส์ทั้งหมด' }])
        .catch((error: Error) => logger.warn(`wave-engine [bulk]: could not restore the wave page tree — ${error.message}`));
      await priorityPage.goto();
    }

    acted = true;
    // One courier per round. The queue and the counters both move underneath a
    // bulk confirm, so the next courier is decided by a fresh look, not by a
    // list read before any of this happened.
    break;
  }

  if (!acted) note('  (ยังไม่มีขนส่งเจ้าไหนที่ครบเป้าและเปิดโหมดทำงานจริงไว้)');
  lines.push('');
  console.log(lines.join('\n'));
  await priorityPage.resetAllFilters();
}

/** Which truck a platform's parcels leave on. Platform names come from the filter row itself. */
function platformCutoffOf(platformLabel: string): string | undefined {
  const label = platformLabel.toLowerCase();
  if (label.includes('shopee')) return PLATFORM_CUTOFF.shopee;
  if (label.includes('lazada')) return PLATFORM_CUTOFF.lazada;
  if (label.includes('tiktok')) return PLATFORM_CUTOFF.tiktok;
  return undefined;
}

/**
 * `--zones`: which FLOOR this morning's queue has to be picked from.
 *
 * Read-only. The order list never shows a zone — that only appears on the wave
 * page, and only AFTER an order is confirmed, which is too late to plan a
 * morning with. But the list does carry SKU codes, and this repo already syncs
 * every SKU's storage position, so the floor can be worked out before anything
 * is confirmed.
 *
 * Orders needing more than one floor are the expensive ones: that is a picker
 * walking between floor 3 and floor 5 for a single parcel, which is exactly
 * what the no-cross-zone rule exists to prevent.
 */
async function printZonePlan(page: Page, config: ReturnType<typeof loadWaveEngineConfig>): Promise<void> {
  const skuFloors = await loadSkuFloors(process.env.SHEET_LOCATION_CURRENT ?? 'DB_LOCATION_CURRENT');

  await ensureSessionValid(page, NEW_ORDERS_URL);
  const priorityPage = new BigSellerOrderPriorityPage(page);
  await priorityPage.goto();

  // Same exclusions as a real cycle: a reservation is not work, and an order
  // from a platform this engine may not touch is not work either. Counting
  // them would overstate the morning.
  const reserved = await priorityPage.collectStoreOrderIds(config.reservedStore);
  const blockedPlatform = await priorityPage.collectBlockedPlatformOrderIds(config.allowedPlatforms);

  await priorityPage.selectWarehouses([config.pickingWarehouse]);
  const expectedCount = (await priorityPage.readWarehouseOptions()).find((o) => o.name === config.pickingWarehouse)?.count;
  const rows = await priorityPage.scanOrders({
    depth: 'full',
    warehouseScope: config.pickingWarehouse,
    expectedCount,
  });
  await priorityPage.selectWarehouses('all');

  // A plan built on an empty read is worse than no plan: it says "nothing to
  // do" on the busiest morning of the week. Seen live 2026-09-12 when a filter
  // reset silently failed and left the page showing 68 manual orders.
  if (rows.length === 0) {
    throw new Error(
      `Read 0 orders in ${config.pickingWarehouse} while the filter reports ${expectedCount ?? 'an unknown number'} — ` +
        'refusing to report an empty morning. Check that no filter is left applied on the order page.',
    );
  }

  const byChannel = new Map<string, { floor: Map<string, number>; mixed: number; blocked: number; unknown: number }>();
  let totals = { counted: 0, mixed: 0, blocked: 0, unknown: 0 };
  const floorTotals = new Map<string, number>();
  const unknownSkus = new Map<string, number>();
  const blockedSkus = new Map<string, number>();

  for (const row of rows) {
    if (reserved.has(row.orderId) || blockedPlatform.has(row.orderId)) continue;
    const channel = resolveLogisticsChannel(row.rawShippingCell, config) || '(ไม่รู้จัก)';
    const entry = byChannel.get(channel) ?? { floor: new Map<string, number>(), mixed: 0, blocked: 0, unknown: 0 };
    const found = floorsForOrder(row.productCell, skuFloors);
    totals.counted++;

    for (const item of found.blocked) blockedSkus.set(item.sku, (blockedSkus.get(item.sku) ?? 0) + 1);
    for (const sku of found.unknown) unknownSkus.set(sku, (unknownSkus.get(sku) ?? 0) + 1);

    if (found.floors.length > 1) {
      entry.mixed++;
      totals.mixed++;
    } else if (found.floors.length === 1) {
      const floor = found.floors[0];
      entry.floor.set(floor, (entry.floor.get(floor) ?? 0) + 1);
      floorTotals.set(floor, (floorTotals.get(floor) ?? 0) + 1);
    } else if (found.blocked.length > 0) {
      entry.blocked++;
      totals.blocked++;
    } else {
      entry.unknown++;
      totals.unknown++;
    }
    byChannel.set(channel, entry);
  }

  const ranked = [...byChannel.entries()]
    .map(([channel, entry]) => ({ channel, entry, priority: config.channelPolicies[channel]?.priority }))
    .sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99));

  const lines = [
    '',
    `=== งานเช้านี้ แยกตามชั้นที่ต้องขึ้นไปหยิบ (${config.pickingWarehouse}, ${totals.counted} ใบ) ===`,
    ...ranked.map(({ channel, entry, priority }) => {
      const floors = [...entry.floor.entries()].sort((a, b) => b[1] - a[1]).map(([f, n]) => `${f} ${n}`).join(' · ');
      const extras = [
        entry.mixed > 0 ? `ข้ามชั้น ${entry.mixed}` : '',
        entry.blocked > 0 ? `ยังไม่เข้าชั้น ${entry.blocked}` : '',
        entry.unknown > 0 ? `ไม่รู้ตำแหน่ง ${entry.unknown}` : '',
      ].filter(Boolean).join(' · ');
      const rank = priority === undefined ? ' -' : ` ${priority}`;
      return `  ลำดับ${rank}  ${channel}
           ${floors || '(ไม่มีใบที่อยู่ชั้นเดียว)'}${extras ? `   ⚠ ${extras}` : ''}`;
    }),
    '',
    '=== รวมทั้งคลัง ===',
    ...[...floorTotals.entries()].sort((a, b) => b[1] - a[1]).map(([f, n]) => `  ${String(n).padStart(5)} ใบ   ${f}`),
    `  ${String(totals.mixed).padStart(5)} ใบ   ข้ามชั้น — หยิบรวมใน Wave เดียวไม่ได้ ต้องให้คนจัด`,
    `  ${String(totals.blocked).padStart(5)} ใบ   ของยังไม่เข้าชั้นหยิบ — ต้องย้ายมาก่อน`,
    `  ${String(totals.unknown).padStart(5)} ใบ   ไม่รู้ตำแหน่ง — ไม่มี SKU นี้ในตารางตำแหน่งจัดเก็บ`,
    '',
  ];

  if (unknownSkus.size > 0) {
    lines.push(
      `=== SKU ที่ไม่มีในตารางตำแหน่ง (${unknownSkus.size} รายการ, แสดง 15 อันดับแรก) ===`,
      ...[...unknownSkus.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([sku, n]) => `  ${String(n).padStart(4)} ใบ   ${sku}`),
      '',
    );
  }
  if (blockedSkus.size > 0) {
    lines.push(
      `=== SKU ที่ของยังไม่เข้าชั้นหยิบ (${blockedSkus.size} รายการ, แสดง 15 อันดับแรก) ===`,
      ...[...blockedSkus.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([sku, n]) => `  ${String(n).padStart(4)} ใบ   ${sku}`),
      '',
    );
  }
  console.log(lines.join('\n'));
}

/**
 * `--expiring`: which orders are closest to BigSeller's own auto-cancel
 * deadline, soonest first ("ใกล้หมดอายุก่อน", 2026-09-14).
 *
 * Read-only — a full scan of the picking warehouse, same exclusions as a real
 * cycle (LockStock reservations and non-marketplace platforms never counted),
 * sorted by `expiresAt` ascending. This is the only way to see the deadline
 * before a cycle runs: `--board` reads filter PILL COUNTS, which have no idea
 * which individual orders are close to expiring.
 *
 * Splits into "inside the urgent window" (WAVE_ENGINE_EXPIRY_URGENT_MINUTES —
 * these are what applyExpiryUrgency in tiers.ts will confirm on the next real
 * cycle regardless of tier timing) and "everything else with a known
 * deadline", so a human deciding what to do before that cycle runs can see
 * the same list the engine will act on.
 */
async function printExpiringSoon(page: Page, config: ReturnType<typeof loadWaveEngineConfig>): Promise<void> {
  await ensureSessionValid(page, NEW_ORDERS_URL);
  const priorityPage = new BigSellerOrderPriorityPage(page);
  await priorityPage.goto();

  const reservedOrderIds = await priorityPage.collectStoreOrderIds(config.reservedStore);
  const blockedPlatformOrderIds = await priorityPage.collectBlockedPlatformOrderIds(config.allowedPlatforms);

  await priorityPage.selectWarehouses([config.pickingWarehouse]);
  const expectedCount = (await priorityPage.readWarehouseOptions()).find((o) => o.name === config.pickingWarehouse)?.count;
  const rows = await priorityPage.scanOrders({ depth: 'full', warehouseScope: config.pickingWarehouse, expectedCount });
  await priorityPage.selectWarehouses('all');

  const orders = rows
    .map((row) => toDomainOrder(row, config, reservedOrderIds, blockedPlatformOrderIds))
    .filter((order) => !order.isReserved && !order.isBlockedPlatform);

  const now = Date.now();
  const withDeadline = orders
    .filter((order) => order.expiresAt !== null)
    .sort((a, b) => a.expiresAt! - b.expiresAt!);
  const noDeadline = orders.length - withDeadline.length;

  const describe = (order: (typeof orders)[number]) => {
    const minutesLeft = Math.round((order.expiresAt! - now) / 60000);
    const readable =
      minutesLeft <= 0
        ? 'หมดอายุแล้ว'
        : minutesLeft < 60
          ? `เหลือ ${minutesLeft} นาที`
          : `เหลือ ${(minutesLeft / 60).toFixed(1)} ชม.`;
    const channel = order.logisticsChannel || `(ไม่รู้จัก: ${order.rawShippingCell.slice(0, 40)})`;
    return `  ${readable.padEnd(14)} ${order.orderNo || order.orderId}   ${channel}`;
  };

  const urgent = withDeadline.filter((o) => (o.expiresAt! - now) / 60000 <= config.expiryUrgentMinutes);
  const rest = withDeadline.filter((o) => (o.expiresAt! - now) / 60000 > config.expiryUrgentMinutes);

  const lines = [
    '',
    `=== ใกล้หมดอายุก่อน (${config.pickingWarehouse}, ${bangkokHhMm(new Date())}) ===`,
    `เกณฑ์ด่วน: เหลือไม่ถึง ${config.expiryUrgentMinutes} นาที (WAVE_ENGINE_EXPIRY_URGENT_MINUTES)`,
    '',
    `--- ด่วน — บอทจะยืนยันทันทีในรอบถัดไป ไม่ว่าลำดับปกติจะว่าอย่างไร (${urgent.length} ใบ) ---`,
    ...(urgent.length > 0 ? urgent.map(describe) : ['  (ไม่มี)']),
    '',
    `--- ยังไม่ด่วน แต่มีกำหนดหมดอายุ เรียงใกล้สุดก่อน (${rest.length} ใบ) ---`,
    ...(rest.length > 0 ? rest.slice(0, 30).map(describe) : ['  (ไม่มี)']),
    ...(rest.length > 30 ? [`  ... อีก ${rest.length - 30} ใบ`] : []),
    '',
    `ไม่มีข้อมูลวันหมดอายุ: ${noDeadline} ใบ (อาจเป็นออเดอร์ที่ไม่มีป้าย Expire ในหน้าเว็บ)`,
    '',
  ];
  console.log(lines.join('\n'));
}

async function printPriorityBoard(page: Page, config: ReturnType<typeof loadWaveEngineConfig>): Promise<void> {
  await ensureSessionValid(page, NEW_ORDERS_URL);
  const priorityPage = new BigSellerOrderPriorityPage(page);
  await priorityPage.goto();

  const [logistics, stores, platforms, warehouses] = await Promise.all([
    readFilterPills(page, 'โลจิสติกส์'),
    readFilterPills(page, 'ร้านค้า'),
    readFilterPills(page, 'แพลตฟอร์ม'),
    priorityPage.readWarehouseOptions(),
  ]);

  // Reservations are not work and must not pad any number on this board
  // ("LockStock อย่านับ เขาจองของไม่เกี่ยว", 2026-09-11). They are Seller
  // Delivery orders, so that is the only courier line they inflate — and with
  // 60 of them sitting there, leaving them in made a line of pure noise look
  // like the biggest job on the board.
  const nowHhMm = bangkokHhMm(new Date());
  const reserved = stores.find((store) => store.label === config.reservedStore)?.count ?? 0;
  const realCount = (pill: { label: string; count: number | undefined }) =>
    pill.label.includes(SELLER_DELIVERY_CHANNEL) ? Math.max(0, (pill.count ?? 0) - reserved) : (pill.count ?? 0);

  // Orders from platforms outside the allowlist are not this engine's work at
  // all, so the board must not present them as a job waiting to be done.
  // Their overlap with the reserved store cannot be derived from filter counts
  // (the two filters are independent), so the workload is reported as a range
  // rather than a single invented number.
  const isAllowedPlatform = (label: string) =>
    config.allowedPlatforms.some((allowed) => label.toLowerCase().includes(allowed.toLowerCase()));
  const blockedPlatforms = platforms.filter(
    (pill) => pill.label !== 'ทั้งหมด' && (pill.count ?? 0) > 0 && !isAllowedPlatform(pill.label),
  );
  const blockedPlatformTotal = blockedPlatforms.reduce((sum, pill) => sum + (pill.count ?? 0), 0);

  const waiting = logistics.filter((pill) => realCount(pill) > 0);
  const ranked = waiting
    .map((pill) => ({ pill, priority: config.channelPolicies[resolveLogisticsChannel(pill.label, config)]?.priority }))
    .sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99) || realCount(b.pill) - realCount(a.pill));

  const lines = [
    '',
    '=== คิวคำสั่งซื้อใหม่ ตามลำดับความสำคัญ ===',
    ...ranked.map(({ pill, priority }) => {
      // Seller Delivery is known but has no fixed priority: it is routed by
      // its กำหนดส่ง date, and most of what sits under it is the reserved
      // store. Calling it "unknown" like a genuinely unmapped courier would
      // send someone hunting for a problem that isn't there.
      const isSellerDelivery = pill.label.includes(SELLER_DELIVERY_CHANNEL);
      const rank = priority === undefined ? (isSellerDelivery ? ' -' : ' ?') : ` ${priority}`;
      const flag =
        priority === undefined
          ? isSellerDelivery
            ? '  << ตามวันกำหนดส่ง'
            : '  << ไม่รู้จัก ต้องดูเอง'
          : priority <= 2
            ? '  << ทำก่อน'
            : '';
      return `  ลำดับ${rank}  ${String(realCount(pill)).padStart(4)} ใบ   ${pill.label}${flag}`;
    }),
    ...(ranked.length === 0 ? ['  (ไม่มีงานค้าง)'] : []),
    '',
    '=== ที่ไม่ต้องทำ / ต้องระวัง ===',
    `  ของจอง ${config.reservedStore}: ${reserved} ใบ — ไม่นับเป็นงาน หักออกจากทุกตัวเลขข้างบนแล้ว`,
    ...warehouses
      .filter((option) => option.name !== config.pickingWarehouse && option.count > 0)
      .map((option) => `  อยู่คลัง ${option.name}: ${option.count} ใบ << ต้องย้ายของมา ${config.pickingWarehouse} ก่อน`),
    ...(blockedPlatformTotal > 0
      ? [
          `  นอกช่องทางหลัก: ${blockedPlatformTotal} ใบ (${blockedPlatforms.map((pill) => pill.label).join(', ')}) — ไม่แตะ`,
        ]
      : []),
    ...(() => {
      const stockCount = warehouses.find((o) => o.name === config.pickingWarehouse)?.count ?? 0;
      // Upper bound assumes every reservation is already inside the blocked
      // platforms; the lower bound assumes none is. The truth is somewhere in
      // between and the filter counts cannot say where.
      const high = Math.max(0, stockCount - Math.max(reserved, blockedPlatformTotal));
      const low = Math.max(0, stockCount - reserved - blockedPlatformTotal);
      if (low === high) return [`  งานจริงใน ${config.pickingWarehouse}: ${high} ใบ (หักของจองและช่องทางนอกหลักแล้ว)`];
      return [
        `  งานจริงใน ${config.pickingWarehouse}: ${low}-${high} ใบ (หักของจองและช่องทางนอกหลักแล้ว — ` +
          'ของจองบางใบอยู่ในช่องทางนอกหลักอยู่แล้ว หน้านี้บอกไม่ได้ว่าซ้ำกันกี่ใบ)',
      ];
    })(),
    '',
    `=== แพลตฟอร์ม / เวลารถ (ตอนนี้ ${nowHhMm}) ===`,
    ...platforms
      .filter((pill) => (pill.count ?? 0) > 0)
      .map((pill) => {
        if (!isAllowedPlatform(pill.label)) {
          return `  ${String(pill.count).padStart(4)} ใบ   ${pill.label}   << ไม่แตะ (นอกช่องทางหลัก)`;
        }
        const cutoff = platformCutoffOf(pill.label);
        if (!cutoff) return `  ${String(pill.count).padStart(4)} ใบ   ${pill.label}   (ไม่มีเวลารถ)`;
        return (
          `  ${String(pill.count).padStart(4)} ใบ   ${pill.label}   รถ ${cutoff}   ` +
          `${nowHhMm >= cutoff ? '<< ถึงเวลาแล้ว' : 'ยังไม่ถึง'}`
        );
      }),
    '',
  ];
  console.log(lines.join('\n'));
}

async function inspectWavePage(page: Page, config: ReturnType<typeof loadWaveEngineConfig>): Promise<void> {
  const wavePage = new BigSellerGenerateWavePage(page);
  await ensureSessionValid(page, GENERATE_WAVE_URL);
  await wavePage.goto();

  const before = await wavePage.readSummary();
  await logger.info(`wave-engine [wave-dry-run]: totals before ticking ประเภทพัสดุ — parcels=${before.parcels}`);

  // Ticking parcel types is a filter change, not a write: no wave is created
  // and nothing is submitted. It is also the suspected difference between
  // reading a real count and reading 0, which is what stopped both live runs
  // on 2026-09-11 after they had already confirmed an order.
  await wavePage.selectAllPackageTypes();
  const summary = await wavePage.readSummary();
  await logger.info(
    `wave-engine [wave-dry-run]: page totals — parcels=${summary.parcels} skuTypes=${summary.skuTypes} items=${summary.items}`,
  );

  const tree = await wavePage.readLogisticsTree();
  if (tree.length === 0) {
    await logger.warn('wave-engine [wave-dry-run]: the โลจิสติกส์ tree is empty — nothing is waveable right now');
    return;
  }
  for (const node of tree) {
    await logger.info(
      `wave-engine [wave-dry-run]: ${node.isGroup ? 'GROUP' : '  leaf'} ` +
        `${node.group ? `${node.group} / ` : ''}${node.title}${node.checked ? ' [checked]' : ''}`,
    );
  }

  // How big would each carrier's wave be? Per CARRIER, not per group, because
  // that is the unit a wave is now created in (one carrier per wave, never
  // combined). A wave also sweeps up every waveable parcel for that carrier —
  // including ones staff confirmed by hand — so the number is worth seeing
  // before anyone authorises a live run. Selecting a scope is a filter change;
  // no wave is created here.
  const forBot: string[] = [];
  const forHumans: string[] = [];
  for (const carrier of tree.filter((node) => !node.isGroup)) {
    await wavePage.setLogisticsScope([{ title: carrier.title, group: carrier.group }]);
    const scoped = await wavePage.readSummary();
    if (scoped.parcels === 0) continue;
    const line =
      `${String(scoped.parcels).padStart(4)} พัสดุ / ${String(scoped.skuTypes).padStart(3)} ประเภท SKU / ` +
      `${String(scoped.items).padStart(4)} ชิ้น   ${carrier.title}`;
    (scoped.parcels >= config.minParcelsMultiType ? forBot : forHumans).push(line);
  }
  await wavePage.setLogisticsScope([{ title: tree[0].title }]);

  // Split into what the bot will wave and what it deliberately leaves alone.
  // Below the threshold a wave is one trip up a floor for a couple of parcels,
  // so those stay for a person ("บางรอบเหลือ 1-2 ใบ — เก็บไว้ให้คนทำ") — and
  // that handover only works if it is visible without reading a log file.
  console.log(
    [
      '',
      `=== พร้อมทำ wave (ถึง ${config.minParcelsMultiType} พัสดุแล้ว) ===`,
      ...(forBot.length > 0 ? forBot.map((line) => `  ${line}`) : ['  (ไม่มี)']),
      '',
      '=== เก็บไว้ให้คนทำ (น้อยเกินกว่าจะขึ้นชั้นไปหยิบ) ===',
      ...(forHumans.length > 0 ? forHumans.map((line) => `  ${line}`) : ['  (ไม่มี)']),
      '',
    ].join('\n'),
  );
}

async function dumpRawRows(priorityPage: BigSellerOrderPriorityPage, config: ReturnType<typeof loadWaveEngineConfig>, limit: number): Promise<void> {
  const rows = await priorityPage.dumpRawRows(limit);
  const scannedById = new Map((await priorityPage.scanOrders({ depth: 'light' })).map((row) => [row.orderId, row]));
  const now = new Date();
  console.log(`\n--- ${rows.length} raw order row(s) from ${NEW_ORDERS_URL} ---\n`);
  for (const row of rows) {
    const scanned = scannedById.get(row.orderId);
    console.log(`orderId=${row.orderId}`);
    console.log(`  cells:`);
    row.cells.forEach((cell, index) => console.log(`    [${index}] ${cell}`));
    console.log(`  hasUrgentClass=${row.hasUrgentClass}`);
    if (scanned) {
      const order = toDomainOrder(scanned, config);
      const decision = classifyOrder(order, config, { now, channelPendingCounts: {} });
      console.log(`  parsed: channel="${order.logisticsChannel}" urgent=${scanned.urgentFlag}(${scanned.urgentSignal}) ` +
        `deliveryRaw="${scanned.deliveryDateRaw ?? ''}" deliveryDate=${order.deliveryDate ?? 'null'} warehouse="${order.warehouse}"`);
      console.log(`  decision: tier=${String(decision.tier)} action=${decision.action}`);
      console.log(`  reason: ${decision.reason}`);
    }
    console.log('');
  }
  console.log('Check every "parsed" line against the cells above before trusting any live tier.\n');
}

async function runDaemon(
  page: Page,
  config: ReturnType<typeof loadWaveEngineConfig>,
  decisionLog: DecisionLog,
): Promise<void> {
  let stopping = false;
  let resolveExit: () => void = () => undefined;
  const exited = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });

  const guardedCycle = (loop: 'urgent' | 'main') => async () => {
    if (stopping) return;
    if (!(await checkIsLoggedIn(page))) {
      await logger.error(
        'wave-engine: session expired — stopping. A human must run "npm run login:bigseller" (and keep "npm run keep-alive" running), then restart this.',
      );
      stop();
      return;
    }
    // The urgent loop uses the fast path. Its whole job is to beat staff to
    // the hours-SLA orders, and the full scan takes ~2 minutes — long enough
    // that on 2026-09-11 three consecutive live runs found their target
    // already handled by a person. The fast path reads the filter counts
    // instead of every row and finishes in well under a minute.
    await (loop === 'urgent' ? runFastCycle(page, config, decisionLog) : runCycle(page, 'main', config, decisionLog));
  };

  const scheduler = startScheduler(config, {
    runUrgent: guardedCycle('urgent'),
    runMain: guardedCycle('main'),
    // Same full cycle as the main loop — the point of the pre-shift trigger
    // is to be ready before staff arrive, not to do something different.
    runPreShift: guardedCycle('main'),
  });

  function stop(): void {
    if (stopping) return;
    stopping = true;
    scheduler.stop();
    void logger.info('wave-engine: stopped');
    resolveExit();
  }

  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  console.log('wave-engine: running. Press Ctrl+C to stop.');
  await exited;
}

main().catch(async (error) => {
  await logger.error(`wave-engine: fatal: ${(error as Error).message}`);
  console.error(error);
  process.exit(1);
});
