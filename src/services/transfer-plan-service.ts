import { SheetsClient } from '../sheets/sheets-client.js';
import type { TransferPlanRow, TransferExceptionRow } from '../types.js';
import { readRowsForRunId } from './run-data.js';

const SHEET_LOCATION_CURRENT = process.env.SHEET_LOCATION_CURRENT ?? 'DB_LOCATION_CURRENT';
const SHEET_SKU_INVENTORY = process.env.SHEET_SKU_INVENTORY ?? 'DB_SKU_INVENTORY';
const SHEET_TRANSFER_PLAN = process.env.SHEET_TRANSFER_PLAN ?? 'DB_TRANSFER_PLAN';
const SHEET_TRANSFER_EXCEPTION = process.env.SHEET_TRANSFER_EXCEPTION ?? 'TRANSFER_EXCEPTION';
const SHEET_SKU_CARTON_QTY = process.env.SHEET_SKU_CARTON_QTY ?? 'DB_SKU_CARTON_QTY';
const SHEET_PENDING_ORDER_DEMAND = process.env.SHEET_PENDING_ORDER_DEMAND ?? 'DB_PENDING_ORDER_DEMAND';
const SHEET_OFFLINE_LOCK = process.env.SHEET_OFFLINE_LOCK ?? 'DB_OFFLINE_LOCK';
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
 * Absolute floor on top of {@link MIN_REPLENISH_FRACTION_OF_MAX} — explicit
 * rule from the user (2026-08-27): "ถ้าน้อยเกินไปไม่ต้องเติม เช่น ตั้งสูงไว้ 30 ต่ำ 10
 * เติมได้แค่ 2-3 ตัวไม่ต้องเติม" (if the amount needed is too small, don't bother —
 * e.g. max=30, min=10, only 2-3 units needed, skip it). The existing
 * half-of-max rule already catches most of these, but not for a position with
 * a small `maxStock` (e.g. max=8, replenishableQty=5 clears the 50%-of-max
 * bar but is still not worth a transfer trip) — this is a separate, absolute
 * check on top of it.
 */
