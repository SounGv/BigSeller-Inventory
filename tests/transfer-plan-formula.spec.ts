import { test, expect } from '@playwright/test';
import {
  computeReplenishmentCandidates,
  findSourcePositions,
  buildTransferPlan,
  zoneOf,
  roundToCartonMultiple,
} from '../src/services/transfer-plan-service.js';
import { sourceAreaOf, groupBySourcePosition, chunkRows } from '../src/services/move-export-service.js';
import type { TransferPlanRow } from '../src/types.js';

function skuStock(totalWarehouseStock: number, availableWarehouseStock = totalWarehouseStock) {
  return new Map([['SKU1', { totalWarehouseStock, availableWarehouseStock }]]);
}

function locationRow(overrides: Partial<Record<string, string>> = {}): Record<string, string> {
  return {
    sku: 'SKU1',
    warehouse: 'STOCK_5',
    area: 'AREA1',
    position: 'CY-001',
    positionType: 'ตำแหน่งหยิบสินค้า',
    stockAtPosition: '10',
    lockedStock: '0',
    availableStock: '10',
    unshelvedStock: '0',
    maxStock: '50',
    minStock: '5',
    ...overrides,
  };
}

/** A storage-type row — the only positionType `findSourcePositions` may draw a source from. Label confirmed live against real synced data (2026-08-25): "ตำแหน่งเก็บสินค้า", not "ตำแหน่งจัดเก็บสินค้า". */
function storageRow(overrides: Partial<Record<string, string>> = {}): Record<string, string> {
  return locationRow({ positionType: 'ตำแหน่งเก็บสินค้า', ...overrides });
}

test.describe('zoneOf', () => {
  test('drops the last hyphen segment', () => {
    expect(zoneOf('01U-01-01')).toBe('01U-01');
    expect(zoneOf('3B-33-21')).toBe('3B-33');
    expect(zoneOf('CY-075')).toBe('CY');
  });

  test('falls back to the whole string when there is no hyphen', () => {
    expect(zoneOf('NOHYPHEN')).toBe('NOHYPHEN');
  });
});

