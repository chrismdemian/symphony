import type { Database, Statement } from 'better-sqlite3';
import {
  computeNextRun,
  parseSchedule,
  serializeSchedule,
} from '../orchestrator/automation-schedule.js';
import {
  generateAutomationId,
  validateCreateAutomationInput,
  MAX_RUNS_PER_AUTOMATION,
  MAX_TOTAL_RUNS,
  type AutomationRecord,
  type AutomationRunLog,
  type AutomationStore,
  type ClaimResult,
  type CreateAutomationInput,
  type PendingRun,
  type RunStatus,
  type TriggerClaimResult,
} from './automation-store.js';

interface AutomationRow {
  id: string;
  project_id: string | null;
  name: string;
  prompt: string;
  schedule: string | null;
  trigger_type: string | null;
  trigger_config: string | null;
  next_run_at: string | null;
  last_run_at: string | null;
  last_run_result: string | null;
  run_count: number;
  in_flight: number;
  enabled: number;
  created_at: string;
}

interface RunLogRow {
  id: number;
  automation_id: string;
  task_id: string | null;
  started_at: string;
  finished_at: string | null;
  status: string | null;
  error: string | null;
  trigger_event: string | null;
}

interface PendingRow {
  run_log_id: number;
  automation_id: string;
  name: string;
  prompt: string;
  project_id: string | null;
  trigger_event: string | null;
}

export interface SqliteAutomationStoreOptions {
  /** Clock for `create` (createdAt + initial nextRunAt). Defaults to Date.now. */
  readonly now?: () => number;
}

/**
 * SQLite-backed {@link AutomationStore} over the reserved migration-0002
 * tables. Behavior-identical to {@link InMemoryAutomationStore}. The
 * atomic `claim` (UPDATE … WHERE in_flight=0 + INSERT run log + retention
 * trim) and `completeRun`/`markOrphansFailed` run inside better-sqlite3
 * `transaction()` blocks so a concurrent claimer can't double-fire.
 */
export class SqliteAutomationStore implements AutomationStore {
  private readonly now: () => number;
  private readonly stmts: {
    insert: Statement;
    getById: Statement;
    listAll: Statement;
    deleteById: Statement;
    setEnabled: Statement;
    forceDue: Statement;
    listDue: Statement;
    listActiveTriggers: Statement;
    claimUpdate: Statement;
    claimTriggerUpdate: Statement;
    insertRunLog: Statement;
    insertTriggerRunLog: Statement;
    trimPerAutomation: Statement;
    trimGlobal: Statement;
    listPending: Statement;
    completeLog: Statement;
    clearInFlightForLog: Statement;
    countOrphans: Statement;
    failOrphanLogs: Statement;
    clearOrphanFlags: Statement;
    listRunLogs: Statement;
    listRunLogsLimit: Statement;
  };
  private readonly claimTxn: (id: string, nextRunAt: string, nowIso: string) => ClaimResult | undefined;
  private readonly claimTriggerTxn: (
    id: string,
    triggerEventJson: string,
    nowIso: string,
  ) => TriggerClaimResult | undefined;
  private readonly completeTxn: (
    runLogId: number,
    status: 'success' | 'failure',
    nowIso: string,
    error: string | null,
  ) => boolean;
  private readonly reconcileTxn: (nowIso: string) => number;

