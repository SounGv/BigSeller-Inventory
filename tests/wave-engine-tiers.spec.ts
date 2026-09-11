import { test, expect } from '@playwright/test';
import { loadWaveEngineConfig, type WaveEngineConfig } from '../src/wave-engine/config.js';
import {
  bangkokDateKey,
  bangkokHhMm,
  classifyOrder,
  parseDeliveryDate,
  resolveLogisticsChannel,
  sortByPriority,
  type ScannedOrder,
} from '../src/wave-engine/tiers.js';
import { assertScanIsComplete, extractDeliveryDateText, toScannedOrder } from '../src/bigseller/order-priority-page.js';
import { minParcelsForWaveType, shouldWaveNow } from '../src/wave-engine/wave-state.js';

/** Config built from an explicit env map so these tests never depend on the developer's own .env. */
function config(overrides: Record<string, string> = {}): WaveEngineConfig {
  return loadWaveEngineConfig({ ...overrides } as NodeJS.ProcessEnv);
}

function order(overrides: Partial<ScannedOrder> = {}): ScannedOrder {
  return {
    orderId: '1001',
    orderNo: 'ORD-1001',
    logisticsChannel: 'Shopee-TH-Instant Delivery',
    rawShippingCell: 'Shopee-TH-Instant Delivery',
    urgentFlag: false,
    deliveryDate: null,
    warehouse: 'STOCK_5',
    isReserved: false,
    ...overrides,
  };
}

/** 2026-09-10 14:00 Asia/Bangkok. */
const AFTERNOON = new Date('2026-09-10T07:00:00Z');
/** 2026-09-10 16:30 Asia/Bangkok — past every truck cutoff. */
const AFTER_CUTOFF = new Date('2026-09-10T09:30:00Z');
/** 10:00 Asia/Bangkok — morning, before any cutoff. */
const MORNING = new Date('2026-09-10T03:00:00Z');
/** 12:00 Asia/Bangkok — past the 11:45 instant cutoff, before the 13:00 restart. */
const BETWEEN_ROUNDS = new Date('2026-09-10T05:00:00Z');

test.describe('Bangkok clock helpers', () => {
  test('reads the date and time in Asia/Bangkok, not the host timezone', () => {
    // 23:30 UTC is already the NEXT day in Bangkok (+07:00) — the case that
    // breaks a naive host-local implementation.
    const lateUtc = new Date('2026-09-10T23:30:00Z');
    expect(bangkokDateKey(lateUtc)).toBe('2026-09-11');
    expect(bangkokHhMm(lateUtc)).toBe('06:30');
  });
});

test.describe('resolveLogisticsChannel', () => {
  test('finds the channel inside surrounding shipping-cell text', () => {
    const cell = 'โลจิสติกส์: Shopee-TH-Instant Delivery หมายเลขแทร็คกิ้ง TH1234567890';
    expect(resolveLogisticsChannel(cell, config())).toBe('Shopee-TH-Instant Delivery');
  });

  test('prefers the longest matching label so one courier cannot shadow another', () => {
    // All three contain "SPX" and sit at DIFFERENT priorities, so a careless
    // match puts same-day parcels on the standard round.
    expect(resolveLogisticsChannel('Shopee-TH-Express Delivery (SPX)', config())).toBe('Shopee-TH-Express Delivery (SPX)');
    expect(resolveLogisticsChannel('Shopee-TH-SPX Express', config())).toBe('Shopee-TH-SPX Express');
    expect(resolveLogisticsChannel('SPX Express(TH)', config())).toBe('SPX Express(TH)');
  });

  test('matches the instant channel by its stable prefix, not the full live label', () => {
    const live = 'Shopee-TH-Instant Delivery - ส่งทันที (แพ็ก 2 ชั่วโมง)';
    expect(resolveLogisticsChannel(live, config())).toBe('Shopee-TH-Instant Delivery');
  });

  test('returns empty for an unknown courier rather than guessing', () => {
    expect(resolveLogisticsChannel('NewCourier-TH-Overnight', config())).toBe('');
  });
});

