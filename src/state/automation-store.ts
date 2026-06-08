/**
 * Phase 8D.1 — Automation persistence (the reserved `automations` +
 * `automation_run_logs` tables from migration 0002).
 *
 * An automation fires a configured prompt into Maestro on a schedule. The
 * store is the cross-process source of truth: the scheduler (Process B)
 * CLAIMS a due automation atomically (`in_flight = 1` + a `'running'` run
 * log), and the launcher (Process A) DELIVERS the claimed run to Maestro
 * then calls {@link AutomationStore.completeRun}. A launcher crash leaves
 * `in_flight = 1` + the `'running'` log; the next session's
 * {@link AutomationStore.markOrphansFailed} cleans it up. This is why the
 * claim flag is a DB column, not emdash's in-memory `Set`.
 *
 * `schedule` is the JSON form of an {@link AutomationSchedule} (see
 * `orchestrator/automation-schedule.ts`). `triggerType`/`triggerConfig`/
 * `triggerEvent` are reserved for 8D.2 (event triggers) — null in 8D.1.
 *
 * The SQLite impl lives in `sqlite-automation-store.ts`; this file holds
 * the interface, the domain types, and an in-memory impl used as the test
 * oracle and the `--in-memory` fast-path (behavior-identical).
 */

import { randomUUID } from 'node:crypto';
import {
  computeNextRun,
  parseSchedule,
  serializeSchedule,
  type AutomationSchedule,
} from '../orchestrator/automation-schedule.js';

/** Terminal-ish run-log status. `'running'` = claimed, not yet delivered. */
export type RunStatus = 'running' | 'success' | 'failure' | 'skipped';

export interface AutomationRecord {
  readonly id: string;
  readonly projectId: string | null;
  readonly name: string;
  readonly prompt: string;
  /** Parsed schedule. Null only if a future mode stores a trigger-only automation. */
  readonly schedule: AutomationSchedule | null;
  /** Reserved for 8D.2 event triggers. */
  readonly triggerType: string | null;
  /** Reserved for 8D.2 event triggers (JSON). */
  readonly triggerConfig: string | null;
  readonly nextRunAt: string | null;
  readonly lastRunAt: string | null;
  /** `'success'` | `'failure'` | null. */
  readonly lastRunResult: string | null;
  readonly runCount: number;
  readonly inFlight: boolean;
  readonly enabled: boolean;
  readonly createdAt: string;
}

export interface AutomationRunLog {
  readonly id: number;
  readonly automationId: string;
  readonly taskId: string | null;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly status: RunStatus | null;
  readonly error: string | null;
  /** Reserved for 8D.2/8D.4 (JSON of the firing event). */
  readonly triggerEvent: string | null;
}

export interface CreateAutomationInput {
  readonly name: string;
  readonly prompt: string;
  readonly schedule: AutomationSchedule;
  readonly projectId?: string | null;
  /** Defaults to true. A disabled automation is never claimed. */
  readonly enabled?: boolean;
}

/** A claimed run awaiting delivery to Maestro (joined automation fields). */
export interface PendingRun {
  readonly runLogId: number;
  readonly automationId: string;
  readonly automationName: string;
  readonly prompt: string;
  readonly projectId: string | null;
}

/** Result of an atomic claim: the new run-log id + the advanced next-run. */
export interface ClaimResult {
  readonly runLogId: number;
  readonly nextRunAt: string;
}

export interface AutomationStore {
  /** Create an automation; computes `nextRunAt` from the schedule. */
  create(input: CreateAutomationInput): AutomationRecord;
  get(id: string): AutomationRecord | undefined;
  list(): readonly AutomationRecord[];
  /** Returns true if a row was deleted (cascades run logs via FK). */
  delete(id: string): boolean;
  /** Enable/disable. Returns true if the row existed. */
  setEnabled(id: string, enabled: boolean): boolean;
  /**
   * Force an automation due now (CLI `run`): sets `next_run_at = nowIso` so
   * the active session's next tick claims it. Returns true if the row
   * existed and is enabled. A disabled automation is rejected (false).
   */
  forceDue(id: string, nowIso: string): boolean;
  /**
   * Enabled, not in-flight, `next_run_at <= nowIso`. The scheduler's tick
   * input. Schedule-mode only (`next_run_at IS NOT NULL`).
   */
  listDue(nowIso: string): readonly AutomationRecord[];
  /**
   * Atomically claim a due automation: `in_flight = 1`, `run_count + 1`,
   * `next_run_at = nextRunAt`, and INSERT a `'running'` run log
   * (`started_at = nowIso`). Returns the new run-log id, or undefined if the
   * row was already claimed by a concurrent caller (WHERE in_flight = 0
   * guard). Run-log retention is trimmed here.
   */
  claim(id: string, nextRunAt: string, nowIso: string): ClaimResult | undefined;
  /** Run logs still `'running'` (claimed, not yet completed) — delivery queue. */
  listPending(): readonly PendingRun[];
  /**
   * Mark a delivered run finished: stamp the run log
   * (`finished_at = nowIso`, `status`, `error`) AND clear the parent
   * automation (`in_flight = 0`, `last_run_at = nowIso`,
   * `last_run_result = status`). Returns true if the run log existed and was
   * `'running'`. Idempotent: a second call returns false.
   */
  completeRun(
    runLogId: number,
    status: 'success' | 'failure',
    nowIso: string,
    error?: string,
  ): boolean;
  /**
   * Reconcile orphaned runs from a prior session: every `'running'` run log
   * becomes `'failure'` (`finished_at = nowIso`) and its parent automation's
   * `in_flight` is cleared. Returns the count cleaned up. (8D.3 extends this
   * with cold-start-vs-resume semantics; 8D.1 does the cold-start cleanup.)
   */
  markOrphansFailed(nowIso: string): number;
  /** Run logs for one automation, newest first (CLI `list --runs`, tests). */
  listRunLogs(automationId: string, limit?: number): readonly AutomationRunLog[];
}

