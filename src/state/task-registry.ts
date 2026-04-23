import { randomBytes } from 'node:crypto';
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

export interface TaskRegistryOptions {
  readonly now?: () => number;
  readonly idGenerator?: () => string;
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

  constructor(opts: TaskRegistryOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.genId = opts.idGenerator ?? defaultIdGenerator;
  }

  list(filter: TaskListFilter = {}): TaskRecord[] {
    const records = Array.from(this.records.values());
    const statusSet = Array.isArray(filter.status)
      ? new Set(filter.status as readonly TaskStatus[])
      : typeof filter.status === 'string'
        ? new Set<TaskStatus>([filter.status])
        : null;
    return records.filter((r) => {
      if (filter.projectId !== undefined && r.projectId !== filter.projectId) return false;
      if (statusSet !== null && !statusSet.has(r.status)) return false;
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

    if (patch.status !== undefined) {
      if (!canTransition(record.status, patch.status)) {
        throw new InvalidTaskTransitionError(record.status, patch.status);
      }
      record.status = patch.status;
      if (isTerminalStatus(patch.status)) {
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
