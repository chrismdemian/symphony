/**
 * Phase 5E — SQLite-backed `SagaStore`. Behavior-identical to
 * `SagaRegistry` (see `saga-registry.ts`).
 *
 * Mirrors `SqliteTaskStore`'s patterns:
 *   - insertion order preserved via `insertion_seq` (MAX+1 on insert).
 *   - terminal-state immutability enforced at the boundary.
 *   - `onCorruptRow` callback for malformed `notes` JSON; default-skip
 *     so a single bad row can't break `list()`.
 *   - Notes are an append-only JSON array stored in-column.
 *   - Member status cache is a separate row in `saga_members`, updated
 *     by the rollup writer (`saga-rollup.ts`).
 */
import { randomBytes } from 'node:crypto';
import type { Database, Statement } from 'better-sqlite3';

import type { ProjectStore } from '../projects/types.js';
import { CorruptRecordError } from './errors.js';
import type { TaskNote, TaskStatus } from './types.js';
import {
  canTransitionSaga,
  isTerminalSagaStatus,
  DuplicateSagaMembershipError,
  InvalidSagaTransitionError,
  UnknownSagaError,
  type AddSagaMemberInput,
  type CreateSagaInput,
  type SagaListFilter,
  type SagaMemberRecord,
  type SagaMemberSnapshot,
  type SagaPatch,
  type SagaRecord,
  type SagaSnapshot,
  type SagaStatus,
  type SagaStore,
} from './saga-types.js';

interface SagaRow {
  id: string;
  description: string;
  status: SagaStatus;
  result: string | null;
  notes: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  insertion_seq: number;
}

interface SagaMemberRow {
  saga_id: string;
  task_id: string;
  project_id: string | null;
  status: TaskStatus;
  added_at: string;
}

export interface SqliteSagaStoreOptions {
  readonly now?: () => number;
  readonly idGenerator?: () => string;
  readonly onCorruptRow?: (err: CorruptRecordError) => void;
  readonly onSagaStatusChange?: (snapshot: SagaSnapshot) => void;
  /**
   * Optional project store for resolving `projectName` on snapshot.
   * When omitted, members surface their projectId verbatim (or
   * `(unregistered)` for null).
   */
  readonly projectStore?: ProjectStore;
}

function defaultIdGenerator(): string {
  return `sg-${randomBytes(4).toString('hex')}`;
}

export class SqliteSagaStore implements SagaStore {
  private readonly stmts: {
    insert: Statement;
    selectById: Statement;
    listAll: Statement;
    updateRow: Statement;
    nextSeq: Statement;
    insertMember: Statement;
    selectMemberByTask: Statement;
    selectMembersBySaga: Statement;
    updateMemberStatus: Statement;
  };
  private readonly now: () => number;
  private readonly genId: () => string;
  private readonly onCorruptRow: (err: CorruptRecordError) => void;
  private readonly onSagaStatusChange:
    | ((snapshot: SagaSnapshot) => void)
    | undefined;
  private readonly projectStore: ProjectStore | undefined;

  constructor(private readonly db: Database, opts: SqliteSagaStoreOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.genId = opts.idGenerator ?? defaultIdGenerator;
    this.onCorruptRow =
      opts.onCorruptRow ??
      ((err) => {
        void err;
      });
    this.onSagaStatusChange = opts.onSagaStatusChange;
    this.projectStore = opts.projectStore;
    this.stmts = {
      insert: db.prepare(
        `INSERT INTO sagas
           (id, description, status, result, notes, created_at, updated_at, completed_at, insertion_seq)
         VALUES
           (@id, @description, 'pending', NULL, '[]', @created_at, @updated_at, NULL, @insertion_seq)`,
      ),
      selectById: db.prepare(`SELECT * FROM sagas WHERE id = ?`),
      listAll: db.prepare(`SELECT * FROM sagas ORDER BY insertion_seq ASC`),
      updateRow: db.prepare(
        `UPDATE sagas SET
           status = @status,
           result = @result,
           notes = @notes,
           updated_at = @updated_at,
           completed_at = @completed_at
         WHERE id = @id`,
      ),
      nextSeq: db.prepare(
        `SELECT COALESCE(MAX(insertion_seq), 0) + 1 AS next FROM sagas`,
      ),
      insertMember: db.prepare(
        `INSERT INTO saga_members
           (saga_id, task_id, project_id, status, added_at)
         VALUES
           (@saga_id, @task_id, @project_id, 'pending', @added_at)`,
      ),
      selectMemberByTask: db.prepare(
        `SELECT * FROM saga_members WHERE task_id = ?`,
      ),
      selectMembersBySaga: db.prepare(
        `SELECT * FROM saga_members WHERE saga_id = ? ORDER BY added_at ASC, task_id ASC`,
      ),
      updateMemberStatus: db.prepare(
        `UPDATE saga_members SET status = @status WHERE task_id = @task_id`,
      ),
    };
  }

