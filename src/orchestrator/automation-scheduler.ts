/**
 * Phase 8D.1 — Automation scheduler engine (Process B).
 *
 * Cohesive port of emdash `AutomationsService`'s schedule half, adapted to
 * Symphony's multi-process split: the engine lives where the DB lives
 * (Process B), CLAIMS due automations under an `AsyncMutex`, and publishes a
 * wake hint. The launcher (Process A) pulls the claimed runs and delivers
 * them to Maestro — see `maestro/automation-injector.ts`.
 *
 * 8D.2 (trigger poll), 8D.4 (retention) extend this same service.
 *
 * 8D.3 (catch-up reconciliation) makes the missed-schedule catch-up that was
 * already IMPLICIT in the periodic tick EXPLICIT and wake-aware:
 *   - `reconcile('startup')` fails prior-session orphans THEN catches up.
 *   - `reconcile('resume')` catches up WITHOUT failing in-flight runs (a
 *     'running' log surviving sleep is a live suspended run, not a crash).
 *   - a wall-clock-gap heuristic in {@link AutomationScheduler.executeTick}
 *     detects host suspend (laptop sleep) between ticks — a plain Node CLI has
 *     no `powerMonitor`, and `SIGCONT` doesn't fire on sleep, so the gap is the
 *     load-bearing cross-platform wake signal.
 *
 * Catch-up is exactly-once-per-MISSED-WINDOW: `claim` advances `next_run_at`
 * to the next FUTURE boundary, so N missed periods collapse to ONE run + a
 * resync (NOT one run per missed period). This is the emdash contract.
 */

import {
  computeNextRun,
  type AutomationSchedule,
} from './automation-schedule.js';
import type { AutomationStore } from '../state/automation-store.js';
import type { AutomationsBroker } from './automations-broker.js';

/** Promise-chaining mutex — verbatim from emdash `AutomationsService.ts:44-61`. */
export class AsyncMutex {
  private chain: Promise<void> = Promise.resolve();

  async run<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.chain = this.chain.then(async () => {
        try {
          resolve(await fn());
        } catch (err) {
          reject(err);
        }
      });
    });
  }
}

/** Default schedule tick — emdash uses 30s. */
export const DEFAULT_TICK_INTERVAL_MS = 30_000;

/**
 * Floor for the resume-gap threshold (8D.3). A wall-clock gap between two
 * already-running ticks larger than this means the host was suspended (sleep)
 * — ordinary GC / event-loop jitter between 30s ticks is sub-second, so 2 min
 * has enormous margin and never false-positives. The effective threshold is
 * `max(tickIntervalMs * 3, this)`.
 */
export const DEFAULT_RESUME_GAP_FLOOR_MS = 120_000;

export type ReconcileMode = 'startup' | 'resume';

export interface AutomationSchedulerDeps {
  readonly store: AutomationStore;
  /** Wake-hint broadcaster. Optional (tests / no-RPC rigs). */
  readonly broker?: AutomationsBroker;
  /**
   * 8D.3 — wall-clock gap (ms) above which a tick is treated as a post-suspend
   * resume. Defaults to `max(tickIntervalMs * 3, {@link
   * DEFAULT_RESUME_GAP_FLOOR_MS})`. Test seam — drive a small value to simulate
   * a wake with an injected clock.
   */
  readonly resumeGapMs?: number;
  /** Injected clock (ms). Defaults to Date.now. */
  readonly now?: () => number;
  /** Tick interval. Defaults to {@link DEFAULT_TICK_INTERVAL_MS}. */
  readonly tickIntervalMs?: number;
  readonly log?: (level: 'info' | 'warn' | 'error', message: string) => void;
}

