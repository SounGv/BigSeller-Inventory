import { SheetsClient } from '../sheets/sheets-client.js';
import type { TransferPlanRow, TransferExceptionRow } from '../types.js';
import { readRowsForRunId } from './run-data.js';

const SHEET_LOCATION_CURRENT = process.env.SHEET_LOCATION_CURRENT ?? 'DB_LOCATION_CURRENT';
const SHEET_SKU_INVENTORY = process.env.SHEET_SKU_INVENTORY ?? 'DB_SKU_INVENTORY';
const SHEET_TRANSFER_PLAN = process.env.SHEET_TRANSFER_PLAN ?? 'DB_TRANSFER_PLAN';
const SHEET_TRANSFER_EXCEPTION = process.env.SHEET_TRANSFER_EXCEPTION ?? 'TRANSFER_EXCEPTION';
const SHEET_SKU_CARTON_QTY = process.env.SHEET_SKU_CARTON_QTY ?? 'DB_SKU_CARTON_QTY';
const WAREHOUSE_NAME = process.env.INVENTORY_WAREHOUSE_NAME ?? 'STOCK_5';
const NO_PICK_POSITION_MARKER = 'ไม่มีตำแหน่งหยิบ';
/**
 * Gift-with-purchase items ("ของแถม") — per user request (2026-08-25):
 * "พวกของแถม ไม่ต้องทำใบย้าย จะใช้ค่อยให้พนักงานทำเอง" (don't auto-generate
 * transfer documents for gift items — staff will move them by hand when
 * actually needed). Confirmed live against real synced data: there is
 * exactly one dedicated pick/storage pair carrying this marker in their
 * position name — "FANTECH-หยิบ-ของแถม" (pick) and "FANTECH-จัดเก็บ-ของแถม"
 * (storage) — not a per-SKU attribute, so matching on the position name
 * (same pattern as `NO_PICK_POSITION_MARKER` above) is sufficient. Excluded
 * on both sides: never a replenishment target, never a source to draw from.
 */
const GIFT_POSITION_MARKER = 'ของแถม';

/**
 * Zones whose positions can physically hold a full unopened carton — per
 * user request (2026-08-25): "ตำแหน่งที่วางทั้งลังได้" turned out, after
 * clarifying, to just mean "every position in these 5 zones", not a specific
 * list of ~400 individual position codes (which would be fragile to keep in
 * sync and error-prone to type — the pasted list already had typos like a
 * lowercase "f01-06-12" and duplicate entries). A position's zone prefix
 * (the part before the first hyphen, e.g. "01U" in "01U-01-01") decides
 * eligibility, not the full position string.
 */
const CARTON_ZONE_PREFIXES = new Set(['01U', '02U', 'F01', 'F02', 'F03']);

function isCartonEligiblePosition(position: string): boolean {
  return CARTON_ZONE_PREFIXES.has(position.split('-')[0]);
}

/**
 * Rounds `qty` to the nearest whole multiple of `cartonSize` — exactly half
 * a carton rounds up. Per user request (2026-08-25): "ปัดตามเศษ (≥ครึ่งลัง
 * ปัดขึ้น)" — e.g. needing 45 units at 10/carton rounds to 5 cartons (50),
 * needing 44 rounds to 4 cartons (40). Deliberately allowed to round the
 * final quantity above `maxStock` or below it — the user explicitly chose
 * this over a "never exceed max" / "never go under" rule.
 */
export function roundToCartonMultiple(qty: number, cartonSize: number): number {
  if (cartonSize <= 0) return qty;
  return Math.round(qty / cartonSize) * cartonSize;
}

/**
 * A replenishment move must only ever go storage → pick, never pick → pick
 * or pick → storage or storage → storage. Explicit rule from the user
 * (2026-08-25), given after reviewing real transfer documents this feature
 * had already created: "อย่าย้ายตำแหน่งเก็บเข้าตำแหน่งเก็บเหมือนกัน และอย่าย้าย
 * ตำแหน่งหยิบเข้าตำแหน่งเก็บ (ต้องเป็น ย้ายจากตำแหน่งจัดเก็บเข้าตำแหน่งหยิบ)" — a
 * target (`computeReplenishmentCandidates`) must be a pick position, and a
 * source (`findSourcePositions`) must be a storage position. Neither function
 * checked `positionType` at all before this — `locationRows` mixes both
 * types together (synced as "location (pick + storage)"), so without this
 * filter a source could be pulled from another pick bin, silently draining
 * one pick position to fill another instead of restocking from storage.
 *
 * The source side is checked as "not a pick position" rather than an exact
 * match against a storage-type label string. Confirmed live (2026-08-25) by
 * dumping real synced rows for one runId: the actual `positionType` value
 * BigSeller's export uses for storage rows is "ตำแหน่งเก็บสินค้า" — different
 * from `SOURCE_POSITION_TYPE_NAME` ("ตำแหน่งจัดเก็บสินค้า", with "จัด"), which is
 * the correct value for its OTHER job of driving BigSeller's UI filter
 * dropdown in `sync-service.ts`. Those are two different strings for the
 * same concept in two different parts of BigSeller's own UI/data — matching
 * "not pick" avoids depending on getting the storage label spelling right.
 */