test.describe('computeReplenishmentCandidates', () => {
  test('replenishableQty = MAX(0, maxStock - stockAtPosition)', () => {
    const rows = [locationRow({ stockAtPosition: '20', maxStock: '50' })];
    const candidates = computeReplenishmentCandidates(rows, skuStock(100));
    expect(candidates[0].replenishableQty).toBe(30);
  });

  test('excludes a position that is more than half full — replenishableQty < maxStock * 0.5', () => {
    // stockAtPosition=30, maxStock=50 -> replenishableQty=20, which is < 25 (half of 50).
    const rows = [locationRow({ stockAtPosition: '30', maxStock: '50' })];
    const candidates = computeReplenishmentCandidates(rows, skuStock(100));
    expect(candidates).toHaveLength(0);
  });

  test('includes a position exactly at the half-full boundary (replenishableQty === maxStock * 0.5)', () => {
    const rows = [locationRow({ stockAtPosition: '25', maxStock: '50' })];
    const candidates = computeReplenishmentCandidates(rows, skuStock(100));
    expect(candidates).toHaveLength(1);
    expect(candidates[0].replenishableQty).toBe(25);
  });

  test('excludes a position that is already full (replenishableQty = 0)', () => {
    const rows = [locationRow({ stockAtPosition: '50', maxStock: '50' })];
    const candidates = computeReplenishmentCandidates(rows, skuStock(100));
    expect(candidates).toHaveLength(0);
  });

  test('excludes a candidate when the warehouse has nothing left to give (warehouseRemainingQty = 0)', () => {
    const rows = [locationRow({ stockAtPosition: '10', maxStock: '50' })];
    const candidates = computeReplenishmentCandidates(rows, skuStock(10));
    expect(candidates).toHaveLength(0);
  });

  test('excludes "ไม่มีตำแหน่งหยิบ" placeholder positions entirely', () => {
    const rows = [locationRow({ position: '001 ( ไม่มีตำแหน่งหยิบ )', stockAtPosition: '0', maxStock: '50' })];
    const candidates = computeReplenishmentCandidates(rows, skuStock(100));
    expect(candidates).toHaveLength(0);
  });

  test('treats a "--" (unset) maxStock as 0, so nothing is targeted for replenishment', () => {
    const rows = [locationRow({ maxStock: '0', stockAtPosition: '0' })];
    const candidates = computeReplenishmentCandidates(rows, skuStock(100));
    expect(candidates).toHaveLength(0);
  });

  test('warehouseRemainingQty is based on availableWarehouseStock, not totalWarehouseStock — reserved/locked stock is never counted as pullable', () => {
    // totalWarehouseStock=100 but 85 of it is locked against orders, leaving only 15 available.
    const rows = [locationRow({ stockAtPosition: '10', maxStock: '50' })]; // replenishableQty=40
    const candidates = computeReplenishmentCandidates(rows, skuStock(100, 15));
    expect(candidates).toHaveLength(1);
    expect(candidates[0].warehouseRemainingQty).toBe(5); // availableWarehouseStock(15) - stockAtPosition(10), NOT totalWarehouseStock(100) - stockAtPosition(10) = 90
  });

  test('excludes a candidate entirely when all warehouse stock for the SKU is locked/reserved (availableWarehouseStock = 0)', () => {
    const rows = [locationRow({ stockAtPosition: '10', maxStock: '50' })];
    const candidates = computeReplenishmentCandidates(rows, skuStock(100, 0));
    expect(candidates).toHaveLength(0);
  });

  test('excludes "ของแถม" (gift-with-purchase) positions entirely — staff handle these by hand', () => {
    const rows = [locationRow({ position: 'FANTECH-หยิบ-ของแถม', stockAtPosition: '0', maxStock: '50' })];
    const candidates = computeReplenishmentCandidates(rows, skuStock(100));
    expect(candidates).toHaveLength(0);
  });
});

test.describe('roundToCartonMultiple', () => {
  test('rounds up when the remainder is at least half a carton', () => {
    expect(roundToCartonMultiple(45, 10)).toBe(50);
  });

  test('rounds down when the remainder is less than half a carton', () => {
    expect(roundToCartonMultiple(44, 10)).toBe(40);
  });

  test('an exact multiple stays unchanged', () => {
    expect(roundToCartonMultiple(40, 10)).toBe(40);
  });

  test('exactly half rounds up (matches the user-specified tie-break)', () => {
    expect(roundToCartonMultiple(5, 10)).toBe(10);
  });
});

test.describe('computeReplenishmentCandidates — carton rounding', () => {
  test('rounds replenishableQty to the nearest carton multiple for a carton-eligible zone (01U) when the SKU has a known carton size', () => {
    const rows = [locationRow({ position: '01U-01-01', stockAtPosition: '5', maxStock: '50' })]; // rawReplenishableQty=45
    const cartonQty = new Map([['SKU1', 10]]);
    const candidates = computeReplenishmentCandidates(rows, skuStock(1000), cartonQty);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].replenishableQty).toBe(50); // 45 -> nearest 10 rounds up
  });

  test('does not round for a non-carton-eligible zone even with a known carton size', () => {
    const rows = [locationRow({ position: 'CY-001', stockAtPosition: '5', maxStock: '50' })]; // CY is not carton-eligible
    const cartonQty = new Map([['SKU1', 10]]);
    const candidates = computeReplenishmentCandidates(rows, skuStock(1000), cartonQty);
    expect(candidates[0].replenishableQty).toBe(45); // unchanged, plain per-unit
  });

  test('does not round when the SKU has no entry in the carton-quantity map', () => {
    const rows = [locationRow({ position: '01U-01-01', stockAtPosition: '5', maxStock: '50' })];
    const candidates = computeReplenishmentCandidates(rows, skuStock(1000), new Map()); // no carton data for SKU1
    expect(candidates[0].replenishableQty).toBe(45); // unchanged
  });

  test('skips the candidate entirely when rounding brings the need down to zero cartons', () => {
    // rawReplenishableQty=3 (stockAtPosition=3, maxStock=6) clears the >=50%-of-max
    // half-full rule on its own, but rounds down to 0 cartons at carton size 10.
    const rows = [locationRow({ position: '01U-01-01', stockAtPosition: '3', maxStock: '6' })];
    const cartonQty = new Map([['SKU1', 10]]);
    expect(computeReplenishmentCandidates(rows, skuStock(1000), cartonQty)).toHaveLength(0);
  });
});