export class AutomationScheduler {
  private readonly store: AutomationStore;
  private readonly broker: AutomationsBroker | undefined;
  private readonly now: () => number;
  private readonly tickIntervalMs: number;
  private readonly resumeGapMs: number;
  private readonly log: (level: 'info' | 'warn' | 'error', message: string) => void;
  private readonly mutex = new AsyncMutex();
  private timer: ReturnType<typeof setInterval> | undefined;
  private disposed = false;
  /**
   * 8D.3 — wall-clock ms of the last tick. In-memory only: a process restart
   * resets it (boot is always a cold start handled by `reconcile('startup')`),
   * and the resume heuristic only fires on a gap between two ALREADY-running
   * ticks — so heuristic and reconcile responsibilities never overlap.
   * `undefined` until `start()` sets it, which suppresses a phantom "resume"
   * on the very first post-boot tick.
   */
  private lastTickAt: number | undefined;

  constructor(deps: AutomationSchedulerDeps) {
    this.store = deps.store;
    this.broker = deps.broker;
    this.now = deps.now ?? Date.now;
    this.tickIntervalMs = deps.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS;
    this.resumeGapMs =
      deps.resumeGapMs ?? Math.max(this.tickIntervalMs * 3, DEFAULT_RESUME_GAP_FLOOR_MS);
    this.log = deps.log ?? (() => undefined);
  }

  /** Begin ticking. Idempotent. Fires one tick immediately. */
  start(): void {
    if (this.disposed || this.timer !== undefined) return;
    this.log('info', `scheduler started (tick ${this.tickIntervalMs}ms)`);
    // 8D.3 — seed the resume clock so the immediate tick below measures a ~0
    // gap and never logs a phantom "resume detected" at every cold start.
    this.lastTickAt = this.now();
    this.timer = setInterval(() => void this.tick(), this.tickIntervalMs);
    // Don't keep the event loop alive solely for the scheduler timer.
    if (typeof this.timer.unref === 'function') this.timer.unref();
    void this.tick();
  }

  /** Stop ticking. Idempotent. */
  async stop(): Promise<void> {
    this.disposed = true;
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    // Drain any in-flight tick so it finishes its mutex section cleanly.
    await this.mutex.run(async () => undefined);
  }

