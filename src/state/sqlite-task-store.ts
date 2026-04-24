import { randomBytes } from 'node:crypto';
import type { Database, Statement } from 'better-sqlite3';
import {
  canTransition,
  InvalidTaskTransitionError,
  isTerminalStatus,
  UnknownTaskError,
  type CreateTaskInput,
  type TaskListFilter,
  type TaskNote,
  type TaskPatch,
  type TaskRecord,
  type TaskSnapshot,
  type TaskStatus,
  type TaskStore,
} from './types.js';
import { toTaskSnapshot } from './task-registry.js';
import { CorruptRecordError } from './errors.js';

interface TaskRow {
  id: string;
  project_id: string;
  description: string;
  status: TaskStatus;
  priority: number;
  worker_id: string | null;
  depends_on: string;
  notes: string;
  result: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  insertion_seq: number;
}

export interface SqliteTaskStoreOptions {
  readonly now?: () => number;
  readonly idGenerator?: () => string;
  /**
   * Phase 2B.1 audit M5 — `list()` must not crash on a single corrupt
   * JSON column. Default: skip the row. Override to rethrow (strict
   * mode) or report via a logger.
   */
  readonly onCorruptRow?: (err: CorruptRecordError) => void;
}

function defaultIdGenerator(): string {
  return `tk-${randomBytes(4).toString('hex')}`;
}

/**
 * SQLite-backed `TaskStore` — behavior-identical to `task-registry.ts`:
 *   - `list` returns insertion order (preserved via `insertion_seq`)
 *   - `pending → {in_progress, cancelled, failed}` etc. state machine
 *   - append-only notes (JSON array in-column)
 *   - integer-only priority (SQLite would silently coerce 1.5 → 1; we reject at boundary)
 *   - 8 id-collision retries before giving up
 *
 * The Phase 2A.3 audit M3 rule (integer priority) is enforced at the
 * boundary because SQLite's `INTEGER` accepts floats and truncates.
 */
export class SqliteTaskStore implements TaskStore {
  private readonly stmts: {
    insert: Statement;
    selectById: Statement;
    listAll: Statement;
    updateStatusAndNotes: Statement;
    nextSeq: Statement;
  };
  private readonly now: () => number;
  private readonly genId: () => string;
  private readonly onCorruptRow: (err: CorruptRecordError) => void;

  constructor(private readonly db: Database, opts: SqliteTaskStoreOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.genId = opts.idGenerator ?? defaultIdGenerator;
    this.onCorruptRow =
      opts.onCorruptRow ??
      ((err) => {
        // Default: silent skip (TUI logs via Phase 3's diagnostics pipe
        // when that lands). Strict mode: pass `(err) => { throw err; }`.
        void err;
      });
    this.stmts = {
      insert: db.prepare(
        `INSERT INTO tasks
           (id, project_id, description, status, priority, worker_id,
            depends_on, notes, result, created_at, updated_at, completed_at, insertion_seq)
         VALUES
           (@id, @project_id, @description, 'pending', @priority, NULL,
            @depends_on, '[]', NULL, @created_at, @updated_at, NULL, @insertion_seq)`,
      ),
      selectById: db.prepare(`SELECT * FROM tasks WHERE id = ?`),
      listAll: db.prepare(
        `SELECT * FROM tasks ORDER BY insertion_seq ASC`,
      ),
      updateStatusAndNotes: db.prepare(
        `UPDATE tasks SET
           status = @status,
           priority = @priority,
           worker_id = @worker_id,
           depends_on = @depends_on,
           notes = @notes,
           result = @result,
           updated_at = @updated_at,
           completed_at = @completed_at
         WHERE id = @id`,
      ),
      nextSeq: db.prepare(
        `SELECT COALESCE(MAX(insertion_seq), 0) + 1 AS next FROM tasks`,
      ),
    };
  }

