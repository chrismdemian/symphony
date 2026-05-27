/**
 * Phase 5E — in-memory `SagaStore` test double. SQLite-backed
 * `SqliteSagaStore` is the production impl (`sqlite-saga-store.ts`);
 * the two are behavior-identical.
 *
 * Mirrors `TaskRegistry`'s shape: insertion-ordered list, defensive
 * shallow clones on read, terminal-state immutability, single-fire
 * status callback, atomic note append. The status state machine is the
 * `SagaStatus` 5-state machine (see `saga-types.ts`).
 */
import { randomBytes } from 'node:crypto';

import type { ProjectStore } from '../projects/types.js';
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

export interface SagaRegistryOptions {
  readonly now?: () => number;
  readonly idGenerator?: () => string;
  /**
   * Optional `ProjectStore` for resolving `projectName` on snapshot. When
   * omitted, members surface their projectId verbatim (or `(unregistered)`
   * for null) — useful for unit tests that don't wire a real store.
   */
  readonly projectStore?: ProjectStore;
  /**
   * Fired AFTER `update()` writes a status transition. Receives a frozen
   * snapshot (mirrors `TaskRegistryOptions.onTaskStatusChange`). Errors
   * swallowed so a misbehaving consumer cannot poison the update path.
   */
  readonly onSagaStatusChange?: (snapshot: SagaSnapshot) => void;
}

function defaultIdGenerator(): string {
  return `sg-${randomBytes(4).toString('hex')}`;
}

export class SagaRegistry implements SagaStore {
  private readonly sagas = new Map<string, SagaRecord>();
  private readonly insertionOrder: string[] = [];
  /** task_id → member row. UNIQUE per task. */
  private readonly memberByTaskId = new Map<string, SagaMemberRecord>();
  /** saga_id → array of task ids in insertion order. */
  private readonly membersBySagaId = new Map<string, string[]>();
  private readonly now: () => number;
  private readonly genId: () => string;
  private readonly projectStore: ProjectStore | undefined;
  private readonly onSagaStatusChange:
    | ((snapshot: SagaSnapshot) => void)
    | undefined;

  constructor(opts: SagaRegistryOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.genId = opts.idGenerator ?? defaultIdGenerator;
    this.projectStore = opts.projectStore;
    this.onSagaStatusChange = opts.onSagaStatusChange;
  }

  list(filter: SagaListFilter = {}): SagaRecord[] {
    const statusSet = Array.isArray(filter.status)
      ? new Set(filter.status as readonly SagaStatus[])
      : typeof filter.status === 'string'
        ? new Set<SagaStatus>([filter.status])
        : null;
    const out: SagaRecord[] = [];
    for (const id of this.insertionOrder) {
      const record = this.sagas.get(id);
      if (record === undefined) continue;
      if (statusSet !== null && !statusSet.has(record.status)) continue;
      if (filter.projectId !== undefined) {
        const members = this.membersBySagaId.get(id) ?? [];
        const matches = members.some((tid) => {
          const m = this.memberByTaskId.get(tid);
          return m !== undefined && m.projectId === filter.projectId;
        });
        if (!matches) continue;
      }
      out.push(cloneSaga(record));
    }
    return out;
  }

  get(id: string): SagaRecord | undefined {
    const r = this.sagas.get(id);
    return r ? cloneSaga(r) : undefined;
  }

  create(input: CreateSagaInput): SagaRecord {
    const description = input.description?.trim();
    if (!description) {
      throw new Error('SagaRegistry.create: description is required');
    }
    const id = this.freshId();
    const iso = new Date(this.now()).toISOString();
    const record: SagaRecord = {
      id,
      description,
      status: 'pending',
      notes: [],
      createdAt: iso,
      updatedAt: iso,
    };
    this.sagas.set(id, record);
    this.insertionOrder.push(id);
    this.membersBySagaId.set(id, []);
    return cloneSaga(record);
  }