const TARGET_POSITION_TYPE = process.env.INVENTORY_POSITION_TYPE_NAME ?? 'ตำแหน่งหยิบสินค้า';

const TRANSFER_PLAN_HEADERS = [
  'runId', 'sku', 'sourcePosition', 'targetPosition', 'sourceQty', 'targetQty', 'targetZone',
  'stockAtPosition', 'totalWarehouseStock', 'replenishableQty', 'moveQty', 'status', 'createdAt',
] as const;

const TRANSFER_EXCEPTION_HEADERS = [
  'runId', 'sku', 'targetPosition', 'replenishableQty', 'warehouseRemainingQty', 'reason', 'recordedAt',
] as const;

interface LocationRecord {
  sku: string;
  area: string;
  position: string;
  positionType: string;
  stockAtPosition: number;
  availableStock: number;
  minStock: number;
  maxStock: number;
}

function parseLocationRecord(row: Record<string, string>): LocationRecord {
  return {
    sku: row.sku,
    area: row.area,
    position: row.position,
    positionType: row.positionType,
    stockAtPosition: toNumber(row.stockAtPosition),
    availableStock: toNumber(row.availableStock),
    minStock: toNumber(row.minStock),
    maxStock: toNumber(row.maxStock),
  };
}

function toNumber(value: string | undefined): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function isNoPickPosition(position: string): boolean {
  return position.includes(NO_PICK_POSITION_MARKER);
}

function isGiftPosition(position: string): boolean {
  return position.includes(GIFT_POSITION_MARKER);
}

/** "01U-01-01" -> "01U-01". A position with no hyphen (shouldn't happen for real pick/storage positions once no-pick placeholders are filtered) falls back to itself. */
export function zoneOf(position: string): string {
  const idx = position.lastIndexOf('-');
  return idx === -1 ? position : position.slice(0, idx);
}

export interface ReplenishCandidate {
  sku: string;
  targetPosition: string;
  targetZone: string;
  stockAtPosition: number;
  maxStock: number;
  totalWarehouseStock: number;
  availableWarehouseStock: number;
  replenishableQty: number;
  warehouseRemainingQty: number;
  /** Set only for a carton-eligible target with a known carton size — lets buildTransferPlan enforce "don't move less than a full carton" below. */
  cartonQty?: number;
}

export interface SkuWarehouseStock {
  totalWarehouseStock: number;
  /** "สต็อกพร้อมขายในคลัง" — totalWarehouseStock minus stock already locked/reserved against pending orders warehouse-wide. */
  availableWarehouseStock: number;
}

/**
 * Minimum fraction of maxStock that replenishableQty must reach before a
 * position is worth sending a transfer crew to. Explicit rule from the user
 * (2026-08-25): "ถ้าตำแหน่งที่ส่งบอกช่องเติมได้มีน้อยกว่าไม่ถึงครึ่งช่องที่ตั้งใส่ได้สูงสุด
 * ไม่ต้องดึงไปย้าย" — if a position's replenishableQty is less than half of
 * its maxStock (i.e. the position is still more than half full), skip it;
 * don't bother topping off a bin that isn't meaningfully depleted yet.
 */
const MIN_REPLENISH_FRACTION_OF_MAX = 0.5;

/**
 * Phase 3: pick positions that both need stock AND have stock available
 * somewhere in the warehouse to draw from.
 *
 * `warehouseRemainingQty` is deliberately based on `availableWarehouseStock`
 * (BigSeller's "สต็อกพร้อมขายในคลัง" — totalWarehouseStock minus stock already
 * locked against pending orders warehouse-wide), not `totalWarehouseStock`.
 * Explicit rule from the user (2026-08-25): "ดูช่องเติมได้ รายการสินค้าคงคลัง
 * มีเท่าไหร่ ติดจองไหม ถ้าจองไม่ต้องดึงย้าย" — before counting a SKU's overall
 * warehouse stock as a source to pull from, check whether it's reserved
 * against an order; reserved stock must never be planned for an internal
 * replenishment move. This is a separate, SKU-wide/order-level lock from the
 * position-level lock already handled in `findSourcePositions` below (which
 * excludes a specific position's own lockedStock via `availableStock`).
 */