test.describe('parseDeliveryDate', () => {
  test('parses the Thai display format BigSeller uses elsewhere', () => {
    expect(parseDeliveryDate('10 ก.ย. 2026')).toBe('2026-09-10');
    expect(parseDeliveryDate('10 ก.ย. 2026 15:52')).toBe('2026-09-10');
  });

  test('parses numeric formats, reading a leading 4-digit group as the year', () => {
    expect(parseDeliveryDate('2026-09-10')).toBe('2026-09-10');
    expect(parseDeliveryDate('10/09/2026')).toBe('2026-09-10');
  });

  test('returns null on anything it cannot read, so the caller flags instead of guessing', () => {
    expect(parseDeliveryDate('')).toBeNull();
    expect(parseDeliveryDate(null)).toBeNull();
    expect(parseDeliveryDate('ยังไม่กำหนด')).toBeNull();
    expect(parseDeliveryDate('99/99/2026')).toBeNull();
  });
});

test.describe('Seller Delivery', () => {
  test('GUARD: no กำหนดส่ง date is never auto-confirmed', () => {
    const decision = classifyOrder(order({ logisticsChannel: 'Seller Delivery', deliveryDate: null }), config(), {
      now: AFTERNOON,
      channelPendingCounts: {},
    });
    expect(decision.action).toBe('flag_manual');
    expect(decision.reason).toContain('GUARD_SELLER_DELIVERY_NO_DATE');
  });

  test('due today confirms now', () => {
    const decision = classifyOrder(
      order({ logisticsChannel: 'Seller Delivery', deliveryDate: '2026-09-10' }),
      config(),
      { now: AFTERNOON, channelPendingCounts: {} },
    );
    expect(decision.tier).toBe(5);
    expect(decision.action).toBe('confirm_now');
  });

  test('urgent flag makes a future-dated order confirm now', () => {
    const decision = classifyOrder(
      order({ logisticsChannel: 'Seller Delivery', deliveryDate: '2026-09-20', urgentFlag: true }),
      config(),
      { now: AFTERNOON, channelPendingCounts: {} },
    );
    expect(decision.tier).toBe(5);
    expect(decision.action).toBe('confirm_now');
  });

  test('future date waits while no end-of-day sweep time is configured', () => {
    const decision = classifyOrder(
      order({ logisticsChannel: 'Seller Delivery', deliveryDate: '2026-09-20' }),
      config(),
      { now: AFTERNOON, channelPendingCounts: {} },
    );
    expect(decision.tier).toBe(5);
    expect(decision.action).toBe('wait');
    expect(decision.reason).toContain('WAIT_NO_EOD_CONFIGURED');
  });

  test('future date confirms once the configured sweep time has passed', () => {
    const decision = classifyOrder(
      order({ logisticsChannel: 'Seller Delivery', deliveryDate: '2026-09-20' }),
      config({ WAVE_ENGINE_END_OF_DAY_SWEEP: '18:00' }),
      { now: new Date('2026-09-10T11:30:00Z'), channelPendingCounts: {} }, // 18:30 Bangkok
    );
    expect(decision.tier).toBe(5);
    expect(decision.action).toBe('confirm_now');
  });

  test('GUARD: an already-overdue date is escalated to a human, not auto-confirmed', () => {
    const decision = classifyOrder(
      order({ logisticsChannel: 'Seller Delivery', deliveryDate: '2026-09-01' }),
      config(),
      { now: AFTERNOON, channelPendingCounts: {} },
    );
    expect(decision.action).toBe('flag_manual');
    expect(decision.reason).toContain('GUARD_SELLER_DELIVERY_PAST_DATE');
  });
});