const MIN_REPLENISH_QTY = 5;

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
  /**
   * Optional target-zone prefix filter (e.g. "02U" or "F", case-insensitive)
   * — matched with `startsWith` against `position.split('-')[0]`, NOT an
   * exact match, so "F" alone covers F01+F02+F03 together (confirmed with the
   * user 2026-08-28: "F" means all three combined, not a literal zone named
   * just "F"). Added for the LINE command-bot's per-zone trigger (e.g.
   * "สร้างใบย้าย 02U ให้หน่อย"), see `line-command-bot.ts`. Undefined/omitted
   * means no filter — every zone is considered, same as before this existed.
   */
  targetZonePrefix?: string,
): ReplenishCandidate[] {
  const candidates: ReplenishCandidate[] = [];
  const normalizedZonePrefix = targetZonePrefix?.toUpperCase();

  for (const raw of locationRows) {
    const row = parseLocationRecord(raw);
    if (row.positionType !== TARGET_POSITION_TYPE) continue; // only a pick position can be a replenishment target
    if (isNoPickPosition(row.position)) continue; // can't replenish a position that doesn't physically exist
    if (isGiftPosition(row.position)) continue; // gift-with-purchase items — staff handle these by hand, never auto-planned
    if (normalizedZonePrefix && !row.position.split('-')[0].toUpperCase().startsWith(normalizedZonePrefix)) continue;

    const rawReplenishableQty = Math.max(0, row.maxStock - row.stockAtPosition);
    if (rawReplenishableQty <= 0) continue;
    if (rawReplenishableQty < row.maxStock * MIN_REPLENISH_FRACTION_OF_MAX) continue;
    if (rawReplenishableQty <= MIN_REPLENISH_QTY) continue;

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
 * Zone prefixes whose replenishment target should be sourced from "PC"
 * (ชั้นลอย, see `sourceAreaOf` in move-export-service.ts) positions before
 * anywhere else. Explicit rule from the user (2026-08-27): "ตำแหน่งจัดเก็บลังเศษ
 * ขึ้นต้นด้วย PC เทียบหาในตำแหน่ง PC ก่อนถ้าเป็นการเติมตำแหน่ง CR-CB-CY-CW-3B" — PC
 * positions hold loose/broken-carton (ลังเศษ) stock, which is the preferred
 * source for these five zones specifically. Matched on the target's zone
 * PREFIX (before the first hyphen), the same convention as
 * `CARTON_ZONE_PREFIXES` above.
 */
const PC_PRIORITY_TARGET_ZONE_PREFIXES = new Set(['CR', 'CB', 'CY', 'CW', '3B']);
const PC_SOURCE_ZONE_PREFIX = 'PC';

function prefersPcSource(targetPosition: string): boolean {
  return PC_PRIORITY_TARGET_ZONE_PREFIXES.has(targetPosition.split('-')[0]);
}


/**
 * Phase 4: storage/other positions of the same SKU that can actually give up
 * stock, sorted by POSITION CODE ascending (e.g. PC-036 before PC-116) —
 * explicit rule from the user (2026-08-27), given after seeing a real SKU
 * split evenly across two storage positions (PC-036, PC-116) that each had
 * plenty of stock: "ถ้ารุ่นไหนมีหลายตำแหน่งเก็บ ให้เลือกจากเลขที่น้อยกว่า เช่น PC-036-
 * PC-116" — always prefer the lower position code, regardless of how much
 * stock each side has. This SUPERSEDES an earlier "fullest source first, to
 * minimize line items" rule; that quantity-based ordering no longer applies.
 * `localeCompare` with `numeric: true` avoids the classic string-sort bug
 * where "PC-10" would otherwise sort before "PC-2".
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
 *
 * For a target in one of `PC_PRIORITY_TARGET_ZONE_PREFIXES`, PC positions are
 * tried FIRST (see {@link prefersPcSource}): if any PC source has movable
 * stock, only PC sources are returned (still ordered position-code ascending
 * among themselves) — otherwise this falls back to the full candidate list
 * below, same as every other zone.
 */
export function findSourcePositions(sku: string, targetPosition: string, locationRows: Record<string, string>[]): SourceCandidate[] {
  const allSources = locationRows
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
    .sort((a, b) => a.position.localeCompare(b.position, undefined, { numeric: true, sensitivity: 'base' }));

  if (prefersPcSource(targetPosition)) {
    const pcSources = allSources.filter((c) => c.position.split('-')[0] === PC_SOURCE_ZONE_PREFIX);
    if (pcSources.length > 0) return pcSources;
  }

  return allSources;
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

    // Per explicit user request (2026-09-08), clarified same day after a
    // real created document still produced an awkward "2 ชิ้น" line despite
    // an earlier fix attempt: "ถ้าแบบนี้ไม่ต้องปัดออกเลย เอาตำแหน่งเดียว
    // แค่ 2 ตัวเองจะไปแกะลังใหม่ทำไม" (don't round it in like that — just
    // use ONE position; why would staff open a fresh carton for just 2
    // units?). The first fix only dropped a line that was ALREADY below 1
    // carton before totaling — it missed the case where two lines individually
    // clear 1 carton each (e.g. PC-037:18 + ZZZZ:11 = 29, both >= the 10-unit
    // carton) but the OLD combined-total floor (29 -> 20) then trimmed the
    // excess off the LAST row added, carving ZZZZ down from 11 to 2 — the
    // exact fragment this rule exists to prevent, just reached a different
    // way. Floor EACH source line independently to its own whole-carton
    // multiple instead: a line is either kept at its own rounded-down value
    // or dropped to 0 if that's less than 1 carton — never partially eaten
    // into to top up because a *different* line came up short. No
    // cross-line borrowing, ever, hence "เอาตำแหน่งเดียว" — each position's
    // contribution stands on its own.
    let finalRows = candidateRows;
    if (candidate.cartonQty) {
      const cartonQty = candidate.cartonQty;
      finalRows = candidateRows
        .map((r) => {
          const flooredQty = Math.floor(r.moveQty / cartonQty) * cartonQty;
          return flooredQty === r.moveQty ? r : { ...r, sourceQty: flooredQty, targetQty: flooredQty, moveQty: flooredQty };
        })
        .filter((r) => r.moveQty > 0);
    }
    const effectiveTotal = finalRows.reduce((sum, r) => sum + r.moveQty, 0);

    // Per explicit user request (2026-08-26): a carton-eligible target must
    // never receive a part-carton move just because that's all any one
    // source could give up — logged whenever per-line flooring above
    // actually changed anything (dropped a line to 0, or shaved a line
    // down), whether or not anything is left to move at all.
    if (candidate.cartonQty && effectiveTotal < totalMoved) {
      exceptions.push({
        runId,
        sku: candidate.sku,
        targetPosition: candidate.targetPosition,
        replenishableQty: candidate.replenishableQty,
        warehouseRemainingQty: candidate.warehouseRemainingQty,
        reason:
          effectiveTotal === 0
            ? `มีของแค่ ${totalMoved} ชิ้น ไม่มีตำแหน่งต้นทางไหนให้ครบ 1 ลัง (${candidate.cartonQty} ชิ้น/ลัง) เลยสักตำแหน่ง จึงไม่สร้างใบย้าย`
            : `แต่ละตำแหน่งต้นทางปัดลงเป็นลังเต็มแยกกัน (${candidate.cartonQty} ชิ้น/ลัง) — ย้ายจริง ${effectiveTotal} ชิ้น จากที่มี ${totalMoved} ชิ้น ส่วนที่เหลือไม่ถึงลังจึงไม่ย้าย`,
        recordedAt: createdAt,
      });
      if (effectiveTotal === 0) continue;
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

/**
 * Subtracts unconfirmed online demand and confirmed offline holds off
 * `availableWarehouseStock` before replenishment math runs — added
 * 2026-08-31 (FEATURE-pending-demand-and-offline-lock.md) because
 * `availableWarehouseStock` as synced from BigSeller only ever excludes
 * CONFIRMED orders, so a new online order still sitting in "คำสั่งซื้อใหม่"
 * (not yet confirmed) or stock reserved via a LockStock hold (GV's mandatory
 * offline-sale-hold workaround, see order-demand-service.ts) both looked
 * "still available" and could get planned for an internal move that then
 * had nothing left to actually move.
 *
 * `offlineLockBySku` must be pre-filtered to `lockStatus === 'confirmed'`
 * only — a `pending_confirm` hold ("จองรอลูกค้าคอนเฟิร์ม", not yet a sure
 * sale) is deliberately NOT subtracted (explicit user decision, 2026-08-31,
 * reversing an earlier "subtract both the same" agreement): the accepted
 * trade-off is that stock can briefly still show as available if a
 * pending-confirm hold turns into a real sale between two sync cycles,
 * rather than tying up stock for a hold that might never be confirmed.
 *
 * Only ever REDUCES `availableWarehouseStock` — never touches
 * `totalWarehouseStock` or any other field, and never below zero.
 */
export function computeEffectiveAvailableStock(
  skuWarehouseStockBySku: Map<string, SkuWarehouseStock>,
  pendingDemandBySku: Map<string, number>,
  offlineLockBySku: Map<string, number>,
): Map<string, SkuWarehouseStock> {
  const result = new Map<string, SkuWarehouseStock>();
  for (const [sku, stock] of skuWarehouseStockBySku) {
    const pending = pendingDemandBySku.get(sku) ?? 0;
    const locked = offlineLockBySku.get(sku) ?? 0;
    result.set(sku, {
      ...stock,
      availableWarehouseStock: Math.max(0, stock.availableWarehouseStock - pending - locked),
    });
  }
  return result;
}

/** Sums `qty` per `sku` from DB_PENDING_ORDER_DEMAND (current-state sheet, no runId column — see SheetsClient.replaceAll) — every row counts, this sheet has no status field to filter on. */
async function readPendingDemandBySku(sheetsClient: SheetsClient): Promise<Map<string, number>> {
  const rows = await sheetsClient.readAll(SHEET_PENDING_ORDER_DEMAND);
  return sumQtyBySku(rows, 'sku', 'qty');
}

/** Sums `qty` per `sku` from DB_OFFLINE_LOCK, keeping ONLY `lockStatus === 'confirmed'` rows — see the doc comment on {@link computeEffectiveAvailableStock} for why `pending_confirm` is deliberately excluded here. */
async function readOfflineLockBySku(sheetsClient: SheetsClient): Promise<Map<string, number>> {
  const rows = await sheetsClient.readAll(SHEET_OFFLINE_LOCK);
  if (rows.length < 2) return new Map();
  const header = rows[0];
  const statusIdx = header.indexOf('lockStatus');
  const confirmedOnly = statusIdx === -1 ? rows : [header, ...rows.slice(1).filter((r) => r[statusIdx] === 'confirmed')];
  return sumQtyBySku(confirmedOnly, 'sku', 'qty');
}

function sumQtyBySku(rows: string[][], skuCol: string, qtyCol: string): Map<string, number> {
  const map = new Map<string, number>();
  if (rows.length < 2) return map;
  const header = rows[0];
  const skuIdx = header.indexOf(skuCol);
  const qtyIdx = header.indexOf(qtyCol);
  if (skuIdx === -1 || qtyIdx === -1) return map;

  for (const row of rows.slice(1)) {
    const sku = row[skuIdx]?.trim();
    const qty = Number(row[qtyIdx]);
    if (!sku || !Number.isFinite(qty)) continue;
    map.set(sku, (map.get(sku) ?? 0) + qty);
  }
  return map;
}

/**
 * Orchestrates Phase 3+4+5 end to end for one runId: read → calculate → write.
 *
 * `targetZonePrefix` (optional) narrows replenishment to one zone only — e.g.
 * "02U" covers every pick position starting with that prefix (02U-01, 02U-02,
 * 02U-03, ...), confirmed with the user (2026-08-27) to be exactly the
 * intended meaning. Added for the LINE command-bot's per-zone trigger; every
 * other caller (the plain `npm run plan:moves` script, existing tests) omits
 * it and keeps planning every zone, unchanged from before this existed.
 */
export async function planMoves(
  sheetsClient: SheetsClient,
  runId: string,
  targetZonePrefix?: string,
): Promise<{ plan: TransferPlanRow[]; exceptions: TransferExceptionRow[] }> {
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
  const pendingDemandBySku = await readPendingDemandBySku(sheetsClient);
  const offlineLockBySku = await readOfflineLockBySku(sheetsClient);
  const effectiveStockBySku = computeEffectiveAvailableStock(skuWarehouseStockBySku, pendingDemandBySku, offlineLockBySku);

  const candidates = computeReplenishmentCandidates(locationRows, effectiveStockBySku, cartonQtyBySku, targetZonePrefix);
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