export function computeReplenishmentCandidates(
  locationRows: Record<string, string>[],
  skuWarehouseStockBySku: Map<string, SkuWarehouseStock>,
  cartonQtyBySku: Map<string, number> = new Map(),
): ReplenishCandidate[] {
  const candidates: ReplenishCandidate[] = [];

  for (const raw of locationRows) {
    const row = parseLocationRecord(raw);
    if (row.positionType !== TARGET_POSITION_TYPE) continue; // only a pick position can be a replenishment target
    if (isNoPickPosition(row.position)) continue; // can't replenish a position that doesn't physically exist
    if (isGiftPosition(row.position)) continue; // gift-with-purchase items — staff handle these by hand, never auto-planned

    const rawReplenishableQty = Math.max(0, row.maxStock - row.stockAtPosition);
    if (rawReplenishableQty <= 0) continue;
    if (rawReplenishableQty < row.maxStock * MIN_REPLENISH_FRACTION_OF_MAX) continue;

    // Carton rounding only applies to zones that can physically hold a full
    // carton, and only when this SKU has a known carton size — a SKU with no
    // row in DB_SKU_CARTON_QTY (the common case until someone fills it in)
    // keeps the normal per-unit quantity unchanged.
    let replenishableQty = rawReplenishableQty;
    let cartonQty: number | undefined;
    if (isCartonEligiblePosition(row.position)) {
      const knownCartonQty = cartonQtyBySku.get(row.sku);
      if (knownCartonQty && knownCartonQty > 1) {
        cartonQty = knownCartonQty;
        replenishableQty = roundToCartonMultiple(rawReplenishableQty, cartonQty);
        if (replenishableQty <= 0) continue; // rounded down to zero cartons — nothing to do this round
      }
    }

    const { totalWarehouseStock = 0, availableWarehouseStock = 0 } = skuWarehouseStockBySku.get(row.sku) ?? {};
    const warehouseRemainingQty = Math.max(0, availableWarehouseStock - row.stockAtPosition);
    if (warehouseRemainingQty <= 0) continue;

    candidates.push({
      sku: row.sku,
      targetPosition: row.position,
      targetZone: zoneOf(row.position),
      stockAtPosition: row.stockAtPosition,
      maxStock: row.maxStock,
      totalWarehouseStock,
      availableWarehouseStock,
      replenishableQty,
      warehouseRemainingQty,
      cartonQty,
    });
  }

  return candidates;
}

export interface SourceCandidate {
  position: string;
  sourceMovableQty: number;
}

/**
 * Phase 4: storage/other positions of the same SKU that can actually give up
 * stock, sorted so the fullest position is drawn from first (fewest resulting
 * line items).
 *
 * Confirmed against real synced data (2026-08-25) and explicitly requested by
 * the user to stay this way: `availableStock` (สต็อกพร้อมขายของตำแหน่ง) is
 * already `stockAtPosition - lockedStock` on BigSeller's own export — e.g. a
 * real row read stockAtPosition=146, lockedStock=98, availableStock=48. So
 * building `sourceMovableQty` from `availableStock` (not `stockAtPosition`)
 * already means locked stock is never offered as a source, and `moveQty`
 * (in buildTransferPlan below) is capped at whatever's actually free — if the
 * target's `replenishableQty` asks for more than any unlocked source can
 * give, the plan moves the smaller unlocked amount instead of failing or
 * ignoring the lock. Do not switch this to `stockAtPosition`.
 */
export function findSourcePositions(sku: string, targetPosition: string, locationRows: Record<string, string>[]): SourceCandidate[] {
  return locationRows
    .map(parseLocationRecord)
    .filter((row) =>
      row.sku === sku &&
      row.positionType !== TARGET_POSITION_TYPE && // only a non-pick (storage) position can be a source — never another pick bin
      row.position !== targetPosition &&
      !isNoPickPosition(row.position) &&
      !isGiftPosition(row.position) &&
      row.availableStock > 0,
    )
    .map((row) => ({ position: row.position, sourceMovableQty: Math.max(0, row.availableStock - row.minStock) }))
    .filter((c) => c.sourceMovableQty > 0)
    .sort((a, b) => b.sourceMovableQty - a.sourceMovableQty);
}