test.describe('the 12-channel priority order (user, 2026-09-11)', () => {
  const cases: [string, number][] = [
    ['Shopee-TH-Express Delivery (SPX)', 1],
    ['Shopee-TH-Instant Delivery', 2],
    ['Shopee-TH-Express Delivery (SHP Food)', 3],
    ['TikTok-TH-BEST Express', 4],
    ['Shopee-TH-DHL Domestic', 4],
    ['Lazada-TH-LEX TH', 5],
    ['Shopee-TH-SPX Express', 6],
    ['TikTok-TH-J&T Express', 7],
    ['TikTok-TH-Flash Express Thailand', 8],
    ['Lazada-TH-Flash Express', 9],
    ['SPX Express(TH)', 10],
    ['TikTok-TH-KEX Express Thailand', 11],
    ['Shopee-TH-Flash Express Bulky', 12],
  ];

  for (const [channel, expected] of cases) {
    test(`"${channel}" is priority ${expected}`, () => {
      const decision = classifyOrder(order({ logisticsChannel: channel, rawShippingCell: channel }), config(), {
        now: AFTERNOON,
        channelPendingCounts: {},
      });
      expect(decision.tier).toBe(expected);
    });
  }

  test('only the BEST/DHL pair may share a wave — everything else is alone', () => {
    const policies = config().channelPolicies;
    expect(policies['TikTok-TH-BEST Express'].shareWaveWith).toEqual(['Shopee-TH-DHL Domestic']);
    expect(policies['Shopee-TH-DHL Domestic'].shareWaveWith).toEqual(['TikTok-TH-BEST Express']);
    const others = Object.entries(policies).filter(([label]) => !label.includes('BEST') && !label.includes('DHL'));
    for (const [, policy] of others) {
      expect(policy.shareWaveWith).toEqual([]);
    }
  });

  test('the pair takes the EARLIER of its two platform cutoffs, so neither misses its truck', () => {
    const policies = config().channelPolicies;
    for (const label of ['TikTok-TH-BEST Express', 'Shopee-TH-DHL Domestic']) {
      const rule = policies[label].rule;
      expect(rule.kind).toBe('platform_cutoff');
      if (rule.kind === 'platform_cutoff') expect(rule.cutoff).toBe('14:01');
    }
  });
});

test.describe('rule 1 — batch of 10 in the morning, anything from the afternoon', () => {
  const channel = 'Shopee-TH-Express Delivery (SPX)';

  test('waits in the morning while fewer than 10 are waiting', () => {
    const decision = classifyOrder(order({ logisticsChannel: channel }), config(), {
      now: MORNING,
      channelPendingCounts: { [channel]: 3 },
    });
    expect(decision.action).toBe('wait');
    expect(decision.reason).toContain('WAIT_P1_BATCH');
  });

  test('goes in the morning once 10 are waiting', () => {
    const decision = classifyOrder(order({ logisticsChannel: channel }), config(), {
      now: MORNING,
      channelPendingCounts: { [channel]: 10 },
    });
    expect(decision.action).toBe('confirm_now');
    expect(decision.reason).toContain('CONFIRM_P1_BATCH');
  });

  test('from the afternoon a single order is enough', () => {
    const decision = classifyOrder(order({ logisticsChannel: channel }), config(), {
      now: AFTERNOON,
      channelPendingCounts: { [channel]: 1 },
    });
    expect(decision.action).toBe('confirm_now');
    expect(decision.reason).toContain('CONFIRM_P1_AFTERNOON');
  });

  test('SHP Food follows the same rule', () => {
    const food = 'Shopee-TH-Express Delivery (SHP Food)';
    const morning = classifyOrder(order({ logisticsChannel: food }), config(), {
      now: MORNING,
      channelPendingCounts: { [food]: 2 },
    });
    const afternoon = classifyOrder(order({ logisticsChannel: food }), config(), {
      now: AFTERNOON,
      channelPendingCounts: { [food]: 2 },
    });
    expect(morning.action).toBe('wait');
    expect(afternoon.action).toBe('confirm_now');
  });
});

