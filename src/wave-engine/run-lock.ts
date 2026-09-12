import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { logger } from '../utils/logger.js';

const LOCK_PATH = resolve('logs', 'wave-engine.lock');

/** A lock older than this is treated as abandoned — a crashed run never gets to clean up after itself. */
const STALE_AFTER_MS = 30 * 60 * 1000;

interface LockFile {
  pid: number;
  mode: string;
  startedAt: string;
}

function isProcessAlive(pid: number): boolean {
  try {
    // Signal 0 checks for the process without touching it.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function readLock(): LockFile | null {
  if (!existsSync(LOCK_PATH)) return null;
  try {
    return JSON.parse(readFileSync(LOCK_PATH, 'utf8')) as LockFile;
  } catch {
    return null;
  }
}

/**
 * Refuses to start while another engine is already working.
 *
 * Two engines on one BigSeller account fight: they scan the same queue, each
 * sets the filters the other is reading under, and both can click confirm on
 * the same order. On 2026-09-12 six wave-engine processes were alive at once —
 * one left over from the morning, others started while the first was mid-scan —
 * and the filter each one set pulled the ground out from under the others.
 *
 * A lock left by a process that is no longer running, or older than half an
 * hour, is taken over rather than obeyed: a crashed run must not block the next
 * one forever.
 */
export async function acquireRunLock(mode: string): Promise<() => void> {
  const existing = readLock();
  if (existing) {
    const ageMs = Date.now() - new Date(existing.startedAt).getTime();
    const alive = isProcessAlive(existing.pid);
    if (alive && ageMs < STALE_AFTER_MS) {
      throw new Error(
        `Another wave-engine is already running (pid ${existing.pid}, mode ${existing.mode}, started ${existing.startedAt}). ` +
          'Two engines on one account confirm the same orders twice and overwrite each other\'s filters. ' +
          'Stop that one first, or wait for it to finish.',
      );
    }
    await logger.warn(
      `wave-engine: taking over a ${alive ? 'stale' : 'dead'} lock from pid ${existing.pid} ` +
        `(mode ${existing.mode}, ${Math.round(ageMs / 60000)} min old)`,
    );
  }

  mkdirSync(dirname(LOCK_PATH), { recursive: true });
  writeFileSync(LOCK_PATH, JSON.stringify({ pid: process.pid, mode, startedAt: new Date().toISOString() }, null, 2));
  return () => {
    // Only clear a lock this process still owns — a run that took over from a
    // stale lock must not delete a newer one.
    const current = readLock();
    if (current?.pid === process.pid) rmSync(LOCK_PATH, { force: true });
  };
}
