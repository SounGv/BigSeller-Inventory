import { SheetsClient } from '../sheets/sheets-client.js';
import { logger } from '../utils/logger.js';

/**
 * Which FLOOR a storage position sits on.
 *
 * The floor is read from the position code, never from the product's brand.
 * That distinction matters: the pick area named "FANTECH" is on floor 5, but
 * plenty of FAN-* products are stored in the "3FL Ugreen" area on floor 3, so
 * "FANTECH means floor 5" is true of the AREA and false of the BRAND. Picking
 * a wave by brand would send staff to the wrong floor.
 *
 * Prefixes confirmed against DB_LOCATION_CURRENT on 2026-09-12, where every
 * prefix below mapped to exactly one area with no overlap.
 */
const FLOOR_BY_POSITION_PREFIX: Record<string, string> = {
  // 3FL Ugreen
  '3B': 'ชั้น 3',
  '01U': 'ชั้น 3',
  '02U': 'ชั้น 3',
  CW: 'ชั้น 3',
  CR: 'ชั้น 3',
  CY: 'ชั้น 3',
  CB: 'ชั้น 3',
  // FANTECH
  F01: 'ชั้น 5',
  F02: 'ชั้น 5',
  F03: 'ชั้น 5',
  F07: 'ชั้น 5',
  '01F': 'ชั้น 5',
  PA: 'ชั้น 5',
  FANTECH: 'ชั้น 5',
  // Philips + Boya
  ZZHOME: 'ชั้น 5 (Philips+Boya)',
};

/** Positions that are not pick faces at all — stock there has to be moved before anyone can pick it. */
const NOT_A_PICK_FACE: Record<string, string> = {
  PC: 'Storage Area',
  PH: 'Storage Area',
  ZCN: 'Storage Area',
  ZZZZ: 'กองรอเข้าชั้น',
  JOYROOM: 'กองรอเข้าชั้น',
  PACKAGE: 'กองรอเข้าชั้น',
  GIFSET: 'กองรอเข้าชั้น',
  PF: 'Pallet',
  PE: 'Pallet',
  TEST: 'TEST-AREA',
};

export interface SkuLocation {
  floor: string | null;
  /** Set when the SKU's position is not a pick face — the reason, for the report. */
  blockedReason: string | null;
  position: string;
}

export type SkuFloorMap = ReadonlyMap<string, SkuLocation>;