/** Per-automation and global run-log retention caps (emdash parity). */
export const MAX_RUNS_PER_AUTOMATION = 100;
export const MAX_TOTAL_RUNS = 2000;

/** Stable id generator, shared by both impls. */
export function generateAutomationId(): string {
  return `auto_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

// ---------------------------------------------------------------------------
// In-memory impl — test oracle + `--in-memory` fast-path. Behavior-identical
// to the SQLite store.
// ---------------------------------------------------------------------------

interface MemAutomation {
  id: string;
  projectId: string | null;
  name: string;
  prompt: string;
  scheduleJson: string | null;
  triggerType: string | null;
  triggerConfig: string | null;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastRunResult: string | null;
  runCount: number;
  inFlight: boolean;
  enabled: boolean;
  createdAt: string;
}

interface MemRunLog {
  id: number;
  automationId: string;
  taskId: string | null;
  startedAt: string;
  finishedAt: string | null;
  status: RunStatus | null;
  error: string | null;
  triggerEvent: string | null;
}

export interface InMemoryAutomationStoreOptions {
  readonly now?: () => number;
}

export class InMemoryAutomationStore implements AutomationStore {
  private readonly automations = new Map<string, MemAutomation>();
  private readonly runLogs: MemRunLog[] = [];
  private nextRunLogId = 1;
  private readonly now: () => number;

  constructor(opts: InMemoryAutomationStoreOptions = {}) {
    this.now = opts.now ?? Date.now;
  }

  create(input: CreateAutomationInput): AutomationRecord {
    const nowIso = new Date(this.now()).toISOString();
    const scheduleJson = serializeSchedule(input.schedule);
    const row: MemAutomation = {
      id: generateAutomationId(),
      projectId: input.projectId ?? null,
      name: input.name,
      prompt: input.prompt,
      scheduleJson,
      triggerType: null,
      triggerConfig: null,
      nextRunAt: computeNextRun(input.schedule, new Date(this.now())),
      lastRunAt: null,
      lastRunResult: null,
      runCount: 0,
      inFlight: false,
      enabled: input.enabled ?? true,
      createdAt: nowIso,
    };
    this.automations.set(row.id, row);
    return toRecord(row);
  }

  get(id: string): AutomationRecord | undefined {
    const row = this.automations.get(id);
    return row ? toRecord(row) : undefined;
  }

  list(): readonly AutomationRecord[] {
    return Array.from(this.automations.values())
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0))
      .map(toRecord);
  }

  delete(id: string): boolean {
    if (!this.automations.has(id)) return false;
    this.automations.delete(id);
    // FK ON DELETE CASCADE parity.
    for (let i = this.runLogs.length - 1; i >= 0; i -= 1) {
      if (this.runLogs[i]!.automationId === id) this.runLogs.splice(i, 1);
    }
    return true;
  }

  setEnabled(id: string, enabled: boolean): boolean {
    const row = this.automations.get(id);
    if (row === undefined) return false;
    row.enabled = enabled;
    return true;
  }

  forceDue(id: string, nowIso: string): boolean {
    const row = this.automations.get(id);
    if (row === undefined || !row.enabled) return false;
    row.nextRunAt = nowIso;
    return true;
  }

  listDue(nowIso: string): readonly AutomationRecord[] {
    return Array.from(this.automations.values())
      .filter(
        (r) =>
          r.enabled &&
          !r.inFlight &&
          r.nextRunAt !== null &&
          r.nextRunAt <= nowIso,
      )
      .map(toRecord);
  }

  claim(id: string, nextRunAt: string, nowIso: string): ClaimResult | undefined {
    const row = this.automations.get(id);
    if (row === undefined || row.inFlight) return undefined;
    row.inFlight = true;
    row.runCount += 1;
    row.nextRunAt = nextRunAt;
    const runLogId = this.nextRunLogId;
    this.nextRunLogId += 1;
    this.runLogs.push({
      id: runLogId,
      automationId: id,
      taskId: null,
      startedAt: nowIso,
      finishedAt: null,
      status: 'running',
      error: null,
      triggerEvent: null,
    });
    this.trimRunLogs(id);
    return { runLogId, nextRunAt };
  }

  listPending(): readonly PendingRun[] {
    const out: PendingRun[] = [];
    for (const log of this.runLogs) {
      if (log.status !== 'running') continue;
      const auto = this.automations.get(log.automationId);
      if (auto === undefined) continue;
      out.push({
        runLogId: log.id,
        automationId: auto.id,
        automationName: auto.name,
        prompt: auto.prompt,
        projectId: auto.projectId,
      });
    }
    return out;
  }

  completeRun(
    runLogId: number,
    status: 'success' | 'failure',
    nowIso: string,
    error?: string,
  ): boolean {
    const log = this.runLogs.find((l) => l.id === runLogId);
    if (log === undefined || log.status !== 'running') return false;
    log.status = status;
    log.finishedAt = nowIso;
    log.error = error ?? null;
    const auto = this.automations.get(log.automationId);
    if (auto !== undefined) {
      auto.inFlight = false;
      auto.lastRunAt = nowIso;
      auto.lastRunResult = status;
    }
    return true;
  }

  markOrphansFailed(nowIso: string): number {
    let count = 0;
    for (const log of this.runLogs) {
      if (log.status !== 'running') continue;
      log.status = 'failure';
      log.finishedAt = nowIso;
      log.error = 'Interrupted (session ended before delivery)';
      const auto = this.automations.get(log.automationId);
      if (auto !== undefined) {
        auto.inFlight = false;
        auto.lastRunResult = 'failure';
      }
      count += 1;
    }
    // Audit m2 — parity with the SQLite store's `clearOrphanFlags`, which
    // clears EVERY in_flight=1 row. Normal claims always pair in_flight with
    // a running log, so this only matters for a (theoretically impossible)
    // in_flight row with no running log; clearing it keeps the two impls
    // behavior-identical.
    for (const auto of this.automations.values()) {
      if (auto.inFlight) auto.inFlight = false;
    }
    return count;
  }

  listRunLogs(automationId: string, limit?: number): readonly AutomationRunLog[] {
    const rows = this.runLogs
      .filter((l) => l.automationId === automationId)
      .sort((a, b) =>
        a.startedAt > b.startedAt
          ? -1
          : a.startedAt < b.startedAt
            ? 1
            : b.id - a.id,
      )
      .map(toRunLog);
    return limit !== undefined ? rows.slice(0, limit) : rows;
  }

  /** Per-automation (100) then global (2000) trim, oldest dropped first. */
  private trimRunLogs(automationId: string): void {
    const own = this.runLogs
      .filter((l) => l.automationId === automationId)
      .sort((a, b) => (a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : a.id - b.id));
    if (own.length > MAX_RUNS_PER_AUTOMATION) {
      const drop = new Set(own.slice(0, own.length - MAX_RUNS_PER_AUTOMATION).map((l) => l.id));
      for (let i = this.runLogs.length - 1; i >= 0; i -= 1) {
        if (drop.has(this.runLogs[i]!.id)) this.runLogs.splice(i, 1);
      }
    }
    if (this.runLogs.length > MAX_TOTAL_RUNS) {
      this.runLogs.sort((a, b) => (a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : a.id - b.id));
      this.runLogs.splice(0, this.runLogs.length - MAX_TOTAL_RUNS);
    }
  }
}

function toRecord(row: MemAutomation): AutomationRecord {
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    prompt: row.prompt,
    schedule: row.scheduleJson !== null ? parseSchedule(row.scheduleJson) : null,
    triggerType: row.triggerType,
    triggerConfig: row.triggerConfig,
    nextRunAt: row.nextRunAt,
    lastRunAt: row.lastRunAt,
    lastRunResult: row.lastRunResult,
    runCount: row.runCount,
    inFlight: row.inFlight,
    enabled: row.enabled,
    createdAt: row.createdAt,
  };
}

function toRunLog(row: MemRunLog): AutomationRunLog {
  return {
    id: row.id,
    automationId: row.automationId,
    taskId: row.taskId,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    status: row.status,
    error: row.error,
    triggerEvent: row.triggerEvent,
  };
}