  constructor(
    private readonly db: Database,
    opts: SqliteAutomationStoreOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.stmts = {
      insert: db.prepare(
        `INSERT INTO automations
           (id, project_id, name, prompt, schedule, trigger_type, trigger_config,
            next_run_at, last_run_at, last_run_result, run_count, in_flight, enabled, created_at)
         VALUES
           (@id, @project_id, @name, @prompt, @schedule, @trigger_type, @trigger_config,
            @next_run_at, @last_run_at, @last_run_result, @run_count, @in_flight, @enabled, @created_at)`,
      ),
      getById: db.prepare(`SELECT * FROM automations WHERE id = ?`),
      // rowid (insertion order) tiebreaks equal created_at so list order
      // matches the in-memory store's insertion order (same-ms creates).
      listAll: db.prepare(`SELECT * FROM automations ORDER BY created_at ASC, rowid ASC`),
      deleteById: db.prepare(`DELETE FROM automations WHERE id = ?`),
      setEnabled: db.prepare(`UPDATE automations SET enabled = @enabled WHERE id = @id`),
      forceDue: db.prepare(
        `UPDATE automations SET next_run_at = @now WHERE id = @id AND enabled = 1`,
      ),
      listDue: db.prepare(
        `SELECT * FROM automations
          WHERE enabled = 1 AND in_flight = 0
            AND next_run_at IS NOT NULL AND next_run_at <= @now
          ORDER BY next_run_at ASC, id ASC`,
      ),
      // Phase 8D.2 — trigger-mode poll input. rowid tiebreak matches the
      // in-memory store's insertion order (same created_at ms).
      listActiveTriggers: db.prepare(
        `SELECT * FROM automations
          WHERE enabled = 1 AND in_flight = 0 AND trigger_type IS NOT NULL
          ORDER BY created_at ASC, rowid ASC`,
      ),
      claimUpdate: db.prepare(
        `UPDATE automations
            SET in_flight = 1, run_count = run_count + 1, next_run_at = @next
          WHERE id = @id AND in_flight = 0`,
      ),
      // Phase 8D.2 — trigger claim does NOT touch next_run_at (always null).
      claimTriggerUpdate: db.prepare(
        `UPDATE automations
            SET in_flight = 1, run_count = run_count + 1
          WHERE id = @id AND in_flight = 0`,
      ),
      insertRunLog: db.prepare(
        `INSERT INTO automation_run_logs (automation_id, started_at, status)
         VALUES (@automation_id, @started_at, 'running')`,
      ),
      insertTriggerRunLog: db.prepare(
        `INSERT INTO automation_run_logs (automation_id, started_at, status, trigger_event)
         VALUES (@automation_id, @started_at, 'running', @trigger_event)`,
      ),
      trimPerAutomation: db.prepare(
        `DELETE FROM automation_run_logs
          WHERE automation_id = @id AND id NOT IN (
            SELECT id FROM automation_run_logs
             WHERE automation_id = @id
             ORDER BY started_at DESC, id DESC
             LIMIT @cap
          )`,
      ),
      trimGlobal: db.prepare(
        `DELETE FROM automation_run_logs
          WHERE id NOT IN (
            SELECT id FROM automation_run_logs
             ORDER BY started_at DESC, id DESC
             LIMIT @cap
          )`,
      ),
      listPending: db.prepare(
        `SELECT l.id AS run_log_id, l.automation_id AS automation_id,
                a.name AS name, a.prompt AS prompt, a.project_id AS project_id,
                l.trigger_event AS trigger_event
           FROM automation_run_logs l
           JOIN automations a ON a.id = l.automation_id
          WHERE l.status = 'running'
          ORDER BY l.started_at ASC, l.id ASC`,
      ),
      completeLog: db.prepare(
        `UPDATE automation_run_logs
            SET status = @status, finished_at = @now, error = @error
          WHERE id = @id AND status = 'running'`,
      ),
      clearInFlightForLog: db.prepare(
        `UPDATE automations
            SET in_flight = 0, last_run_at = @now, last_run_result = @status
          WHERE id = (SELECT automation_id FROM automation_run_logs WHERE id = @id)`,
      ),
      countOrphans: db.prepare(
        `SELECT COUNT(*) AS n FROM automation_run_logs WHERE status = 'running'`,
      ),
      failOrphanLogs: db.prepare(
        `UPDATE automation_run_logs
            SET status = 'failure', finished_at = @now, error = @error
          WHERE status = 'running'`,
      ),
      clearOrphanFlags: db.prepare(
        `UPDATE automations SET in_flight = 0, last_run_result = 'failure' WHERE in_flight = 1`,
      ),
      listRunLogs: db.prepare(
        `SELECT * FROM automation_run_logs WHERE automation_id = ? ORDER BY started_at DESC, id DESC`,
      ),
      listRunLogsLimit: db.prepare(
        `SELECT * FROM automation_run_logs WHERE automation_id = ? ORDER BY started_at DESC, id DESC LIMIT ?`,
      ),
    };

    this.claimTxn = db.transaction(
      (id: string, nextRunAt: string, nowIso: string): ClaimResult | undefined => {
        const updated = this.stmts.claimUpdate.run({ id, next: nextRunAt });
        if (updated.changes !== 1) return undefined;
        const inserted = this.stmts.insertRunLog.run({ automation_id: id, started_at: nowIso });
        const runLogId = Number(inserted.lastInsertRowid);
        this.stmts.trimPerAutomation.run({ id, cap: MAX_RUNS_PER_AUTOMATION });
        this.stmts.trimGlobal.run({ cap: MAX_TOTAL_RUNS });
        return { runLogId, nextRunAt };
      },
    );

    this.claimTriggerTxn = db.transaction(
      (id: string, triggerEventJson: string, nowIso: string): TriggerClaimResult | undefined => {
        const updated = this.stmts.claimTriggerUpdate.run({ id });
        if (updated.changes !== 1) return undefined;
        const inserted = this.stmts.insertTriggerRunLog.run({
          automation_id: id,
          started_at: nowIso,
          trigger_event: triggerEventJson,
        });
        const runLogId = Number(inserted.lastInsertRowid);
        this.stmts.trimPerAutomation.run({ id, cap: MAX_RUNS_PER_AUTOMATION });
        this.stmts.trimGlobal.run({ cap: MAX_TOTAL_RUNS });
        return { runLogId };
      },
    );

    this.completeTxn = db.transaction(
      (runLogId: number, status: 'success' | 'failure', nowIso: string, error: string | null): boolean => {
        const res = this.stmts.completeLog.run({ id: runLogId, status, now: nowIso, error });
        if (res.changes !== 1) return false;
        this.stmts.clearInFlightForLog.run({ id: runLogId, now: nowIso, status });
        return true;
      },
    );

    this.reconcileTxn = db.transaction((nowIso: string): number => {
      const { n } = this.stmts.countOrphans.get() as { n: number };
      if (n === 0) return 0;
      this.stmts.failOrphanLogs.run({
        now: nowIso,
        error: 'Interrupted (session ended before delivery)',
      });
      this.stmts.clearOrphanFlags.run();
      return n;
    });
  }

