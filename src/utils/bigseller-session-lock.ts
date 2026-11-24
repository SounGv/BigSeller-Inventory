import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { logger } from './logger.js';

const LOCK_PATH = resolve('logs', 'bigseller-session.lock');

/** A BigSeller job never legitimately runs this long; a lock older than this is a crashed run's leftover. */
const STALE_AFTER_MS = 15 * 60 * 1000;
const POLL_MS = 5_000;

interface SessionLockFile {
  pid: number;
  owner: string;
  startedAt: string;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 only checks that the process exists
    return true;
  } catch {
    return false;
  }
}

function readLock(): SessionLockFile | null {
  if (!existsSync(LOCK_PATH)) return null;
  try {
    return JSON.parse(readFileSync(LOCK_PATH, 'utf8')) as SessionLockFile;
  } catch {
    return null;
  }
}

function isHeldByAnother(lock: SessionLockFile | null): boolean {
  if (!lock || lock.pid === process.pid) return false;
  const ageMs = Date.now() - new Date(lock.startedAt).getTime();
  return isProcessAlive(lock.pid) && ageMs < STALE_AFTER_MS;
}

/**
 * Serialises jobs that drive the ONE shared BigSeller browser session.
 *
 * The 10-minute shortage watch and the 2-hourly full sync both log in with the
 * same saved session, and BigSeller kicks a session that is driven twice at
 * once. A job takes this lock before opening the browser and gives it back
 * when it finishes.
 *
 * Returns a release function, or null if another live job still holds the lock
 * after `waitMs` (pass 0 to give up immediately — the watch simply skips that
 * round, the full sync waits a few minutes instead).
 */
export async function acquireBigSellerSessionLock(owner: string, waitMs: number): Promise<(() => void) | null> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const existing = readLock();
    if (!isHeldByAnother(existing)) break;
    if (Date.now() >= deadline) {
      await logger.info(`bigseller-session-lock: held by ${existing?.owner} (pid ${existing?.pid}) — ${owner} is not starting`);
      return null;
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }

  mkdirSync(dirname(LOCK_PATH), { recursive: true });
  writeFileSync(LOCK_PATH, JSON.stringify({ pid: process.pid, owner, startedAt: new Date().toISOString() }, null, 2));
  return () => {
    // Only clear a lock this process still owns.
    if (readLock()?.pid === process.pid) rmSync(LOCK_PATH, { force: true });
  };
}