  list(filter: SagaListFilter = {}): SagaRecord[] {
    const rows = this.stmts.listAll.all() as SagaRow[];
    const statusSet = Array.isArray(filter.status)
      ? new Set(filter.status as readonly SagaStatus[])
      : typeof filter.status === 'string'
        ? new Set<SagaStatus>([filter.status])
        : null;
    const out: SagaRecord[] = [];
    for (const row of rows) {
      let record: SagaRecord;
      try {
        record = rowToSaga(row);
      } catch (err) {
        if (err instanceof CorruptRecordError) {
          this.onCorruptRow(err);
          continue;
        }
        throw err;
      }
      if (statusSet !== null && !statusSet.has(record.status)) continue;
      if (filter.projectId !== undefined) {
        const members = this.stmts.selectMembersBySaga.all(record.id) as SagaMemberRow[];
        if (!members.some((m) => m.project_id === filter.projectId)) continue;
      }
      out.push(record);
    }
    return out;
  }

  get(id: string): SagaRecord | undefined {
    const row = this.stmts.selectById.get(id) as SagaRow | undefined;
    if (!row) return undefined;
    return rowToSaga(row);
  }

  create(input: CreateSagaInput): SagaRecord {
    const description = input.description?.trim();
    if (!description) {
      throw new Error('SqliteSagaStore.create: description is required');
    }
    const id = this.freshId();
    const iso = new Date(this.now()).toISOString();
    const seq = (this.stmts.nextSeq.get() as { next: number }).next;
    this.stmts.insert.run({
      id,
      description,
      created_at: iso,
      updated_at: iso,
      insertion_seq: seq,
    });
    const record = this.get(id);
    if (!record) throw new Error('SqliteSagaStore.create: post-insert row vanished');
    return record;
  }

