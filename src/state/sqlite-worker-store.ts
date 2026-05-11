import type { Database, Statement } from 'better-sqlite3';
import type { TokenUsage, WorkerStatus } from '../workers/types.js';
import type { AutonomyTier, WorkerRole } from '../orchestrator/types.js';
import { CorruptRecordError } from './errors.js';

/**
 * Persisted shape of a worker — mirrors the `workers` table at
 * `src/state/migrations/0001_initial.sql:56-76`. Distinct from
 * `WorkerRecord` because the persisted form has no live `Worker` handle,
 * `CircularBuffer`, or `detach` callback. Phase 2B.1b crash-recovery only
 * needs metadata + sessionId — the live process already died with the
 * orchestrator, so resume is user-driven via `resume_worker`.
 */
export interface PersistedWorkerRecord {
  readonly id: string;
  /** null when the worker spawned against an unregistered absolute-path project. */
  readonly projectId: string | null;
  readonly taskId: string | null;
  readonly worktreePath: string;
  readonly role: WorkerRole;
  readonly featureIntent: string;
  readonly taskDescription: string;
  readonly autonomyTier: AutonomyTier;
  readonly dependsOn: readonly string[];
  readonly model?: string;
  readonly sessionId?: string;
  readonly status: WorkerStatus;
  readonly createdAt: string;
  readonly completedAt?: string;
  readonly lastEventAt?: string;
  readonly exitCode?: number | null;
  readonly exitSignal?: NodeJS.Signals | null;
  readonly costUsd?: number;
  /**
   * Phase 3N.1 — cumulative token usage from the worker's most recent
   * `result` event. Mirrors `costUsd` semantics (last-wins, undefined
   * until the first `result`, explicitly cleared on resume). Absent when
   * no token data has been observed.
   */
  readonly sessionUsage?: TokenUsage;
}

export interface WorkerStoreListFilter {
  readonly projectId?: string | null;
  readonly status?: WorkerStatus | readonly WorkerStatus[];
}

/**
 * Persistence seam used by `WorkerRegistry` to write-through every
 * mutation. The in-memory registry stays the authoritative source for
 * LIVE state (Worker handle + buffer); the store mirrors the metadata
 * for crash recovery and "where was I?" snapshots.
 */
export interface WorkerStore {
  insert(record: PersistedWorkerRecord): void;
  update(id: string, patch: WorkerStoreUpdatePatch): void;
  delete(id: string): void;
  get(id: string): PersistedWorkerRecord | undefined;
  list(filter?: WorkerStoreListFilter): PersistedWorkerRecord[];
  size(): number;
}

/**
 * Subset of `PersistedWorkerRecord` that mutates after insert. Each field
 * uses `T | null` semantics where applicable so callers can EXPLICITLY
 * clear a column. Absent keys are left untouched (preserve existing
 * value); `null` writes NULL to the column. This matters for `replace()`
 * — resuming a crashed worker must clear the prior `completedAt` /
 * `exitCode` / `exitSignal` rather than carrying them forward.
 */
export interface WorkerStoreUpdatePatch {
  readonly status?: WorkerStatus;
  readonly sessionId?: string | null;
  readonly completedAt?: string | null;
  readonly lastEventAt?: string | null;
  readonly exitCode?: number | null;
  readonly exitSignal?: NodeJS.Signals | null;
  readonly costUsd?: number | null;
  /**
   * Phase 3N.1 — composite token-usage patch. One logical concern, four
   * columns. `null` clears all four (resume edge — mirrors `costUsd`).
   * `T | null` semantics like the rest of the patch.
   */
  readonly sessionUsage?: TokenUsage | null;
}

interface WorkerRow {
  id: string;
  project_id: string | null;
  task_id: string | null;
  session_id: string | null;
  worktree_path: string;
  status: WorkerStatus;
  role: WorkerRole;
  feature_intent: string;
  task_description: string;
  model: string | null;
  autonomy_tier: AutonomyTier;
  depends_on: string;
  created_at: string;
  completed_at: string | null;
  last_event_at: string | null;
  exit_code: number | null;
  exit_signal: string | null;
  cost_usd: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
}

export interface SqliteWorkerStoreOptions {
  /**
   * Phase 2B.1 audit M5 — `list()` must not crash on a single corrupt
   * `depends_on` JSON row. Default: skip the row. Override to rethrow
   * (strict mode for tests) or report via a logger.
   */
  readonly onCorruptRow?: (err: CorruptRecordError) => void;
}

