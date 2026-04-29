/**
 * Task records describe work items Maestro has enqueued for a project.
 *
 * Phase 2A.3 ships an in-memory `TaskRegistry` with the same interface
 * Phase 2B will back with SQLite. Tools take a `TaskStore` so the swap
 * is invisible to callers.
 *
 * Identity: `id` is an opaque string (`tk-<hex>`). Do NOT treat it as a
 * database row number — Phase 2B keeps the same shape but promotes it to
 * a primary key.
 */
export const TASK_STATUSES = [
  'pending',
  'in_progress',
  'completed',
  'failed',
  'cancelled',
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

export interface TaskNote {
  readonly at: string;
  readonly text: string;
}

export interface TaskRecord {
  readonly id: string;
  readonly projectId: string;
  readonly description: string;
  status: TaskStatus;
  priority: number;
  dependsOn: readonly string[];
  workerId?: string;
  result?: string;
  notes: TaskNote[];
  readonly createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface TaskSnapshot {
  readonly id: string;
  readonly projectId: string;
  readonly description: string;
  readonly status: TaskStatus;
  readonly priority: number;
  readonly dependsOn: readonly string[];
  readonly workerId?: string;
  readonly result?: string;
  readonly notes: readonly TaskNote[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt?: string;
}

export interface CreateTaskInput {
  readonly projectId: string;
  readonly description: string;
  readonly priority?: number;
  readonly dependsOn?: readonly string[];
}

export interface TaskPatch {
  readonly status?: TaskStatus;
  readonly notes?: string;
  readonly workerId?: string;
  readonly result?: string;
}

export interface TaskListFilter {
  readonly projectId?: string;
  readonly status?: TaskStatus | readonly TaskStatus[];
}

export interface TaskStore {
  list(filter?: TaskListFilter): TaskRecord[];
  get(id: string): TaskRecord | undefined;
  create(input: CreateTaskInput): TaskRecord;
  update(id: string, patch: TaskPatch): TaskRecord;
  snapshot(id: string): TaskSnapshot | undefined;
  snapshots(filter?: TaskListFilter): TaskSnapshot[];
  size(): number;
}

/** State machine — `Set` per origin status of valid target statuses. */
export const TASK_TRANSITIONS: Readonly<Record<TaskStatus, ReadonlySet<TaskStatus>>> = {
  pending: new Set<TaskStatus>(['in_progress', 'cancelled', 'failed']),
  in_progress: new Set<TaskStatus>(['completed', 'failed', 'cancelled']),
  completed: new Set<TaskStatus>(),
  failed: new Set<TaskStatus>(),
  cancelled: new Set<TaskStatus>(),
};

export function isTerminalStatus(status: TaskStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  if (from === to) return true;
  return TASK_TRANSITIONS[from].has(to);
}

export class InvalidTaskTransitionError extends Error {
  readonly from: TaskStatus;
  readonly to: TaskStatus;
  constructor(from: TaskStatus, to: TaskStatus) {
    super(`TaskRegistry: invalid transition ${from} -> ${to}`);
    this.name = 'InvalidTaskTransitionError';
    this.from = from;
    this.to = to;
  }
}

/**
 * Phase 2B.1 m4: in-memory `TaskRegistry.create` accepted any projectId
 * string while `SqliteTaskStore` enforced FK. Drift-killer thrown when
 * the DI'd `projectStore.get(projectId)` returns undefined.
 */
export class UnknownProjectIdError extends Error {
  readonly projectId: string;
  constructor(projectId: string) {
    super(`No project registered with id or name "${projectId}"`);
    this.name = 'UnknownProjectIdError';
    this.projectId = projectId;
  }
}

export class UnknownTaskError extends Error {
  readonly taskId: string;
  constructor(taskId: string) {
    super(`TaskRegistry: unknown task '${taskId}'`);
    this.name = 'UnknownTaskError';
    this.taskId = taskId;
  }
}
