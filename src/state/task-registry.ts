import { randomBytes } from 'node:crypto';
import type { ProjectStore } from '../projects/types.js';
import { isTaskReady } from '../orchestrator/task-deps.js';
import {
  canTransition,
  InvalidTaskTransitionError,
  isTerminalStatus,
  UnknownProjectIdError,
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

export interface TaskRegistryOptions {
  readonly now?: () => number;
  readonly idGenerator?: () => string;
  /**
   * Optional `ProjectStore` for FK-parity with `SqliteTaskStore`. When
   * supplied, `create()` rejects unknown projectIds with
   * `UnknownProjectIdError` instead of accepting any string. Phase 2B.1 m4.
   */
  readonly projectStore?: ProjectStore;
  /**
   * Phase 3P — fired AFTER `update()` writes a status transition.
   * Receives a frozen `TaskSnapshot` (readonly fields, defensive copy)
   * — NOT the live mutable record — so the dispatcher and any other
   * downstream consumer see the exact state at fire time even if
   * the record is mutated again before async work resumes. Mirrors
   * the immutability contract of `AutoMergeEvent` (3O.1).
   *
   * ONLY fired when `patch.status` causes an actual status change;
   * idempotent same-status updates (`canTransition(x, x) === true`) do
   * not fire. Non-status patches (notes, workerId, result) do not
   * fire either. Errors thrown by the callback are swallowed (mirrors
   * `WorkerLifecycleOptions.onWorkerStatusChange`).
   */
  readonly onTaskStatusChange?: (snapshot: TaskSnapshot) => void;
}

function defaultIdGenerator(): string {
  return `tk-${randomBytes(4).toString('hex')}`;
}

/**
 * In-memory `TaskStore`. Phase 2B swaps this for a SQLite-backed
 * implementation with the same interface. Ordering: `list` returns
 * insertion order — stable across process lifetime but not persistent.
 */
export class TaskRegistry implements TaskStore {
  private readonly records = new Map<string, TaskRecord>();
  private readonly now: () => number;
  private readonly genId: () => string;
  private readonly projectStore: ProjectStore | undefined;
  private readonly onTaskStatusChange: ((snapshot: TaskSnapshot) => void) | undefined;

  constructor(opts: TaskRegistryOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.genId = opts.idGenerator ?? defaultIdGenerator;
    this.projectStore = opts.projectStore;
    this.onTaskStatusChange = opts.onTaskStatusChange;
  }

  list(filter: TaskListFilter = {}): TaskRecord[] {
    const allRecords = Array.from(this.records.values());
    const statusSet = Array.isArray(filter.status)
      ? new Set(filter.status as readonly TaskStatus[])
      : typeof filter.status === 'string'
        ? new Set<TaskStatus>([filter.status])
        : null;
    return allRecords.filter((r) => {
      if (filter.projectId !== undefined && r.projectId !== filter.projectId) return false;
      if (statusSet !== null && !statusSet.has(r.status)) return false;
      // Phase 3P: readiness is evaluated against the FULL record set
      // so a cross-project dep gates correctly even when projectId
      // filter would hide the dep itself.
      if (filter.readyOnly === true && !isTaskReady(r, allRecords)) return false;
      return true;
    });
  }

  get(id: string): TaskRecord | undefined {
    return this.records.get(id);
  }

  create(input: CreateTaskInput): TaskRecord {
    if (!input.projectId || !input.projectId.trim()) {
      throw new Error('TaskRegistry.create: projectId is required');
    }
    const description = input.description?.trim();
    if (!description) {
      throw new Error('TaskRegistry.create: description is required');
    }
    const priority = input.priority ?? 0;
    // Phase 2A.3 audit M3: SQLite's INTEGER column silently coerces floats,
    // so reject non-integers at the boundary. Matches the MCP tool schema's
    // `z.number().int()` and keeps the 2B swap zero-touch.
    if (!Number.isInteger(priority)) {
      throw new Error(`TaskRegistry.create: priority must be an integer, got ${priority}`);
    }
    // Phase 2B.1 m4: FK-parity with SqliteTaskStore. Without DI, in-memory
    // mode silently accepted unknown projectIds; the `--in-memory` and
    // SQLite default modes diverged. When a projectStore is wired, reject.
    if (this.projectStore && !this.projectStore.get(input.projectId)) {
      throw new UnknownProjectIdError(input.projectId);
    }
    const id = this.freshId();
    const iso = new Date(this.now()).toISOString();
    const record: TaskRecord = {
      id,
      projectId: input.projectId,
      description,
      status: 'pending',
      priority,
      dependsOn: input.dependsOn ? [...input.dependsOn] : [],
      notes: [],
      createdAt: iso,
      updatedAt: iso,
    };
    this.records.set(id, record);
    return record;
  }

  update(id: string, patch: TaskPatch): TaskRecord {
    const record = this.records.get(id);
    if (!record) throw new UnknownTaskError(id);
    const iso = new Date(this.now()).toISOString();
    const priorStatus = record.status;

    if (patch.status !== undefined) {
      if (!canTransition(record.status, patch.status)) {
        throw new InvalidTaskTransitionError(record.status, patch.status);
      }
      record.status = patch.status;
      // Phase 2B.1 audit M4: stamp `completedAt` only on FIRST entry into
      // terminal state. An idempotent same-terminal update (allowed by
      // `canTransition(x, x) === true`) must NOT re-stamp — the audit
      // question "when did this task complete?" has one answer.
      if (isTerminalStatus(patch.status) && record.completedAt === undefined) {
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
    if (patch.workerId !== undefined) {
      record.workerId = patch.workerId;
    }
    if (patch.result !== undefined) {
      record.result = patch.result;
    }
    record.updatedAt = iso;
    // Phase 3P — fire ONLY on real status transitions. Same-status
    // idempotent updates (canTransition(x, x) === true) do not fire;
    // notes/workerId/result updates do not fire. Errors swallowed.
    // Pass a frozen snapshot so consumers see fire-time state even
    // if the record is mutated again before async work resumes.
    if (
      this.onTaskStatusChange !== undefined &&
      patch.status !== undefined &&
      patch.status !== priorStatus
    ) {
      try {
        this.onTaskStatusChange(toTaskSnapshot(record));
      } catch {
        // downstream consumer must not poison the update path
      }
    }
    return record;
  }

  snapshot(id: string): TaskSnapshot | undefined {
    const r = this.records.get(id);
    return r ? toTaskSnapshot(r) : undefined;
  }

  snapshots(filter: TaskListFilter = {}): TaskSnapshot[] {
    return this.list(filter).map(toTaskSnapshot);
  }

  size(): number {
    return this.records.size;
  }

  private freshId(): string {
    for (let i = 0; i < 8; i += 1) {
      const candidate = this.genId();
      if (!this.records.has(candidate)) return candidate;
    }
    throw new Error('TaskRegistry.create: id generator produced 8 collisions in a row');
  }
}

export function toTaskSnapshot(r: TaskRecord): TaskSnapshot {
  const base = {
    id: r.id,
    projectId: r.projectId,
    description: r.description,
    status: r.status,
    priority: r.priority,
    dependsOn: r.dependsOn,
    notes: r.notes.slice(),
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  } as const;
  return {
    ...base,
    ...(r.workerId !== undefined ? { workerId: r.workerId } : {}),
    ...(r.result !== undefined ? { result: r.result } : {}),
    ...(r.completedAt !== undefined ? { completedAt: r.completedAt } : {}),
  };
}