  update(id: string, patch: SagaPatch): SagaRecord {
    const existing = this.stmts.selectById.get(id) as SagaRow | undefined;
    if (!existing) throw new UnknownSagaError(id);
    const iso = new Date(this.now()).toISOString();
    const priorStatus = existing.status;

    let nextStatus: SagaStatus = existing.status;
    let completedAt: string | null = existing.completed_at;
    if (patch.status !== undefined) {
      if (!canTransitionSaga(existing.status, patch.status)) {
        throw new InvalidSagaTransitionError(existing.status, patch.status);
      }
      nextStatus = patch.status;
      if (isTerminalSagaStatus(patch.status) && completedAt === null) {
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

    const nextResult = patch.result !== undefined ? patch.result : existing.result;

    this.stmts.updateRow.run({
      id,
      status: nextStatus,
      result: nextResult,
      notes: JSON.stringify(notes),
      updated_at: iso,
      completed_at: completedAt,
    });

    const record = this.get(id);
    if (!record) throw new Error('SqliteSagaStore.update: post-update row vanished');
    if (
      this.onSagaStatusChange !== undefined &&
      patch.status !== undefined &&
      patch.status !== priorStatus
    ) {
      try {
        this.onSagaStatusChange(this.snapshotFor(record));
      } catch {
        // downstream consumer must not poison the update path
      }
    }
    return record;
  }

  snapshot(id: string): SagaSnapshot | undefined {
    const r = this.get(id);
    return r ? this.snapshotFor(r) : undefined;
  }

  snapshots(filter: SagaListFilter = {}): SagaSnapshot[] {
    return this.list(filter).map((r) => this.snapshotFor(r));
  }

  size(): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS c FROM sagas`).get() as { c: number };
    return row.c;
  }

  addMember(input: AddSagaMemberInput): SagaMemberRecord {
    const saga = this.stmts.selectById.get(input.sagaId) as SagaRow | undefined;
    if (!saga) throw new UnknownSagaError(input.sagaId);
    const existing = this.stmts.selectMemberByTask.get(input.taskId) as
      | SagaMemberRow
      | undefined;
    if (existing !== undefined) {
      throw new DuplicateSagaMembershipError(input.taskId, existing.saga_id);
    }
    const iso = new Date(this.now()).toISOString();
    this.stmts.insertMember.run({
      saga_id: input.sagaId,
      task_id: input.taskId,
      project_id: input.projectId,
      added_at: iso,
    });
    // Bump the saga's updated_at so the listing surface reflects activity.
    this.db
      .prepare(`UPDATE sagas SET updated_at = @updated_at WHERE id = @id`)
      .run({ id: input.sagaId, updated_at: iso });
    return {
      sagaId: input.sagaId,
      taskId: input.taskId,
      projectId: input.projectId,
      status: 'pending',
      addedAt: iso,
    };
  }

  findMemberByTaskId(taskId: string): SagaMemberRecord | undefined {
    const row = this.stmts.selectMemberByTask.get(taskId) as SagaMemberRow | undefined;
    if (!row) return undefined;
    return memberRowToRecord(row);
  }

  listMembers(sagaId: string): readonly SagaMemberRecord[] {
    const rows = this.stmts.selectMembersBySaga.all(sagaId) as SagaMemberRow[];
    return rows.map(memberRowToRecord);
  }

  updateMemberStatus(
    taskId: string,
    status: TaskStatus,
  ): SagaMemberRecord | undefined {
    const existing = this.stmts.selectMemberByTask.get(taskId) as
      | SagaMemberRow
      | undefined;
    if (!existing) return undefined;
    if (existing.status === status) return memberRowToRecord(existing);
    this.stmts.updateMemberStatus.run({ task_id: taskId, status });
    const after = this.stmts.selectMemberByTask.get(taskId) as SagaMemberRow | undefined;
    return after ? memberRowToRecord(after) : undefined;
  }

  private snapshotFor(record: SagaRecord): SagaSnapshot {
    const memberRows = this.stmts.selectMembersBySaga.all(record.id) as SagaMemberRow[];
    const members: SagaMemberSnapshot[] = memberRows.map((row) => ({
      sagaId: row.saga_id,
      taskId: row.task_id,
      projectId: row.project_id,
      projectName: this.resolveProjectName(row.project_id),
      status: row.status,
      addedAt: row.added_at,
    }));
    return {
      id: record.id,
      description: record.description,
      status: record.status,
      notes: record.notes.slice(),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      members,
      ...(record.result !== undefined ? { result: record.result } : {}),
      ...(record.completedAt !== undefined ? { completedAt: record.completedAt } : {}),
    };
  }

  private resolveProjectName(projectId: string | null): string {
    if (projectId === null) return '(unregistered)';
    if (this.projectStore === undefined) return projectId;
    const proj = this.projectStore.get(projectId);
    return proj ? proj.name : '(unregistered)';
  }

  private freshId(): string {
    for (let i = 0; i < 8; i += 1) {
      const candidate = this.genId();
      const hit = this.stmts.selectById.get(candidate);
      if (!hit) return candidate;
    }
    throw new Error('SqliteSagaStore.create: id generator produced 8 collisions in a row');
  }
}

function parseNotes(row: SagaRow): TaskNote[] {
  try {
    const parsed = JSON.parse(row.notes);
    if (!Array.isArray(parsed)) {
      throw new CorruptRecordError('sagas', row.id, 'notes', 'not an array');
    }
    return parsed as TaskNote[];
  } catch (err) {
    if (err instanceof CorruptRecordError) throw err;
    throw new CorruptRecordError('sagas', row.id, 'notes', (err as Error).message);
  }
}

function rowToSaga(row: SagaRow): SagaRecord {
  return {
    id: row.id,
    description: row.description,
    status: row.status,
    notes: parseNotes(row),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.result !== null ? { result: row.result } : {}),
    ...(row.completed_at !== null ? { completedAt: row.completed_at } : {}),
  };
}

function memberRowToRecord(row: SagaMemberRow): SagaMemberRecord {
  return {
    sagaId: row.saga_id,
    taskId: row.task_id,
    projectId: row.project_id,
    status: row.status,
    addedAt: row.added_at,
  };
}