/**
 * SQLite-backed `WorkerStore`. Mirrors the four 2B.1 store shapes —
 * prepared statements, lenient batch reads, strict single-row reads.
 *
 * Updates fetch-merge-write (synchronous, single-process safe). Single-
 * Node-process operation is race-free because better-sqlite3 is sync.
 * Cross-process WAL serialization protects against torn writes; if two
 * orchestrators ever share a DB they'd race on read-modify-write here —
 * Phase 2B.2 should wrap in `db.transaction()` if that becomes a goal.
 */
export class SqliteWorkerStore implements WorkerStore {
  private readonly stmts: {
    insert: Statement;
    selectById: Statement;
    listAll: Statement;
    update: Statement;
    delete: Statement;
    count: Statement;
  };
  private readonly onCorruptRow: (err: CorruptRecordError) => void;

  constructor(private readonly db: Database, opts: SqliteWorkerStoreOptions = {}) {
    this.onCorruptRow =
      opts.onCorruptRow ??
      ((err) => {
        // Default: silent skip. TUI surfaces via diagnostics once Phase 3 lands.
        void err;
      });
    this.stmts = {
      insert: db.prepare(
        `INSERT INTO workers
           (id, project_id, task_id, session_id, worktree_path, status, role,
            feature_intent, task_description, model, autonomy_tier, depends_on,
            created_at, completed_at, last_event_at, exit_code, exit_signal, cost_usd,
            input_tokens, output_tokens, cache_read_tokens, cache_write_tokens)
         VALUES
           (@id, @project_id, @task_id, @session_id, @worktree_path, @status, @role,
            @feature_intent, @task_description, @model, @autonomy_tier, @depends_on,
            @created_at, @completed_at, @last_event_at, @exit_code, @exit_signal, @cost_usd,
            @input_tokens, @output_tokens, @cache_read_tokens, @cache_write_tokens)`,
      ),
      selectById: db.prepare(`SELECT * FROM workers WHERE id = ?`),
      listAll: db.prepare(`SELECT * FROM workers ORDER BY created_at ASC`),
      update: db.prepare(
        `UPDATE workers SET
           status = @status,
           session_id = @session_id,
           completed_at = @completed_at,
           last_event_at = @last_event_at,
           exit_code = @exit_code,
           exit_signal = @exit_signal,
           cost_usd = @cost_usd,
           input_tokens = @input_tokens,
           output_tokens = @output_tokens,
           cache_read_tokens = @cache_read_tokens,
           cache_write_tokens = @cache_write_tokens
         WHERE id = @id`,
      ),
      delete: db.prepare(`DELETE FROM workers WHERE id = ?`),
      count: db.prepare(`SELECT COUNT(*) AS c FROM workers`),
    };
  }

  insert(record: PersistedWorkerRecord): void {
    this.stmts.insert.run({
      id: record.id,
      project_id: record.projectId,
      task_id: record.taskId,
      session_id: record.sessionId ?? null,
      worktree_path: record.worktreePath,
      status: record.status,
      role: record.role,
      feature_intent: record.featureIntent,
      task_description: record.taskDescription,
      model: record.model ?? null,
      autonomy_tier: record.autonomyTier,
      depends_on: JSON.stringify([...record.dependsOn]),
      created_at: record.createdAt,
      completed_at: record.completedAt ?? null,
      last_event_at: record.lastEventAt ?? null,
      exit_code: record.exitCode ?? null,
      exit_signal: record.exitSignal ?? null,
      cost_usd: record.costUsd ?? null,
      input_tokens: record.sessionUsage?.inputTokens ?? null,
      output_tokens: record.sessionUsage?.outputTokens ?? null,
      cache_read_tokens: record.sessionUsage?.cacheReadTokens ?? null,
      cache_write_tokens: record.sessionUsage?.cacheWriteTokens ?? null,
    });
  }

  update(id: string, patch: WorkerStoreUpdatePatch): void {
    const existing = this.stmts.selectById.get(id) as WorkerRow | undefined;
    if (!existing) return; // mirrors WorkerRegistry's no-op on unknown id
    // `!== undefined` semantics throughout so callers can explicitly
    // clear nullable columns by passing `null` (M1 fix from 2B.1b review).
    // Phase 3N.1: `sessionUsage` is a composite patch — `null` clears all
    // four columns, an object writes all four, omission preserves all
    // four. Mid-state (clearing only one of the four) is not exposed —
    // CLI's roll-up is a single object, never split.
    const usage = patch.sessionUsage;
    const usagePassed = usage !== undefined;
    this.stmts.update.run({
      id,
      status: patch.status ?? existing.status,
      session_id: patch.sessionId !== undefined ? patch.sessionId : existing.session_id,
      completed_at: patch.completedAt !== undefined ? patch.completedAt : existing.completed_at,
      last_event_at: patch.lastEventAt !== undefined ? patch.lastEventAt : existing.last_event_at,
      exit_code: patch.exitCode !== undefined ? patch.exitCode : existing.exit_code,
      exit_signal: patch.exitSignal !== undefined ? patch.exitSignal : existing.exit_signal,
      cost_usd: patch.costUsd !== undefined ? patch.costUsd : existing.cost_usd,
      input_tokens: usagePassed
        ? (usage === null ? null : usage.inputTokens)
        : existing.input_tokens,
      output_tokens: usagePassed
        ? (usage === null ? null : usage.outputTokens)
        : existing.output_tokens,
      cache_read_tokens: usagePassed
        ? (usage === null ? null : usage.cacheReadTokens)
        : existing.cache_read_tokens,
      cache_write_tokens: usagePassed
        ? (usage === null ? null : usage.cacheWriteTokens)
        : existing.cache_write_tokens,
    });
  }

