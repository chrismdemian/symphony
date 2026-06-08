/**
 * Phase 8D.1 — Automation scheduler engine (Process B).
 *
 * Cohesive port of emdash `AutomationsService`'s schedule half, adapted to
 * Symphony's multi-process split: the engine lives where the DB lives
 * (Process B), CLAIMS due automations under an `AsyncMutex`, and publishes a
 * wake hint. The launcher (Process A) pulls the claimed runs and delivers
 * them to Maestro — see `maestro/automation-injector.ts`.
 *
 * 8D.2 (trigger poll), 8D.3 (resume reconciliation), 8D.4 (retention) extend
 * this same service. `reconcile(mode)` carries the cold-start cleanup now;
 * the resume-vs-coldstart period math is 8D.3.
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

export type ReconcileMode = 'startup' | 'resume';

export interface AutomationSchedulerDeps {
  readonly store: AutomationStore;
  /** Wake-hint broadcaster. Optional (tests / no-RPC rigs). */
  readonly broker?: AutomationsBroker;
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
  private readonly log: (level: 'info' | 'warn' | 'error', message: string) => void;
  private readonly mutex = new AsyncMutex();
  private timer: ReturnType<typeof setInterval> | undefined;
  private disposed = false;

  constructor(deps: AutomationSchedulerDeps) {
    this.store = deps.store;
    this.broker = deps.broker;
    this.now = deps.now ?? Date.now;
    this.tickIntervalMs = deps.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS;
    this.log = deps.log ?? (() => undefined);
  }

  /** Begin ticking. Idempotent. Fires one tick immediately. */
  start(): void {
    if (this.disposed || this.timer !== undefined) return;
    this.log('info', `scheduler started (tick ${this.tickIntervalMs}ms)`);
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
   * One schedule pass. All DB work runs inside the mutex (collect-then-act);
   * the wake hints are published AFTER the lock releases so a slow listener
   * can't stall the engine. Returns the run-log ids claimed this tick (tests).
   */
  async executeTick(): Promise<readonly number[]> {
    if (this.disposed) return [];
    const claimed = await this.mutex.run(async (): Promise<{ runLogId: number; automationId: string }[]> => {
      const nowMs = this.now();
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
    });

    for (const { runLogId, automationId } of claimed) {
      this.broker?.publish({ runLogId, automationId });
    }
    if (claimed.length > 0) {
      this.log('info', `claimed ${claimed.length} due automation(s)`);
    }
    return claimed.map((c) => c.runLogId);
  }

  /**
   * Reconcile orphaned runs from a prior session. 8D.1: cold-start cleanup —
   * every `'running'` run log becomes `'failure'` and its automation's
   * in-flight flag clears, so the next tick can re-fire it (catch-up is
   * automatic via `next_run_at <= now`). The `mode` param is honored only
   * for the cleanup decision; 8D.3 adds resume-specific period math.
   */
  async reconcile(mode: ReconcileMode = 'startup'): Promise<number> {
    return this.mutex.run(async () => {
      if (mode !== 'startup') {
        // 8D.3 — on resume, a 'running' row may still be a live (suspended)
        // run, so it is NOT marked failed here. 8D.1 only implements the
        // cold-start path; resume currently no-ops the cleanup.
        return 0;
      }
      const nowIso = new Date(this.now()).toISOString();
      const cleaned = this.store.markOrphansFailed(nowIso);
      if (cleaned > 0) {
        this.log('info', `reconciled ${cleaned} orphaned run(s) from a prior session`);
      }
      return cleaned;
    });
  }
}