  list(filter: TaskListFilter = {}): TaskRecord[] {
    const rows = this.stmts.listAll.all() as TaskRow[];
    const statusSet = Array.isArray(filter.status)
      ? new Set(filter.status)
      : typeof filter.status === 'string'
        ? new Set<TaskStatus>([filter.status])
        : null;
    const out: TaskRecord[] = [];
    for (const row of rows) {
      if (filter.projectId !== undefined && row.project_id !== filter.projectId) continue;
      if (statusSet !== null && !statusSet.has(row.status)) continue;
      // Phase 2B.1 audit M5: one corrupt JSON row must not kill the batch.
      // Skip + report; callers see a consistent list minus the bad rows.
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

  get(id: string): TaskRecord | undefined {
    const row = this.stmts.selectById.get(id) as TaskRow | undefined;
    if (!row) return undefined;
    // `get()` does NOT swallow — a deliberate single-id read expects
    // a correct record or a thrown error. `list()` is the lenient path.
    return rowToRecord(row);
  }

  create(input: CreateTaskInput): TaskRecord {
    if (!input.projectId || !input.projectId.trim()) {
      throw new Error('SqliteTaskStore.create: projectId is required');
    }
    const description = input.description?.trim();
    if (!description) {
      throw new Error('SqliteTaskStore.create: description is required');
    }
    const priority = input.priority ?? 0;
    if (!Number.isInteger(priority)) {
      throw new Error(`SqliteTaskStore.create: priority must be an integer, got ${priority}`);
    }
    const id = this.freshId();
    const iso = new Date(this.now()).toISOString();
    const seq = (this.stmts.nextSeq.get() as { next: number }).next;
    const dependsOn = input.dependsOn ? [...input.dependsOn] : [];
    this.stmts.insert.run({
      id,
      project_id: input.projectId,
      description,
      priority,
      depends_on: JSON.stringify(dependsOn),
      created_at: iso,
      updated_at: iso,
      insertion_seq: seq,
    });
    const record = this.get(id);
    if (!record) throw new Error('SqliteTaskStore.create: post-insert row vanished');
    return record;
  }

  update(id: string, patch: TaskPatch): TaskRecord {
    const existing = this.stmts.selectById.get(id) as TaskRow | undefined;
    if (!existing) throw new UnknownTaskError(id);
    const iso = new Date(this.now()).toISOString();

    let nextStatus: TaskStatus = existing.status;
    let completedAt: string | null = existing.completed_at;
    if (patch.status !== undefined) {
      if (!canTransition(existing.status, patch.status)) {
        throw new InvalidTaskTransitionError(existing.status, patch.status);
      }
      nextStatus = patch.status;
      if (isTerminalStatus(patch.status) && completedAt === null) {
        completedAt = iso;
      }
    }

    const notes = parseNotes(existing);
    if (patch.notes !== undefined) {
      const text = patch.notes.trim();
      if (text.length > 0) {
        notes.push({ at: iso, text });
      }
    }

    const nextWorkerId =
      patch.workerId !== undefined ? patch.workerId : existing.worker_id;
    const nextResult =
      patch.result !== undefined ? patch.result : existing.result;

    this.stmts.updateStatusAndNotes.run({
      id,
      status: nextStatus,
      priority: existing.priority,
      worker_id: nextWorkerId,
      depends_on: existing.depends_on,
      notes: JSON.stringify(notes),
      result: nextResult,
      updated_at: iso,
      completed_at: completedAt,
    });
    const record = this.get(id);
    if (!record) throw new Error('SqliteTaskStore.update: post-update row vanished');
    return record;
  }

  snapshot(id: string): TaskSnapshot | undefined {
    const r = this.get(id);
    return r ? toTaskSnapshot({ ...r, notes: r.notes.slice() }) : undefined;
  }

  snapshots(filter: TaskListFilter = {}): TaskSnapshot[] {
    return this.list(filter).map((r) => toTaskSnapshot({ ...r, notes: r.notes.slice() }));
  }

  size(): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS c FROM tasks`).get() as { c: number };
    return row.c;
  }

  private freshId(): string {
    for (let i = 0; i < 8; i += 1) {
      const candidate = this.genId();
      const hit = this.stmts.selectById.get(candidate);
      if (!hit) return candidate;
    }
    throw new Error('SqliteTaskStore.create: id generator produced 8 collisions in a row');
  }
}

function parseNotes(row: TaskRow): TaskNote[] {
  try {
    const parsed = JSON.parse(row.notes);
    if (!Array.isArray(parsed)) {
      throw new CorruptRecordError('tasks', row.id, 'notes', 'not an array');
    }
    return parsed as TaskNote[];
  } catch (err) {
    if (err instanceof CorruptRecordError) throw err;
    throw new CorruptRecordError('tasks', row.id, 'notes', (err as Error).message);
  }
}

function parseDependsOn(row: TaskRow): string[] {
  try {
    const parsed = JSON.parse(row.depends_on);
    if (!Array.isArray(parsed)) {
      throw new CorruptRecordError('tasks', row.id, 'depends_on', 'not an array');
    }
    return parsed as string[];
  } catch (err) {
    if (err instanceof CorruptRecordError) throw err;
    throw new CorruptRecordError('tasks', row.id, 'depends_on', (err as Error).message);
  }
}

function rowToRecord(row: TaskRow): TaskRecord {
  const record: TaskRecord = {
    id: row.id,
    projectId: row.project_id,
    description: row.description,
    status: row.status,
    priority: row.priority,
    dependsOn: parseDependsOn(row),
    notes: parseNotes(row),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.worker_id !== null ? { workerId: row.worker_id } : {}),
    ...(row.result !== null ? { result: row.result } : {}),
    ...(row.completed_at !== null ? { completedAt: row.completed_at } : {}),
  };
  return record;
}