  delete(id: string): void {
    this.stmts.delete.run(id);
  }

  get(id: string): PersistedWorkerRecord | undefined {
    const row = this.stmts.selectById.get(id) as WorkerRow | undefined;
    if (!row) return undefined;
    // Strict: targeted reads expect correctness or a thrown error (audit M5).
    return rowToRecord(row);
  }

  list(filter: WorkerStoreListFilter = {}): PersistedWorkerRecord[] {
    const rows = this.stmts.listAll.all() as WorkerRow[];
    const statusSet = Array.isArray(filter.status)
      ? new Set(filter.status)
      : typeof filter.status === 'string'
        ? new Set<WorkerStatus>([filter.status])
        : null;
    const out: PersistedWorkerRecord[] = [];
    for (const row of rows) {
      if (filter.projectId !== undefined && row.project_id !== filter.projectId) continue;
      if (statusSet !== null && !statusSet.has(row.status)) continue;
      try {
        out.push(rowToRecord(row));
      } catch (err) {
        if (err instanceof CorruptRecordError) {
          this.onCorruptRow(err);
          continue;
        }
        throw err;
      }
    }
    return out;
  }

  size(): number {
    const row = this.stmts.count.get() as { c: number };
    return row.c;
  }
}

function parseDependsOn(row: WorkerRow): string[] {
  try {
    const parsed = JSON.parse(row.depends_on);
    if (!Array.isArray(parsed)) {
      throw new CorruptRecordError('workers', row.id, 'depends_on', 'not an array');
    }
    return parsed as string[];
  } catch (err) {
    if (err instanceof CorruptRecordError) throw err;
    throw new CorruptRecordError('workers', row.id, 'depends_on', (err as Error).message);
  }
}

function rowToRecord(row: WorkerRow): PersistedWorkerRecord {
  // Phase 3N.1: surface `sessionUsage` only when AT LEAST ONE of the four
  // token columns has a value. Workers that never emitted a `result`
  // event leave all four NULL, so the field stays absent. A partial set
  // (some columns NULL, some not) shouldn't happen in practice but we
  // coerce NULL → 0 inside the composite for that pathological case
  // rather than dropping data.
  const hasUsage =
    row.input_tokens !== null ||
    row.output_tokens !== null ||
    row.cache_read_tokens !== null ||
    row.cache_write_tokens !== null;
  const record: PersistedWorkerRecord = {
    id: row.id,
    projectId: row.project_id,
    taskId: row.task_id,
    worktreePath: row.worktree_path,
    role: row.role,
    featureIntent: row.feature_intent,
    taskDescription: row.task_description,
    autonomyTier: row.autonomy_tier,
    dependsOn: parseDependsOn(row),
    status: row.status,
    createdAt: row.created_at,
    ...(row.session_id !== null ? { sessionId: row.session_id } : {}),
    ...(row.model !== null ? { model: row.model } : {}),
    ...(row.completed_at !== null ? { completedAt: row.completed_at } : {}),
    ...(row.last_event_at !== null ? { lastEventAt: row.last_event_at } : {}),
    ...(row.exit_code !== null ? { exitCode: row.exit_code } : {}),
    ...(row.exit_signal !== null ? { exitSignal: row.exit_signal as NodeJS.Signals } : {}),
    ...(row.cost_usd !== null ? { costUsd: row.cost_usd } : {}),
    ...(hasUsage
      ? {
          sessionUsage: {
            inputTokens: row.input_tokens ?? 0,
            outputTokens: row.output_tokens ?? 0,
            cacheReadTokens: row.cache_read_tokens ?? 0,
            cacheWriteTokens: row.cache_write_tokens ?? 0,
          },
        }
      : {}),
  };
  return record;
}