test.describe('rule 2 — the 2-hour channel pauses between rounds', () => {
  const channel = 'Shopee-TH-Instant Delivery';

  test('runs in the morning before the 11:45 cutoff', () => {
    const decision = classifyOrder(order({ logisticsChannel: channel }), config(), {
      now: MORNING,
      channelPendingCounts: {},
    });
    expect(decision.action).toBe('confirm_now');
  });

  test('stops between the 11:45 cutoff and the 13:00 restart', () => {
    const decision = classifyOrder(order({ logisticsChannel: channel }), config(), {
      now: BETWEEN_ROUNDS,
      channelPendingCounts: {},
    });
    expect(decision.action).toBe('wait');
    expect(decision.reason).toContain('WAIT_P2_BETWEEN_ROUNDS');
  });

  test('runs again from 13:00', () => {
    const decision = classifyOrder(order({ logisticsChannel: channel }), config(), {
      now: AFTERNOON,
      channelPendingCounts: {},
    });
    expect(decision.action).toBe('confirm_now');
  });

  test('is never batched with anything else', () => {
    const decision = classifyOrder(order({ logisticsChannel: channel }), config(), {
      now: MORNING,
      channelPendingCounts: {},
    });
    expect(decision.batchable).toBe(false);
  });
});

test.describe('rule 3 — each channel rides its own platform truck', () => {
  const at = (now: Date, channel: string) =>
    classifyOrder(order({ logisticsChannel: channel }), config(), { now, channelPendingCounts: {} });

  test('Lazada (13:01) waits at noon and goes by 14:00', () => {
    expect(at(BETWEEN_ROUNDS, 'Lazada-TH-LEX TH').action).toBe('wait');
    expect(at(AFTERNOON, 'Lazada-TH-LEX TH').action).toBe('confirm_now');
  });

  test('TikTok (14:01) still waits at 14:00 — one minute matters', () => {
    expect(at(AFTERNOON, 'TikTok-TH-J&T Express').action).toBe('wait');
    expect(at(AFTER_CUTOFF, 'TikTok-TH-J&T Express').action).toBe('confirm_now');
  });

  test('Shopee (16:01) waits through the afternoon and goes at 16:30', () => {
    expect(at(AFTERNOON, 'Shopee-TH-SPX Express').action).toBe('wait');
    expect(at(AFTER_CUTOFF, 'Shopee-TH-SPX Express').action).toBe('confirm_now');
  });
});

test.describe('scan completeness', () => {
  test('accepts the drift a live queue actually produces', () => {
    expect(() => assertScanIsComplete(1600, 1619)).not.toThrow();
    expect(() => assertScanIsComplete(95, 100)).not.toThrow();
    // Both of these aborted real cycles on 2026-09-11 purely because staff
    // were confirming orders while the bot scanned.
    expect(() => assertScanIsComplete(146, 160)).not.toThrow();
    expect(() => assertScanIsComplete(152, 165)).not.toThrow();
  });

  test('rejects the real 2026-09-11 failure: 81 rows scanned against a 1,619-order filter', () => {
    expect(() => assertScanIsComplete(81, 1619)).toThrow(/Scan is incomplete/);
  });

  test('no expected count means no check, rather than a false alarm', () => {
    expect(() => assertScanIsComplete(0, undefined)).not.toThrow();
  });
});

test.describe('reserved-store guardrail — ของจอง is left alone', () => {
  test('a reservation is skipped, not confirmed, whatever its tier', () => {
    const decision = classifyOrder(order({ isReserved: true, warehouse: 'STOCK_5' }), config(), {
      now: AFTERNOON,
      channelPendingCounts: {},
    });
    expect(decision.action).toBe('skip');
    expect(decision.reason).toContain('EXCLUDED_RESERVED_STORE');
    expect(decision.tier).toBe(2);
  });

  test('skip wins over the warehouse guard — a reservation needs no stock move either', () => {
    const decision = classifyOrder(order({ isReserved: true, warehouse: 'STOCK_6' }), config(), {
      now: AFTERNOON,
      channelPendingCounts: {},
    });
    expect(decision.action).toBe('skip');
    expect(decision.reason).not.toContain('GUARD_WRONG_WAREHOUSE');
  });

  test('a normal order is untouched by it', () => {
    const decision = classifyOrder(order({ isReserved: false, warehouse: 'STOCK_5' }), config(), {
      now: AFTERNOON,
      channelPendingCounts: {},
    });
    expect(decision.action).toBe('confirm_now');
  });
});

