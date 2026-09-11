import { logger } from '../utils/logger.js';
import type { WaveEngineConfig } from './config.js';
import { bangkokDateKey, bangkokHhMm } from './tiers.js';

/**
 * Runs at most one cycle at a time across every loop (spec §5a).
 *
 * A tick that arrives while another is still running is SKIPPED, not queued:
 * the main loop does a lot of DOM work on a queue that keeps changing, and
 * stacking a backlog of cycles would have the bot acting on stale scans — and,
 * worse, doing overlapping real clicks on the same order list.
 */
class CycleLock {
  private holder: string | null = null;

  async run<T>(name: string, fn: () => Promise<T>): Promise<T | null> {
    if (this.holder) {
      await logger.warn(`wave-engine: skipped "${name}" tick — "${this.holder}" is still running`);
      return null;
    }
    this.holder = name;
    try {
      return await fn();
    } finally {
      this.holder = null;
    }
  }
}

export interface SchedulerHandlers {
  runUrgent: () => Promise<void>;
  runMain: () => Promise<void>;
}

export interface SchedulerHandle {
  stop: () => void;
}

/** ±jitterSeconds around the base interval so the bot never fires on an exact fixed cadence (spec §5a). Floored at 30s so a misconfigured interval can't turn into a hot loop against BigSeller. */
export function nextDelayMs(baseMinutes: number, jitterSeconds: number): number {
  const jitterMs = (Math.random() * 2 - 1) * jitterSeconds * 1000;
  return Math.max(30_000, baseMinutes * 60_000 + jitterMs);
}

/**
 * Starts the two poll loops plus the fixed-time triggers.
 *
 * The fixed-time triggers are STUBS in phase 1 (they log that they fired and
 * do nothing else): the 15:45 tier-2.5 safety check and the end-of-day tier-5
 * sweep both act on tiers that are dry-run-only until a later phase, so wiring
 * them to real actions now would be building the thing this phase deliberately
 * defers. They still fire and log, which proves the timing works before it
 * matters.
 */
export function startScheduler(config: WaveEngineConfig, handlers: SchedulerHandlers): SchedulerHandle {
  const lock = new CycleLock();
  const timers: NodeJS.Timeout[] = [];
  const firedToday = new Set<string>();
  let stopped = false;

  const scheduleLoop = (name: 'urgent' | 'main', baseMinutes: number, handler: () => Promise<void>) => {
    const arm = () => {
      if (stopped) return;
      const delay = nextDelayMs(baseMinutes, config.jitterSeconds);
      const timer = setTimeout(async () => {
        await lock.run(name, handler).catch(async (error) => {
          // A failing cycle must not kill the daemon — the next tick re-scans
          // from scratch anyway, and an unattended bot that silently exits at
          // 09:10 is worse than one that logs and keeps going.
          await logger.error(`wave-engine: "${name}" cycle failed: ${(error as Error).message}`);
          return null;
        });
        arm();
      }, delay);
      timers.push(timer);
      void logger.info(`wave-engine: next "${name}" tick in ${Math.round(delay / 1000)}s`);
    };
    arm();
  };

  scheduleLoop('urgent', config.urgentLoopMinutes, handlers.runUrgent);
  scheduleLoop('main', config.mainLoopMinutes, handlers.runMain);

  const clockTimer = setInterval(() => {
    if (stopped) return;
    const today = bangkokDateKey(new Date());
    const nowHhMm = bangkokHhMm(new Date());

    const fireOnce = (name: string, at: string | null, message: string) => {
      if (!at || nowHhMm < at) return;
      const key = `${today}:${name}`;
      if (firedToday.has(key)) return;
      firedToday.add(key);
      void logger.warn(`wave-engine: ${name} trigger fired at ${nowHhMm} — ${message}`);
    };

    fireOnce(
      'forced-trigger',
      config.forcedTriggerTime,
      'STUB: a pre-cutoff safety check for the standard-round priorities. Does nothing until real truck times exist.',
    );
    fireOnce('eod-sweep', config.endOfDaySweepTime, 'STUB: Seller Delivery end-of-day sweep is dry-run only.');
  }, 60_000);
  timers.push(clockTimer);

  return {
    stop: () => {
      stopped = true;
      for (const timer of timers) clearTimeout(timer as NodeJS.Timeout);
      clearInterval(clockTimer);
    },
  };
}