export function floorForPosition(position: string): SkuLocation {
  const raw = position.trim();
  const prefix = raw.split(/[-\s(]/)[0].toUpperCase();
  const floor = FLOOR_BY_POSITION_PREFIX[prefix];
  if (floor) return { floor, blockedReason: null, position: raw };
  const blocked = NOT_A_PICK_FACE[prefix];
  if (blocked) return { floor: null, blockedReason: blocked, position: raw };
  return { floor: null, blockedReason: null, position: raw };
}

/**
 * SKU -> floor, from the location snapshot this repo already syncs.
 *
 * A SKU stocked at several positions keeps the first pick face found; a SKU
 * with no pick face keeps its blocked reason so the report can say WHY it
 * cannot be picked rather than just calling it unknown.
 */
export async function loadSkuFloors(tabName: string): Promise<SkuFloorMap> {
  const client = await SheetsClient.create();
  const rows = await client.readAll(tabName);
  const header = (rows[0] ?? []).map((cell) => cell.trim().toLowerCase());
  const skuIndex = header.indexOf('sku');
  const positionIndex = header.indexOf('position');
  const updatedIndex = header.indexOf('sourceupdatedat');
  if (skuIndex < 0 || positionIndex < 0) {
    throw new Error(`${tabName} has no "sku"/"position" columns — found: ${header.join(', ')}`);
  }

  const map = new Map<string, SkuLocation>();
  let newestSync = '';
  for (const row of rows.slice(1)) {
    const sku = (row[skuIndex] ?? '').trim().toUpperCase();
    if (!sku) continue;
    if (updatedIndex >= 0 && (row[updatedIndex] ?? '') > newestSync) newestSync = row[updatedIndex] ?? '';
    const found = floorForPosition(row[positionIndex] ?? '');
    const existing = map.get(sku);
    // A real pick face always beats a storage/piling position for the same SKU.
    if (!existing || (existing.floor === null && found.floor !== null)) map.set(sku, found);
  }
  await logger.info(`sku-floor: loaded ${map.size} SKU location(s) from ${tabName} (snapshot ${newestSync || 'unknown'})`);
  return map;
}

/**
 * SKU codes in a รายละเอียดสินค้า cell.
 *
 * BigSeller renders a copy link after every SKU ("SPK7448-PK คัดลอก สีชมพู …"),
 * so the token immediately BEFORE each "คัดลอก" is a SKU. Matching loose tokens
 * against the SKU map instead would let a price or a stock figure collide with
 * a numeric SKU — and this repo has 1,185 purely numeric SKUs.
 */
export function skusInProductCell(productCell: string): string[] {
  const skus: string[] = [];
  const segments = productCell.split('คัดลอก');
  for (const segment of segments.slice(0, -1)) {
    const tokens = segment.trim().split(/\s+/).filter(Boolean);
    const last = tokens[tokens.length - 1];
    if (last) skus.push(last.toUpperCase());
  }
  return skus;
}

export interface OrderFloors {
  floors: string[];
  blocked: { sku: string; reason: string }[];
  unknown: string[];
}

/**
 * The stocked SKU(s) behind a code that is sold under a different name.
 *
 * Two shapes seen in the live queue on 2026-09-12, 115 orders' worth:
 *  - "65573-SINGLE" / "75104-BOX-SINGLE" — a split-pack listing of one stocked
 *    SKU. The suffix is a selling unit, not a location.
 *  - "GIFT-25830-45063" — a gift set, which is picked as its COMPONENTS. This
 *    is the shape that matters most: a set whose parts sit on different floors
 *    is a cross-floor pick hiding behind a single code, and treating it as
 *    "unknown" is exactly how one would slip into a single-floor wave.
 *
 * A component with an "SR" suffix ("75701SR") keeps its base code too, since
 * that suffix marks a variant of the same stocked item.
 */
export function resolveSkuAliases(sku: string): string[] {
  const code = sku.toUpperCase();

  if (code.startsWith('GIFT-')) {
    return code
      .slice('GIFT-'.length)
      .split('-')
      .filter((part) => part && part !== 'SINGLE' && part !== 'BOX')
      .flatMap((part) => (/^\d+SR$/.test(part) ? [part, part.replace(/SR$/, '')] : [part]));
  }

  const withoutSellingUnit = code.replace(/-(BOX-)?SINGLE$/, '');
  return withoutSellingUnit === code ? [] : [withoutSellingUnit];
}

/** Which floor(s) one order has to be picked from. More than one = a picker changing floors. */
export function floorsForOrder(productCell: string, map: SkuFloorMap): OrderFloors {
  const floors = new Set<string>();
  const blocked: { sku: string; reason: string }[] = [];
  const unknown: string[] = [];
  for (const sku of skusInProductCell(productCell)) {
    // The code as listed first; only then what it is actually picked as. A
    // gift set resolves to several SKUs, and EVERY one of them counts — that
    // is what makes its cross-floor risk visible.
    const candidates = map.has(sku) ? [sku] : resolveSkuAliases(sku);
    const hits = candidates.map((candidate) => ({ candidate, found: map.get(candidate) }));
    if (hits.length === 0 || hits.every((hit) => !hit.found)) {
      unknown.push(sku);
      continue;
    }
    for (const { candidate, found } of hits) {
      if (!found) continue;
      if (found.floor) floors.add(found.floor);
      else blocked.push({ sku: candidate, reason: found.blockedReason ?? `ตำแหน่ง ${found.position}` });
    }
  }
  return { floors: [...floors].sort(), blocked, unknown };
}