test.describe('findSourcePositions', () => {
  test('sourceMovableQty = MAX(0, availableStock - minStock)', () => {
    const rows = [storageRow({ position: 'STORAGE-1', availableStock: '30', minStock: '5' })];
    const sources = findSourcePositions('SKU1', 'CY-001', rows);
    expect(sources).toEqual([{ position: 'STORAGE-1', sourceMovableQty: 25 }]);
  });

  test('excludes the target position itself', () => {
    const rows = [storageRow({ position: 'CY-001', availableStock: '30', minStock: '5' })];
    expect(findSourcePositions('SKU1', 'CY-001', rows)).toHaveLength(0);
  });

  test('excludes a source that would drop below its own minStock', () => {
    const rows = [storageRow({ position: 'STORAGE-1', availableStock: '5', minStock: '5' })];
    expect(findSourcePositions('SKU1', 'CY-001', rows)).toHaveLength(0);
  });

  test('excludes "ไม่มีตำแหน่งหยิบ" placeholder positions as a source', () => {
    const rows = [storageRow({ position: '001 ( ไม่มีตำแหน่งหยิบ )', availableStock: '100', minStock: '0' })];
    expect(findSourcePositions('SKU1', 'CY-001', rows)).toHaveLength(0);
  });

  test('excludes "ของแถม" (gift-with-purchase) positions as a source too', () => {
    const rows = [storageRow({ position: 'FANTECH-จัดเก็บ-ของแถม', availableStock: '100', minStock: '0' })];
    expect(findSourcePositions('SKU1', 'CY-001', rows)).toHaveLength(0);
  });

  test('sorts multiple sources by sourceMovableQty descending', () => {
    const rows = [
      storageRow({ position: 'STORAGE-1', availableStock: '20', minStock: '0' }),
      storageRow({ position: 'STORAGE-2', availableStock: '50', minStock: '0' }),
    ];
    const sources = findSourcePositions('SKU1', 'CY-001', rows);
    expect(sources.map((s) => s.position)).toEqual(['STORAGE-2', 'STORAGE-1']);
  });

  test('excludes a pick position from ever being used as a source (pick -> pick is never valid, only storage -> pick)', () => {
    // Same SKU, another pick bin (positionType defaults to ตำแหน่งหยิบสินค้า via locationRow) with plenty of stock.
    const rows = [locationRow({ position: 'PC-019', availableStock: '100', minStock: '0' })];
    expect(findSourcePositions('SKU1', 'CY-001', rows)).toHaveLength(0);
  });
});

test.describe('computeReplenishmentCandidates — position-type rule', () => {
  test('excludes a storage-type row entirely, even if it looks understocked — only a pick position can be a replenishment target', () => {
    const rows = [storageRow({ position: 'STORAGE-1', stockAtPosition: '5', maxStock: '50' })]; // would look like replenishableQty=45 if type weren't checked
    const candidates = computeReplenishmentCandidates(rows, skuStock(100));
    expect(candidates).toHaveLength(0);
  });
});