  create(input: CreateAutomationInput): AutomationRecord {
    validateCreateAutomationInput(input);
    const nowMs = this.now();
    const nowIso = new Date(nowMs).toISOString();
    const scheduleJson =
      input.schedule !== undefined ? serializeSchedule(input.schedule) : null;
    const id = generateAutomationId();
    this.stmts.insert.run({
      id,
      project_id: input.projectId ?? null,
      name: input.name,
      prompt: input.prompt,
      schedule: scheduleJson,
      trigger_type: input.triggerType ?? null,
      trigger_config: input.triggerType !== undefined ? input.triggerConfig ?? null : null,
      next_run_at:
        input.schedule !== undefined ? computeNextRun(input.schedule, new Date(nowMs)) : null,
      last_run_at: null,
      last_run_result: null,
      run_count: 0,
      in_flight: 0,
      enabled: (input.enabled ?? true) ? 1 : 0,
      created_at: nowIso,
    });
    const stored = this.get(id);
    if (stored === undefined) {
      throw new Error('SqliteAutomationStore.create: post-insert row vanished');
    }
    return stored;
  }

  get(id: string): AutomationRecord | undefined {
    const row = this.stmts.getById.get(id) as AutomationRow | undefined;
    return row ? rowToRecord(row) : undefined;
  }

  list(): readonly AutomationRecord[] {
    return (this.stmts.listAll.all() as AutomationRow[]).map(rowToRecord);
  }

  delete(id: string): boolean {
    return this.stmts.deleteById.run(id).changes > 0;
  }

  setEnabled(id: string, enabled: boolean): boolean {
    return this.stmts.setEnabled.run({ id, enabled: enabled ? 1 : 0 }).changes > 0;
  }

  forceDue(id: string, nowIso: string): boolean {
    return this.stmts.forceDue.run({ id, now: nowIso }).changes > 0;
  }

  listDue(nowIso: string): readonly AutomationRecord[] {
    return (this.stmts.listDue.all({ now: nowIso }) as AutomationRow[]).map(rowToRecord);
  }

  listActiveTriggers(): readonly AutomationRecord[] {
    return (this.stmts.listActiveTriggers.all() as AutomationRow[]).map(rowToRecord);
  }

  claim(id: string, nextRunAt: string, nowIso: string): ClaimResult | undefined {
    return this.claimTxn(id, nextRunAt, nowIso);
  }

  claimTrigger(
    id: string,
    triggerEventJson: string,
    nowIso: string,
  ): TriggerClaimResult | undefined {
    return this.claimTriggerTxn(id, triggerEventJson, nowIso);
  }

  listPending(): readonly PendingRun[] {
    const rows = this.stmts.listPending.all() as PendingRow[];
    return rows.map((r) => ({
      runLogId: r.run_log_id,
      automationId: r.automation_id,
      automationName: r.name,
      prompt: r.prompt,
      projectId: r.project_id,
      triggerEvent: r.trigger_event,
    }));
  }

  completeRun(
    runLogId: number,
    status: 'success' | 'failure',
    nowIso: string,
    error?: string,
  ): boolean {
    return this.completeTxn(runLogId, status, nowIso, error ?? null);
  }

  markOrphansFailed(nowIso: string): number {
    return this.reconcileTxn(nowIso);
  }

  listRunLogs(automationId: string, limit?: number): readonly AutomationRunLog[] {
    const rows =
      limit !== undefined
        ? (this.stmts.listRunLogsLimit.all(automationId, limit) as RunLogRow[])
        : (this.stmts.listRunLogs.all(automationId) as RunLogRow[]);
    return rows.map(rowToRunLog);
  }
}

function rowToRecord(row: AutomationRow): AutomationRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    prompt: row.prompt,
    schedule: row.schedule !== null ? parseSchedule(row.schedule) : null,
    triggerType: row.trigger_type,
    triggerConfig: row.trigger_config,
    nextRunAt: row.next_run_at,
    lastRunAt: row.last_run_at,
    lastRunResult: row.last_run_result,
    runCount: row.run_count,
    inFlight: row.in_flight === 1,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
  };
}

function rowToRunLog(row: RunLogRow): AutomationRunLog {
  return {
    id: row.id,
    automationId: row.automation_id,
    taskId: row.task_id,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    status: (row.status as RunStatus | null) ?? null,
    error: row.error,
    triggerEvent: row.trigger_event,
  };
}