  update(id: string, patch: SagaPatch): SagaRecord {
    const record = this.sagas.get(id);
    if (!record) throw new UnknownSagaError(id);
    const iso = new Date(this.now()).toISOString();
    const priorStatus = record.status;
    if (patch.status !== undefined) {
      if (!canTransitionSaga(record.status, patch.status)) {
        throw new InvalidSagaTransitionError(record.status, patch.status);
      }
      record.status = patch.status;
      if (isTerminalSagaStatus(patch.status) && record.completedAt === undefined) {
        record.completedAt = iso;
      }
    }
    if (patch.notes !== undefined) {
      const text = patch.notes.trim();
      if (text.length > 0) {
        const entry: TaskNote = { at: iso, text };
        record.notes.push(entry);
      }
    }
    if (patch.result !== undefined) {
      record.result = patch.result;
    }
    record.updatedAt = iso;
    if (
      this.onSagaStatusChange !== undefined &&
      patch.status !== undefined &&
      patch.status !== priorStatus
    ) {
      try {
        this.onSagaStatusChange(this.snapshotInternal(record));
      } catch {
        // downstream consumer must not poison the update path
      }
    }
    return cloneSaga(record);
  }

  snapshot(id: string): SagaSnapshot | undefined {
    const r = this.sagas.get(id);
    return r ? this.snapshotInternal(r) : undefined;
  }

  snapshots(filter: SagaListFilter = {}): SagaSnapshot[] {
    return this.list(filter).map((r) => this.snapshotInternal(r));
  }

  size(): number {
    return this.sagas.size;
  }

  addMember(input: AddSagaMemberInput): SagaMemberRecord {
    const saga = this.sagas.get(input.sagaId);
    if (saga === undefined) throw new UnknownSagaError(input.sagaId);
    const existing = this.memberByTaskId.get(input.taskId);
    if (existing !== undefined) {
      throw new DuplicateSagaMembershipError(input.taskId, existing.sagaId);
    }
    const iso = new Date(this.now()).toISOString();
    const member: SagaMemberRecord = {
      sagaId: input.sagaId,
      taskId: input.taskId,
      projectId: input.projectId,
      status: 'pending',
      addedAt: iso,
    };
    this.memberByTaskId.set(input.taskId, member);
    const bucket = this.membersBySagaId.get(input.sagaId);
    if (bucket === undefined) {
      // Defensive — `create()` initializes the bucket; bypass-via-API
      // tests might mutate sagas without it.
      this.membersBySagaId.set(input.sagaId, [input.taskId]);
    } else {
      bucket.push(input.taskId);
    }
    saga.updatedAt = iso;
    return { ...member };
  }

  findMemberByTaskId(taskId: string): SagaMemberRecord | undefined {
    const m = this.memberByTaskId.get(taskId);
    return m ? { ...m } : undefined;
  }

  listMembers(sagaId: string): readonly SagaMemberRecord[] {
    const ids = this.membersBySagaId.get(sagaId) ?? [];
    const out: SagaMemberRecord[] = [];
    for (const tid of ids) {
      const m = this.memberByTaskId.get(tid);
      if (m !== undefined) out.push({ ...m });
    }
    return out;
  }

  updateMemberStatus(
    taskId: string,
    status: TaskStatus,
  ): SagaMemberRecord | undefined {
    const m = this.memberByTaskId.get(taskId);
    if (m === undefined) return undefined;
    if (m.status === status) return { ...m };
    m.status = status;
    return { ...m };
  }

  private snapshotInternal(record: SagaRecord): SagaSnapshot {
    const memberIds = this.membersBySagaId.get(record.id) ?? [];
    const members: SagaMemberSnapshot[] = [];
    for (const tid of memberIds) {
      const m = this.memberByTaskId.get(tid);
      if (m === undefined) continue;
      members.push({
        sagaId: m.sagaId,
        taskId: m.taskId,
        projectId: m.projectId,
        projectName: this.resolveProjectName(m.projectId),
        status: m.status,
        addedAt: m.addedAt,
      });
    }
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
      if (!this.sagas.has(candidate)) return candidate;
    }
    throw new Error('SagaRegistry.create: id generator produced 8 collisions in a row');
  }
}

function cloneSaga(r: SagaRecord): SagaRecord {
  return {
    id: r.id,
    description: r.description,
    status: r.status,
    notes: r.notes.slice(),
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    ...(r.result !== undefined ? { result: r.result } : {}),
    ...(r.completedAt !== undefined ? { completedAt: r.completedAt } : {}),
  };
}
