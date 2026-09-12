import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { logger } from '../utils/logger.js';

const STATE_DIR = process.env.WAVE_ENGINE_STATE_DIR ?? './logs';
const STATE_FILE = 'wave-engine-state.json';

interface WaveState {
  /** Carrier title -> ISO timestamp of the last wave this engine created for it. */
  lastWaveAt: Record<string, string>;
}

/**
 * Remembers when each carrier was last waved, so the "batch for half an hour,
 * then create once" rule survives a restart.
 *
 * Kept in a file rather than memory because the engine is routinely run as
 * one-shot cycles (`--once`, `--fast`) as well as a daemon: an in-memory
 * timestamp would reset on every invocation and the interval would never
 * actually hold anything back.
 *
 * A missing or unreadable file is treated as "never waved" — the engine then
 * waves on its next eligible cycle, which is the safe direction to fail
 * (nothing gets stranded; at worst one wave goes out earlier than the
 * interval intended).
 */
export async function readWaveState(): Promise<WaveState> {
  try {
    const raw = await readFile(path.join(STATE_DIR, STATE_FILE), 'utf8');
    const parsed = JSON.parse(raw) as Partial<WaveState>;
    return { lastWaveAt: parsed.lastWaveAt ?? {} };
  } catch {
    return { lastWaveAt: {} };
  }
}

export async function recordWaveCreated(carrier: string, at: Date = new Date()): Promise<void> {
  const state = await readWaveState();
  state.lastWaveAt[carrier] = at.toISOString();
  try {
    await mkdir(STATE_DIR, { recursive: true });
    await writeFile(path.join(STATE_DIR, STATE_FILE), `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  } catch (error) {
    // Losing the timestamp only means the next cycle may wave sooner than the
    // interval wanted — worth a warning, not worth failing a cycle that has
    // already created a real wave.
    await logger.warn(`wave-engine: could not save wave state — ${(error as Error).message}`);
  }
}

/**
 * How many parcels make one trip worth it for a given wave type.
 *
 * A single-SKU parcel is grab-and-pack, so a picker clears many per round; a
 * multi-SKU parcel has to be picked and sorted per order, so the same round
 * holds far fewer. Told 2026-09-11: "คู่ 20 ออเดอร์ เดียว 50 ออเดอร์".
 *
 * BigSeller labels the row "รวมประเภทเดี่ยว ..." for the batched single-SKU
 * type and "สินค้าหลายชนิด/ชิ้น" for multi-SKU. Anything unrecognised takes
 * the SMALLER threshold, so an unknown type errs towards waving sooner rather
 * than sitting forever.
 */
export function minParcelsForWaveType(
  waveType: string,
  thresholds: { single: number; multi: number },
): { min: number; kind: 'single' | 'multi' } {
  if (waveType.includes('ประเภทเดี่ยว')) return { min: thresholds.single, kind: 'single' };
  return { min: thresholds.multi, kind: 'multi' };
}

/**
 * Decides whether a carrier's parcels should be waved now.
 *
 * Two ways to qualify, per the user's rules of 2026-09-11:
 *  - `parcels >= minParcels` — a full enough load goes straight away
 *    ("สแกนดู 15-20 ออเดอร์ ค่อยสร้าง"); no reason to make it wait.
 *  - the batching window has elapsed — collect for `intervalMinutes` and then
 *    send whatever accumulated in one go ("ครึ่งชั่วโมง ค่อยดึงมาสร้างที").
 *    This is what stops a wave per trickled-in order: the live waves on
 *    2026-09-11 came out as 1, 1 and 4 parcels, three separate trips upstairs
 *    for 13 items.
 *
 * Never qualifies on zero parcels.
 */
export function shouldWaveNow(params: {
  parcels: number;
  minParcels: number;
  intervalMinutes: number;
  lastWaveAt: string | undefined;
  now: Date;
}): { wave: boolean; reason: string } {
  const { parcels, minParcels, intervalMinutes, lastWaveAt, now } = params;
  if (parcels <= 0) return { wave: false, reason: 'nothing waveable' };

  if (parcels >= minParcels) {
    return { wave: true, reason: `${parcels} parcel(s) >= ${minParcels} — a full load, waving now` };
  }

  if (!lastWaveAt) {
    return {
      wave: false,
      reason: `${parcels} parcel(s) under ${minParcels}, and this carrier has no previous wave to measure a ${intervalMinutes}-minute window from — holding for the next cycle`,
    };
  }

  const elapsedMinutes = (now.getTime() - new Date(lastWaveAt).getTime()) / 60000;
  if (elapsedMinutes >= intervalMinutes) {
    // Waiting lowers the bar; it never removes it. The window exists so a
    // steady trickle still goes out, not so that a wave of two parcels gets
    // created because half an hour passed — that is a picker walking up a
    // floor for two items, which is the thing this whole engine is meant to
    // stop ("จำนวนน้อยอย่าสร้างนะ", and staff picking 1-2 at a time is the
    // problem being solved, restated 2026-09-12).
    if (parcels < minParcels) {
      return {
        wave: false,
        reason: `${parcels} parcel(s) still under the ${minParcels} floor after ${Math.round(elapsedMinutes)} min — not worth a trip, left for a person`,
      };
    }
    return {
      wave: true,
      reason: `${parcels} parcel(s) batched over ${Math.round(elapsedMinutes)} min (window ${intervalMinutes} min) — waving the batch`,
    };
  }
  return {
    wave: false,
    reason: `${parcels} parcel(s) under ${minParcels}, and only ${Math.round(elapsedMinutes)} of ${intervalMinutes} min since the last wave — still collecting`,
  };
}
