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
  /**
   * Phase 3P — when `true`, restrict to tasks with `status === 'pending'`
   * AND every entry in `dependsOn` resolving to a task whose status is
   * `'completed'`. Stacks with `status`/`projectId` filters; readiness
   * is evaluated against the FULL task set (so a cross-project dep
   * still gates correctly even if the projectId filter would have
   * hidden the dep itself).
   */
  readonly readyOnly?: boolean;
}

export interface TaskStore {
  list(filter?: TaskListFilter): TaskRecord[];
  get(id: string): TaskRecord | undefined;
  create(input: CreateTaskInput): TaskRecord;
  update(id: string, patch: TaskPatch): TaskRecord;
  snapshot(id: string): TaskSnapshot | undefined;
  snapshots(filter?: TaskListFilter): TaskSnapshot[];
  size(): number;
  /**
   * Phase 3P audit M1 — atomic "claim this pending task for a worker"
   * primitive. Returns the updated record on success, or `null` when:
   *   - the task does not exist
   *   - the task is not `status === 'pending'` (someone else already
   *     claimed it, OR it's terminal/cancelled)
   *
   * Does NOT validate dependency readiness — that's the caller's
   * responsibility before calling `claim`. The atomicity guarantee is
   * solely on the `pending → in_progress` transition + workerId stamp,
   * which protects against concurrent `spawn_worker(task_id=X)` racing
   * to spawn parallel worktrees against the same task (see audit M1).
   *
   * Fires `onTaskStatusChange` exactly once on success (same as a
   * regular `update({status: 'in_progress'})`). Does NOT fire on the
   * null-return path (no transition happened).
   *
   * SQL impl uses `UPDATE ... WHERE id=? AND status='pending' RETURNING *`
   * for true atomicity; in-memory impl runs in one JS turn so the
   * check-then-set is naturally atomic.
   */
  claim(taskId: string, workerId: string): TaskRecord | null;
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

/**
 * Phase 3P — thrown by `spawn_worker` when `task_id` is set but the
 * task's `dependsOn` chain is unmet. `code` is the typed discriminant
 * the chat row uses to render a specific message; `blockedBy` lists
 * each unmet dep with its current status (`null` for unknown id).
 */
export interface TaskBlocker {
  readonly id: string;
  readonly status: TaskStatus | null;
}

export class TaskNotReadyError extends Error {
  readonly code = 'task-not-ready';
  readonly taskId: string;
  readonly blockedBy: readonly TaskBlocker[];
  constructor(taskId: string, blockedBy: readonly TaskBlocker[]) {
    const ids = blockedBy.map((b) => b.id).join(', ');
    super(`Task '${taskId}' is not ready; blocked by ${ids}`);
    this.name = 'TaskNotReadyError';
    this.taskId = taskId;
    this.blockedBy = blockedBy;
  }
}

/**
 * Phase 3P — defensive cycle detection error. Never produced by the
 * current API (create_task validates deps exist; update_task does not
 * mutate dependsOn) but surfaced by `/deps` when hand-edited SQLite
 * or a future API mutation path introduces a back-edge.
 */
export class TaskCycleError extends Error {
  readonly code = 'task-cycle';
  readonly path: readonly string[];
  constructor(path: readonly string[]) {
    super(`Task dependency cycle detected: ${path.join(' → ')}`);
    this.name = 'TaskCycleError';
    this.path = path;
  }
}