  /** Tick wrapper — never lets a throw kill the interval. */
  private async tick(): Promise<void> {
    if (this.disposed) return;
    try {
      await this.executeTick();
    } catch (err) {
      this.log('warn', `tick failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * One schedule pass. The claim runs inside the mutex (collect-then-act); the
   * wake hints are published AFTER the lock releases so a slow listener can't
   * stall the engine. Returns the run-log ids claimed this tick (tests).
   *
   * 8D.3 — also the wall-clock-gap WAKE detector: a gap far larger than the
   * tick interval since the previous tick means the host was suspended (laptop
   * sleep) between ticks. The tick's own `claimDueLocked` IS the catch-up (and
   * never fails an in-flight run), so resume handling reduces to detect + log;
   * the firing is intrinsic.
   */
  async executeTick(): Promise<readonly number[]> {
    if (this.disposed) return [];
    const nowMs = this.now();
    // Read-then-write: measure the gap against the PREVIOUS tick before
    // stamping this one. `undefined` (pre-`start()`) suppresses the first-tick
    // false positive.
    const prevTickAt = this.lastTickAt;
    this.lastTickAt = nowMs;
    const gapMs = prevTickAt === undefined ? 0 : nowMs - prevTickAt;
    const resumed = prevTickAt !== undefined && gapMs > this.resumeGapMs;

    const claimed = await this.mutex.run(async () => this.claimDueLocked(nowMs));

    for (const { runLogId, automationId } of claimed) {
      this.broker?.publish({ runLogId, automationId });
    }
    if (resumed) {
      // Count reported AFTER the claim — usually 0 (a laptop that slept on an
      // hourly automation catches up exactly 1, not one-per-missed-period, and
      // often 0 when next_run_at is still in the future).
      const gapMin = Math.round(gapMs / 60_000);
      this.log(
        'info',
        `resume detected (gap ${gapMin}m) — caught up ${claimed.length} missed schedule(s)`,
      );
    } else if (claimed.length > 0) {
      this.log('info', `claimed ${claimed.length} due automation(s)`);
    }
    return claimed.map((c) => c.runLogId);
  }

  /**
   * The claim loop, shared by {@link executeTick} and {@link reconcile}.
   *
   * MUST run inside the mutex (the caller wraps it in `this.mutex.run`): both
   * the `listDue` READ and the `claim` WRITE happen here, so a concurrent
   * reconcile/tick can't read a stale due-set and double-claim — whichever
   * acquires the lock first advances `next_run_at` / sets `in_flight` before
   * the other re-reads. Do NOT lift the `listDue` read out of the lock.
   *
   * Returns the claimed {runLogId, automationId} pairs; the CALLER publishes
   * the wake hints after the lock releases.
   */
  private claimDueLocked(nowMs: number): { runLogId: number; automationId: string }[] {
    const nowDate = new Date(nowMs);
    const nowIso = nowDate.toISOString();
    const out: { runLogId: number; automationId: string }[] = [];
    for (const automation of this.store.listDue(nowIso)) {
      const schedule: AutomationSchedule | null = automation.schedule;
      if (schedule === null) {
        // Schedule-mode row with no spec — can't advance. Skip (defensive;
        // listDue already requires next_run_at, which only schedule-mode
        // rows have in 8D.1).
        this.log('warn', `automation ${automation.id} is due but has no schedule — skipping`);
        continue;
      }
      const nextRunAt = computeNextRun(schedule, nowDate);
      const result = this.store.claim(automation.id, nextRunAt, nowIso);
      if (result === undefined) continue; // raced — another claimer won
      out.push({ runLogId: result.runLogId, automationId: automation.id });
    }
    return out;
  }

  /**
   * Reconcile after a session boundary, then CATCH UP missed schedules (8D.3).
   *
   * - `'startup'` (cold start / process restart): fail every prior-session
   *   `'running'` orphan (the launcher is gone — it can't be recovered) AND
   *   clear its `in_flight` flag, THEN catch up. `markOrphansFailed` does NOT
   *   touch `next_run_at`, so an orphan whose period elapsed re-fires on the
   *   catch-up below.
   * - `'resume'` (laptop wake): catch up ONLY — a `'running'` row surviving
   *   SLEEP is a live SUSPENDED run, not a crash, so it is NOT failed (the
   *   in-flight guard in `listDue` keeps the catch-up from re-claiming it).
   *
   * Catch-up is exactly-once-per-MISSED-WINDOW: `claim` advances `next_run_at`
   * to the next future boundary, so many missed periods collapse to ONE run.
   * Returns the count of orphans CLEANED (0 on resume); caught-up runs are
   * surfaced via the wake hints + the store's pending queue, not the return.
   *
   * The {@link AsyncMutex} (shared with `executeTick`) intentionally replaces
   * emdash's `reconciling` re-entrancy flag — two overlapping reconciles
   * serialize, and the second reads `listDue` after the first advanced
   * `next_run_at`, so it claims nothing. Don't re-add a boolean guard.
   */
  async reconcile(mode: ReconcileMode = 'startup'): Promise<number> {
    if (this.disposed) return 0;
    const { cleaned, claimed } = await this.mutex.run(async () => {
      const nowMs = this.now();
      const nowIso = new Date(nowMs).toISOString();
      const cleaned = mode === 'startup' ? this.store.markOrphansFailed(nowIso) : 0;
      const claimed = this.claimDueLocked(nowMs);
      return { cleaned, claimed };
    });

    for (const { runLogId, automationId } of claimed) {
      this.broker?.publish({ runLogId, automationId });
    }
    if (cleaned > 0) {
      this.log('info', `reconciled ${cleaned} orphaned run(s) from a prior session`);
    }
    if (claimed.length > 0) {
      this.log('info', `${mode} catch-up fired ${claimed.length} missed schedule(s)`);
    }
    return cleaned;
  }
}