test.describe('warehouse guardrail — only STOCK_5 holds sellable stock', () => {
  test('an order in the picking warehouse is unaffected', () => {
    const decision = classifyOrder(order({ warehouse: 'STOCK_5' }), config(), { now: AFTERNOON, channelPendingCounts: {} });
    expect(decision.tier).toBe(2);
    expect(decision.action).toBe('confirm_now');
  });

  test('GUARD: an order allocated elsewhere is never confirmed, whatever its tier', () => {
    const decision = classifyOrder(order({ warehouse: 'STOCK_6' }), config(), { now: AFTERNOON, channelPendingCounts: {} });
    expect(decision.action).toBe('flag_manual');
    expect(decision.reason).toContain('GUARD_WRONG_WAREHOUSE');
    // The priority is preserved so the log still shows how urgent the stock move is.
    expect(decision.tier).toBe(2);
  });

  test('GUARD: the decoy warehouse is called out explicitly as damaged-stock mirror', () => {
    const decision = classifyOrder(order({ warehouse: 'STOCK_ซิงก์ขายออนไลน์' }), config(), {
      now: AFTERNOON,
      channelPendingCounts: {},
    });
    expect(decision.action).toBe('flag_manual');
    expect(decision.reason).toContain('GUARD_WRONG_WAREHOUSE');
    expect(decision.reason).toContain('decoy warehouse');
    expect(decision.reason).toContain('ตำแหน่งชำรุด');
  });

  test('does not fire while the warehouse is unknown, so it can never flag on a guess', () => {
    const decision = classifyOrder(order({ warehouse: '' }), config(), { now: AFTERNOON, channelPendingCounts: {} });
    expect(decision.action).toBe('confirm_now');
  });
});

test.describe('execution ordering', () => {
  const decide = (overrides: Partial<ScannedOrder>) => ({
    decision: classifyOrder(order(overrides), config(), { now: AFTERNOON, channelPendingCounts: {} }),
  });

  test('urgent-flagged orders sort to the front of their own priority', () => {
    const plain = decide({ orderId: 'a' });
    const urgent = decide({ orderId: 'b', urgentFlag: true });
    expect(sortByPriority([plain, urgent])[0]).toBe(urgent);
  });

  test('a lower priority number goes first, even against an urgent-flagged higher number', () => {
    // The case a confirm cap actually hits: Express Delivery (SPX), priority 1,
    // must be confirmed before the 2-hour instant channel at priority 2 — flag
    // or no flag.
    const first = decide({ logisticsChannel: 'Shopee-TH-Express Delivery (SPX)' });
    const instantUrgent = decide({ logisticsChannel: 'Shopee-TH-Instant Delivery', urgentFlag: true });
    expect(first.decision.tier).toBe(1);
    expect(instantUrgent.decision.tier).toBe(2);
    expect(sortByPriority([instantUrgent, first])[0]).toBe(first);
  });
});