test.describe('buildTransferPlan', () => {
  // Pure source rows use maxStock: '0' so they don't ALSO qualify as their own
  // replenishment candidate (a source position with real thresholds set would
  // otherwise be picked up by computeReplenishmentCandidates too).
  test('moveQty = MIN(replenishableQty, warehouseRemainingQty, sourceMovableQty) — capped by the smallest of the three, fully met', () => {
    const rows = [
      locationRow({ position: 'CY-001', stockAtPosition: '10', maxStock: '20' }), // replenishableQty=10 (exactly half of maxStock, still eligible, and the smallest constraint here)
      storageRow({ position: 'STORAGE-1', availableStock: '20', minStock: '0', maxStock: '0' }), // sourceMovableQty=20
    ];
    const candidates = computeReplenishmentCandidates(rows, skuStock(100)); // warehouseRemainingQty=90
    const { plan, exceptions } = buildTransferPlan('RUN1', candidates, rows);

    expect(exceptions).toHaveLength(0);
    expect(plan).toHaveLength(1);
    expect(plan[0].moveQty).toBe(10);
    expect(plan[0].sourceQty).toBe(plan[0].targetQty);
  });

  test('logs a TRANSFER_EXCEPTION for the unmet remainder when sources cannot fully cover the need', () => {
    const rows = [
      locationRow({ position: 'CY-001', stockAtPosition: '10', maxStock: '50' }), // replenishableQty=40
      storageRow({ position: 'STORAGE-1', availableStock: '15', minStock: '0', maxStock: '0' }), // sourceMovableQty=15
    ];
    const candidates = computeReplenishmentCandidates(rows, skuStock(100)); // warehouseRemainingQty=90
    const { plan, exceptions } = buildTransferPlan('RUN1', candidates, rows);

    expect(plan).toHaveLength(1);
    expect(plan[0].moveQty).toBe(15); // all the one source position could give
    expect(exceptions).toHaveLength(1);
    expect(exceptions[0].reason).toContain('25'); // 40 needed - 15 moved = 25 short
  });

  test('splits across multiple source positions when one alone is not enough', () => {
    const rows = [
      locationRow({ position: 'CY-001', stockAtPosition: '10', maxStock: '50' }), // replenishableQty=40
      storageRow({ position: 'STORAGE-1', availableStock: '25', minStock: '0', maxStock: '0' }),
      storageRow({ position: 'STORAGE-2', availableStock: '10', minStock: '0', maxStock: '0' }),
    ];
    const candidates = computeReplenishmentCandidates(rows, skuStock(100));
    const { plan, exceptions } = buildTransferPlan('RUN1', candidates, rows);

    expect(plan).toHaveLength(2);
    expect(plan.reduce((sum, p) => sum + p.moveQty, 0)).toBe(35); // 25 + 10, still short of 40 but that's all the sources have
    expect(exceptions).toHaveLength(1); // remaining 5 units unmet
  });

  test('records a TRANSFER_EXCEPTION when no source position exists at all', () => {
    const rows = [locationRow({ position: 'CY-001', stockAtPosition: '10', maxStock: '50', availableStock: '10' })];
    const candidates = computeReplenishmentCandidates(rows, skuStock(100));
    const { plan, exceptions } = buildTransferPlan('RUN1', candidates, rows);

    expect(plan).toHaveLength(0);
    expect(exceptions).toHaveLength(1);
    expect(exceptions[0].targetPosition).toBe('CY-001');
  });

  test('a carton-eligible target whose source can only give a part-carton amount gets NO move at all — logs an exception instead (real bug 2026-08-26: SKU with cartonQty=88 moved just 14 units, all the source had)', () => {
    const rows = [
      locationRow({ position: '01U-01-01', stockAtPosition: '5', maxStock: '90' }), // rawReplenishableQty=85 -> rounds to 88 (1 carton)
      storageRow({ position: 'STORAGE-1', availableStock: '14', minStock: '0', maxStock: '0' }), // only 14 available, nowhere near 88
    ];
    const cartonQty = new Map([['SKU1', 88]]);
    const candidates = computeReplenishmentCandidates(rows, skuStock(1000), cartonQty);
    const { plan, exceptions } = buildTransferPlan('RUN1', candidates, rows);

    expect(plan).toHaveLength(0);
    expect(exceptions).toHaveLength(1);
    expect(exceptions[0].reason).toContain('14');
    expect(exceptions[0].reason).toContain('88');
  });

  test('a carton-eligible target whose sources TOGETHER reach a full carton still gets the move (split across sources is fine)', () => {
    const rows = [
      locationRow({ position: '01U-01-01', stockAtPosition: '5', maxStock: '90' }), // rounds to 88
      storageRow({ position: 'STORAGE-1', availableStock: '50', minStock: '0', maxStock: '0' }),
      storageRow({ position: 'STORAGE-2', availableStock: '40', minStock: '0', maxStock: '0' }),
    ];
    const cartonQty = new Map([['SKU1', 88]]);
    const candidates = computeReplenishmentCandidates(rows, skuStock(1000), cartonQty);
    const { plan, exceptions } = buildTransferPlan('RUN1', candidates, rows);

    expect(plan.reduce((sum, p) => sum + p.moveQty, 0)).toBe(88); // 50 + 38 (capped at the 88 needed)
    expect(exceptions).toHaveLength(0);
  });

  test('a carton-eligible move that clears 1 carton but is NOT an exact multiple gets trimmed down to the nearest whole carton (real bug 2026-08-26: 239 available at cartonQty=50 shipped as 239, should floor to 200)', () => {
    const rows = [
      locationRow({ position: '01U-01-01', stockAtPosition: '5', maxStock: '300' }), // rounds up to a big carton need
      storageRow({ position: 'STORAGE-1', availableStock: '239', minStock: '0', maxStock: '0' }),
    ];
    const cartonQty = new Map([['SKU1', 50]]);
    const candidates = computeReplenishmentCandidates(rows, skuStock(1000), cartonQty);
    const { plan, exceptions } = buildTransferPlan('RUN1', candidates, rows);

    expect(plan).toHaveLength(1);
    expect(plan[0].moveQty).toBe(200); // floor(239/50)*50, not 239
    expect(exceptions.some((e) => e.reason.includes('200') && e.reason.includes('39'))).toBe(true);
  });

  test('trimming a non-multiple total reduces the LAST source added first, leaving earlier sources untouched', () => {
    const rows = [
      locationRow({ position: '01U-01-01', stockAtPosition: '5', maxStock: '300' }),
      storageRow({ position: 'STORAGE-1', availableStock: '150', minStock: '0', maxStock: '0' }), // tried first (largest)
      storageRow({ position: 'STORAGE-2', availableStock: '89', minStock: '0', maxStock: '0' }), // tried second, total=239
    ];
    const cartonQty = new Map([['SKU1', 50]]);
    const candidates = computeReplenishmentCandidates(rows, skuStock(1000), cartonQty);
    const { plan } = buildTransferPlan('RUN1', candidates, rows);

    expect(plan.reduce((sum, p) => sum + p.moveQty, 0)).toBe(200);
    const first = plan.find((p) => p.sourcePosition === 'STORAGE-1');
    const second = plan.find((p) => p.sourcePosition === 'STORAGE-2');
    expect(first?.moveQty).toBe(150); // untouched
    expect(second?.moveQty).toBe(50); // 89 - 39 excess
  });

  test('an exact carton multiple is left alone — no trimming, no exception', () => {
    const rows = [
      locationRow({ position: '01U-01-01', stockAtPosition: '5', maxStock: '205' }), // rawReplenishableQty=200, already an exact multiple
      storageRow({ position: 'STORAGE-1', availableStock: '200', minStock: '0', maxStock: '0' }),
    ];
    const cartonQty = new Map([['SKU1', 50]]);
    const candidates = computeReplenishmentCandidates(rows, skuStock(1000), cartonQty);
    const { plan, exceptions } = buildTransferPlan('RUN1', candidates, rows);

    expect(plan[0].moveQty).toBe(200);
    expect(exceptions).toHaveLength(0);
  });

  test('a non-carton-eligible target is unaffected by the full-carton rule, even with a tiny available amount', () => {
    const rows = [
      locationRow({ position: 'CY-001', stockAtPosition: '10', maxStock: '50' }), // replenishableQty=40, CY is not carton-eligible
      storageRow({ position: 'STORAGE-1', availableStock: '3', minStock: '0', maxStock: '0' }),
    ];
    const cartonQty = new Map([['SKU1', 88]]); // SKU has carton data, but the position isn't carton-eligible
    const candidates = computeReplenishmentCandidates(rows, skuStock(1000), cartonQty);
    const { plan } = buildTransferPlan('RUN1', candidates, rows);

    expect(plan).toHaveLength(1);
    expect(plan[0].moveQty).toBe(3); // moves the small amount instead of being blocked
  });
});