/**
 * Removes `excess` units total off the END of `rows` (last row first) —
 * dropping a row entirely once its own moveQty is consumed, or shrinking the
 * final row that only needs a partial cut. Used to floor a carton-eligible
 * candidate's total moved quantity down to a whole-carton multiple without
 * disturbing the earlier (larger-source) rows.
 */
function trimTrailingQty(rows: TransferPlanRow[], excess: number): TransferPlanRow[] {
  const kept: TransferPlanRow[] = [];
  let remaining = excess;
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    if (remaining <= 0) {
      kept.unshift(row);
    } else if (row.moveQty <= remaining) {
      remaining -= row.moveQty; // drop this row entirely
    } else {
      const reducedQty = row.moveQty - remaining;
      kept.unshift({ ...row, sourceQty: reducedQty, targetQty: reducedQty, moveQty: reducedQty });
      remaining = 0;
    }
  }
  return kept;
}

/** Phase 4+5: walks each candidate's source list, splitting across multiple source positions if one alone can't cover the need. */
export function buildTransferPlan(
  runId: string,
  candidates: ReplenishCandidate[],
  locationRows: Record<string, string>[],
): { plan: TransferPlanRow[]; exceptions: TransferExceptionRow[] } {
  const plan: TransferPlanRow[] = [];
  const exceptions: TransferExceptionRow[] = [];
  const createdAt = new Date().toISOString();

  for (const candidate of candidates) {
    const sources = findSourcePositions(candidate.sku, candidate.targetPosition, locationRows);
    if (sources.length === 0) {
      exceptions.push({
        runId,
        sku: candidate.sku,
        targetPosition: candidate.targetPosition,
        replenishableQty: candidate.replenishableQty,
        warehouseRemainingQty: candidate.warehouseRemainingQty,
        reason: 'ไม่พบตำแหน่งต้นทางที่มีสต็อกว่างให้ย้าย',
        recordedAt: createdAt,
      });
      continue;
    }

    let remainingNeed = Math.min(candidate.replenishableQty, candidate.warehouseRemainingQty);
    const candidateRows: TransferPlanRow[] = [];
    let totalMoved = 0;
    for (const source of sources) {
      if (remainingNeed <= 0) break;
      const moveQty = Math.min(remainingNeed, source.sourceMovableQty);
      if (moveQty <= 0) continue;

      candidateRows.push({
        runId,
        sku: candidate.sku,
        sourcePosition: source.position,
        targetPosition: candidate.targetPosition,
        sourceQty: moveQty,
        targetQty: moveQty,
        targetZone: candidate.targetZone,
        stockAtPosition: candidate.stockAtPosition,
        totalWarehouseStock: candidate.totalWarehouseStock,
        replenishableQty: candidate.replenishableQty,
        moveQty,
        status: 'PLANNED',
        createdAt,
      });
      totalMoved += moveQty;
      remainingNeed -= moveQty;
    }

    // Per explicit user request (2026-08-26), after a real live run moved
    // just 14 of a SKU whose carton size is 88 (all the source position had
    // available — "ถ้าไม่ถึงลัง ไม่ต้องสร้างใบย้าย", if it doesn't reach a full
    // carton, don't create the transfer document at all): a carton-eligible
    // target must never receive a part-carton move just because that's all
    // the source(s) could give up. Checked against the TOTAL across every
    // source line for this candidate, not per-line, since a split across two
    // sources can still legitimately sum to a full carton.
    if (candidate.cartonQty && totalMoved < candidate.cartonQty) {
      exceptions.push({
        runId,
        sku: candidate.sku,
        targetPosition: candidate.targetPosition,
        replenishableQty: candidate.replenishableQty,
        warehouseRemainingQty: candidate.warehouseRemainingQty,
        reason: `ย้ายได้รวม ${totalMoved} ชิ้น ไม่ถึง 1 ลัง (${candidate.cartonQty} ชิ้น/ลัง) จึงไม่สร้างใบย้าย`,
        recordedAt: createdAt,
      });
      continue;
    }

    // The check above only caught the case where NOTHING reaches a full
    // carton. What's actually available can clear that bar and still not be
    // a clean multiple — e.g. sources gave 239 of a SKU whose carton size is
    // 50 (4.78 cartons), confirmed live (2026-08-26) across 18 rows in one
    // real test run. Floor the total down to the nearest whole-carton
    // multiple and trim the leftover off the LAST rows added (sources were
    // tried largest-first, so this drops from the smallest/last-resort
    // source first, leaving the bigger ones untouched).
    let finalRows = candidateRows;
    if (candidate.cartonQty) {
      const flooredTotal = Math.floor(totalMoved / candidate.cartonQty) * candidate.cartonQty;
      const excess = totalMoved - flooredTotal;
      if (excess > 0) {
        finalRows = trimTrailingQty(candidateRows, excess);
        exceptions.push({
          runId,
          sku: candidate.sku,
          targetPosition: candidate.targetPosition,
          replenishableQty: candidate.replenishableQty,
          warehouseRemainingQty: candidate.warehouseRemainingQty,
          reason: `ย้ายได้รวม ${totalMoved} ชิ้น ปัดเหลือ ${flooredTotal} ชิ้น (${flooredTotal / candidate.cartonQty} ลัง) — ส่วนเกิน ${excess} ชิ้นไม่ถึงลังถัดไป ไม่ย้าย`,
          recordedAt: createdAt,
        });
      }
    }

    plan.push(...finalRows);

    if (remainingNeed > 0) {
      exceptions.push({
        runId,
        sku: candidate.sku,
        targetPosition: candidate.targetPosition,
        replenishableQty: candidate.replenishableQty,
        warehouseRemainingQty: candidate.warehouseRemainingQty,
        reason: `ตำแหน่งต้นทางรวมกันย้ายได้ไม่พอ (ขาดอีก ${remainingNeed})`,
        recordedAt: createdAt,
      });
    }
  }

  return { plan, exceptions };
}