test.describe('row parsing', () => {
  test('extractDeliveryDateText pulls the text following the กำหนดส่ง label', () => {
    expect(extractDeliveryDateText('Seller Delivery กำหนดส่ง: 10 ก.ย. 2026 ผู้ให้บริการ')).toContain('10 ก.ย. 2026');
    expect(extractDeliveryDateText('Shopee-TH-Instant Delivery TH123')).toBeNull();
  });

  test('toScannedOrder maps the confirmed column positions and both urgent signals', () => {
    const cells = ['product', 'value', 'recipient', 'ORD-1 คัดลอก', 'time', 'Seller Delivery กำหนดส่ง 10 ก.ย. 2026', 'platform', 'ใหม่', 'actions'];
    const byClass = toScannedOrder({ orderId: '1', cells, rowText: cells.join(' '), hasUrgentClass: true });
    expect(byClass.orderNo).toBe('ORD-1');
    expect(byClass.rawShippingCell).toContain('กำหนดส่ง');
    expect(byClass.statusText).toBe('ใหม่');
    expect(byClass.urgentFlag).toBe(true);
    expect(byClass.urgentSignal).toBe('class*=urgent');

    const byText = toScannedOrder({ orderId: '2', cells, rowText: `${cells.join(' ')} ด่วนพิเศษ`, hasUrgentClass: false });
    expect(byText.urgentFlag).toBe(true);
    expect(byText.urgentSignal).toBe('ด่วนพิเศษ');

    const neither = toScannedOrder({ orderId: '3', cells, rowText: cells.join(' '), hasUrgentClass: false });
    expect(neither.urgentFlag).toBe(false);
    expect(neither.warehouse).toBe('');
  });

  test('warehouse comes from the scan scope, never from the row text', () => {
    // A real JIB row carries the CUSTOMER's warehouse in the recipient cell.
    // It must not be mistaken for our own stock location.
    const cells = ['product', 'value', 'บริษัท เจ.ไอ.บี. (สำนักงานใหญ่) (STOCK-3 คลังออนไลน์)', 'ORD-9', 'time', 'Seller Delivery', '--', 'ใหม่', ''];
    const row = { orderId: '9', cells, rowText: cells.join(' '), hasUrgentClass: false };

    expect(toScannedOrder(row).warehouse).toBe('');
    expect(toScannedOrder(row, 'STOCK_5').warehouse).toBe('STOCK_5');
  });
});

test.describe('wave batching — full load now, short load after the window', () => {
  const base = { minParcels: 20, intervalMinutes: 30, now: new Date('2026-09-11T07:00:00Z') };

  test('a full load goes straight away', () => {
    const verdict = shouldWaveNow({ ...base, parcels: 22, lastWaveAt: new Date('2026-09-11T06:55:00Z').toISOString() });
    expect(verdict.wave).toBe(true);
    expect(verdict.reason).toContain('full load');
  });

  test('a short load keeps collecting inside the window', () => {
    // The real failure this prevents: 1-parcel waves, three trips upstairs
    // for 13 items (live, 2026-09-11).
    const verdict = shouldWaveNow({ ...base, parcels: 1, lastWaveAt: new Date('2026-09-11T06:50:00Z').toISOString() });
    expect(verdict.wave).toBe(false);
    expect(verdict.reason).toContain('still collecting');
  });

  test('a short load goes once the window has elapsed', () => {
    const verdict = shouldWaveNow({ ...base, parcels: 6, lastWaveAt: new Date('2026-09-11T06:25:00Z').toISOString() });
    expect(verdict.wave).toBe(true);
    expect(verdict.reason).toContain('batched over');
  });

  test('zero parcels never waves', () => {
    expect(shouldWaveNow({ ...base, parcels: 0, lastWaveAt: undefined }).wave).toBe(false);
  });

  test('a short load with no previous wave waits rather than going out tiny', () => {
    const verdict = shouldWaveNow({ ...base, parcels: 2, lastWaveAt: undefined });
    expect(verdict.wave).toBe(false);
  });
});

test.describe('per-type wave thresholds', () => {
  const thresholds = { single: 50, multi: 20 };

  test('a single-SKU row needs 50 parcels to be worth a trip', () => {
    const verdict = minParcelsForWaveType('รวมประเภทเดี่ยว Fan Keyboard', thresholds);
    expect(verdict.min).toBe(50);
    expect(verdict.kind).toBe('single');
  });

  test('a multi-SKU row needs 20', () => {
    const verdict = minParcelsForWaveType('สินค้าหลายชนิด/ชิ้น', thresholds);
    expect(verdict.min).toBe(20);
    expect(verdict.kind).toBe('multi');
  });

  test('an unfamiliar type takes the smaller threshold so it cannot sit forever', () => {
    expect(minParcelsForWaveType('Wave สินค้าขายดี', thresholds).min).toBe(20);
  });
});