test.describe('sourceAreaOf / groupBySourcePosition / chunkRows (export service)', () => {
  function planRow(overrides: Partial<TransferPlanRow> = {}): TransferPlanRow {
    return {
      runId: 'RUN1', sku: 'SKU1', sourcePosition: 'STORAGE-1', targetPosition: '01U-01-01',
      sourceQty: 1, targetQty: 1, targetZone: '01U-01', stockAtPosition: 0, totalWarehouseStock: 0,
      replenishableQty: 1, moveQty: 1, status: 'PLANNED', createdAt: '2026-01-01T00:00:00.000Z',
      ...overrides,
    };
  }

  test('sourceAreaOf maps a named building prefix to its friendly name', () => {
    expect(sourceAreaOf('PC-019')).toBe('ชั้นลอย');
    expect(sourceAreaOf('ZZZ-01-01')).toBe('ชั้นล่างสินค้าเข้าใหม่');
    expect(sourceAreaOf('PE-3')).toBe('ตึกใหม่');
    expect(sourceAreaOf('PH-2')).toBe('ชั้นล่าง');
    expect(sourceAreaOf('PA-5')).toBe('ชั้น5');
  });

  test('sourceAreaOf falls every unnamed prefix (3B, 01U, F02, ...) into one combined group', () => {
    for (const pos of ['3B-32', '01U-19', '02U-01', 'F01-05', 'F02-13', 'F03-01', 'CY-075', 'CB-01', 'CW-01', 'CR-01']) {
      expect(sourceAreaOf(pos)).toBe('ตำแหน่งหยิบ สินค้าขาย');
    }
  });

  test('groupBySourcePosition combines rows sharing the exact same source position, even across different target zones', () => {
    // Real bug (2026-08-26): two separate documents both sourced from PC-006
    // but went to different target zones (3B-28, 3B-27) — should be one document.
    const rows = [
      planRow({ targetZone: 'A', sourcePosition: 'PC-006' }),
      planRow({ targetZone: 'B', sourcePosition: 'PC-006' }), // different target zone, SAME source position -> same document
      planRow({ targetZone: 'A', sourcePosition: 'PC-010' }), // different source position -> separate document
    ];
    const groups = groupBySourcePosition(rows);
    expect(groups.size).toBe(2);
    expect(groups.get('PC-006')?.rows).toHaveLength(2);
    expect(groups.get('PC-010')?.rows).toHaveLength(1);
  });

  test('a single replenishment target split across two different source positions lands in two documents', () => {
    // buildTransferPlan can emit multiple rows for the same target when one source can't cover the need.
    const rows = [
      planRow({ targetZone: 'A', targetPosition: '01U-01-01', sourcePosition: 'PC-01', moveQty: 5 }),
      planRow({ targetZone: 'A', targetPosition: '01U-01-01', sourcePosition: '3B-05', moveQty: 3 }),
    ];
    const groups = groupBySourcePosition(rows);
    expect(groups.size).toBe(2);
  });

  test('chunkRows splits at the given max size', () => {
    const rows = Array.from({ length: 12001 }, () => planRow());
    const chunks = chunkRows(rows, 5000);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toHaveLength(5000);
    expect(chunks[2]).toHaveLength(2001);
  });

  test('chunkRows returns a single chunk when under the limit', () => {
    const rows = Array.from({ length: 10 }, () => planRow());
    expect(chunkRows(rows, 5000)).toHaveLength(1);
  });
});