/**
 * Reads the manually-maintained `DB_SKU_CARTON_QTY` reference sheet (sku,
 * unitsPerCarton — not runId-stamped, it's an evergreen table someone edits
 * directly in Sheets, not synced from BigSeller). Missing/blank/non-numeric
 * values are simply omitted from the map, which callers treat as "use normal
 * per-unit behavior for this SKU."
 */
async function readCartonQtyBySku(sheetsClient: SheetsClient): Promise<Map<string, number>> {
  const rows = await sheetsClient.readAll(SHEET_SKU_CARTON_QTY);
  const map = new Map<string, number>();
  if (rows.length < 2) return map;

  const header = rows[0];
  const skuIdx = header.indexOf('sku');
  const qtyIdx = header.indexOf('unitsPerCarton');
  if (skuIdx === -1 || qtyIdx === -1) return map;

  for (const row of rows.slice(1)) {
    const sku = row[skuIdx]?.trim();
    const qty = Number(row[qtyIdx]);
    if (sku && Number.isFinite(qty) && qty > 0) map.set(sku, qty);
  }
  return map;
}

/** Orchestrates Phase 3+4+5 end to end for one runId: read → calculate → write. */
export async function planMoves(sheetsClient: SheetsClient, runId: string): Promise<{ plan: TransferPlanRow[]; exceptions: TransferExceptionRow[] }> {
  const locationRows = (await readRowsForRunId(sheetsClient, SHEET_LOCATION_CURRENT, runId)).filter((r) => r.warehouse === WAREHOUSE_NAME);
  const skuRows = await readRowsForRunId(sheetsClient, SHEET_SKU_INVENTORY, runId);

  const skuWarehouseStockBySku = new Map<string, SkuWarehouseStock>();
  for (const row of skuRows) {
    if (row.warehouse === WAREHOUSE_NAME) {
      skuWarehouseStockBySku.set(row.sku, {
        totalWarehouseStock: toNumber(row.totalWarehouseStock),
        availableWarehouseStock: toNumber(row.availableWarehouseStock),
      });
    }
  }

  const cartonQtyBySku = await readCartonQtyBySku(sheetsClient);

  const candidates = computeReplenishmentCandidates(locationRows, skuWarehouseStockBySku, cartonQtyBySku);
  const { plan, exceptions } = buildTransferPlan(runId, candidates, locationRows);

  if (plan.length > 0) {
    await sheetsClient.upsertRows(
      SHEET_TRANSFER_PLAN,
      plan.map((p) => ({ ...p, key: `${p.runId}::${p.sku}::${p.sourcePosition}::${p.targetPosition}` })),
      { headers: [...TRANSFER_PLAN_HEADERS], keyColumns: ['runId', 'sku', 'sourcePosition', 'targetPosition'] },
    );
  }
  if (exceptions.length > 0) {
    await sheetsClient.appendRows(
      SHEET_TRANSFER_EXCEPTION,
      exceptions.map((e) => TRANSFER_EXCEPTION_HEADERS.map((h) => e[h])),
    );
  }

  return { plan, exceptions };
}
