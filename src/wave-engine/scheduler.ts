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
  /** Fired once at `config.preShiftRoundTime`, through the same lock as the interval loops. Optional so a caller with nothing to do before a shift can omit it. */
  runPreShift?: () => Promise<void>;
}

export interface SchedulerHandle {
  stop: () => void;
}

/** ±jitterSeconds around the base interval so the bot never fires on an exact fixed cadence (spec §5a). Floored at 30s so a misconfigured interval can't turn into a hot loop against BigSeller. */
/**
 * A failure the next tick cannot possibly recover from: the browser, context
 * or page is gone, so every later cycle will fail the same way.
 *
 * Seen live on 2026-09-11 — a daemon whose browser had died kept ticking for
 * over three hours, logging an identical error every ~3 minutes and doing no
 * work. That is worse than exiting: the log looks busy, the process looks
 * alive, and nobody is told the bot stopped working.
 */
export function isUnrecoverableBrowserError(message: string): boolean {
  return (
    message.includes('Target page, context or browser has been closed') ||
    message.includes('Target crashed') ||
    message.includes('Browser has been closed') ||
    message.includes('browser has been closed') ||
    message.includes('Protocol error') ||
    message.includes('has been closed')
  );
}

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
        let fatal = false;
        await lock.run(name, handler).catch(async (error) => {
          const message = (error as Error).message;
          // A failing cycle must not kill the daemon — the next tick re-scans
          // from scratch anyway, and an unattended bot that silently exits at
          // 09:10 is worse than one that logs and keeps going.
          //
          // A dead browser is the exception: it cannot come back on its own,
          // so retrying only buries the real event under identical errors.
          // Same policy as a dead session — stop and ask for a human.
          if (isUnrecoverableBrowserError(message)) {
            fatal = true;
            await logger.error(
              `wave-engine: "${name}" cycle failed and the browser is gone (${message}) — stopping the daemon. Restart it.`,
            );
            return null;
          }
          await logger.error(`wave-engine: "${name}" cycle failed: ${message}`);
          return null;
        });
        if (fatal) {
          stop();
          return;
        }
        arm();
      }, delay);
      timers.push(timer);
      void logger.info(`wave-engine: next "${name}" tick in ${Math.round(delay / 1000)}s`);
    };
    arm();
  };

  const stop = () => {
    stopped = true;
    for (const timer of timers) clearTimeout(timer as NodeJS.Timeout);
    clearInterval(clockTimer);
  };

  scheduleLoop('urgent', config.urgentLoopMinutes, handlers.runUrgent);
  scheduleLoop('main', config.mainLoopMinutes, handlers.runMain);

  const clockTimer = setInterval(() => {
    if (stopped) return;
    const today = bangkokDateKey(new Date());
    const nowHhMm = bangkokHhMm(new Date());

    const fireOnce = (name: string, at: string | null, message: string, action?: () => Promise<void>) => {
      if (!at || nowHhMm < at) return;
      const key = `${today}:${name}`;
      if (firedToday.has(key)) return;
      firedToday.add(key);
      void logger.warn(`wave-engine: ${name} trigger fired at ${nowHhMm} — ${message}`);
      if (!action) return;
      // Through the SAME lock as the interval loops, not a bare call — firing
      // this while an urgent/main tick is mid-scan would mean two cycles
      // touching the filters and the confirm button at once.
      void lock.run(name, action).catch((error: Error) => {
        if (isUnrecoverableBrowserError(error.message)) {
          void logger.error(`wave-engine: "${name}" cycle failed and the browser is gone (${error.message}) — stopping the daemon. Restart it.`);
          stop();
          return;
        }
        void logger.error(`wave-engine: "${name}" cycle failed: ${error.message}`);
      });
    };

    fireOnce(
      'forced-trigger',
      config.forcedTriggerTime,
      'STUB: a pre-cutoff safety check for the standard-round priorities. Does nothing until real truck times exist.',
    );
    fireOnce('eod-sweep', config.endOfDaySweepTime, 'STUB: Seller Delivery end-of-day sweep is dry-run only.');
    fireOnce(
      'pre-shift-round',
      config.preShiftRoundTime,
      'confirming and waving whatever is eligible now, so it is ready before staff start their afternoon shift ' +
        '("ต้องเผื่อเวลา ... เสร็จก่อนบ่าย", 2026-09-14) — real orders touched only where WAVE_ENGINE_LIVE_PRIORITIES allows',
      handlers.runPreShift,
    );
  }, 60_000);
  timers.push(clockTimer);

  return { stop };
}
