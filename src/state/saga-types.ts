/**
 * Phase 5E — saga types.
 *
 * A "saga" binds N task records under a single user-visible intent that
 * crosses 2+ projects. The state machine is identical to TaskStatus —
 * the rollup writer maps {pending,in_progress,completed,failed,cancelled}
 * member statuses to one saga status (see `saga-rollup.ts`).
 *
 * A task can belong to AT MOST one saga (SQL UNIQUE constraint). A saga
 * can span N projects (no project-uniqueness). Membership is set at
 * `create_task(saga_id: ...)` time and is immutable thereafter.
 */
import type { TaskNote, TaskStatus } from './types.js';

export const SAGA_STATUSES = [
  'pending',
  'in_progress',
  'completed',
  'failed',
  'cancelled',
] as const;
export type SagaStatus = (typeof SAGA_STATUSES)[number];

export interface SagaRecord {
  readonly id: string;            // `sg-<hex>`
  readonly description: string;
  status: SagaStatus;
  result?: string;
  notes: TaskNote[];
  readonly createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface SagaMemberRecord {
  readonly sagaId: string;
  readonly taskId: string;
  readonly projectId: string | null;
  /** Cached snapshot — see saga-rollup. Source of truth is `tasks.status`. */
  status: TaskStatus;
  readonly addedAt: string;
}

export interface SagaMemberSnapshot {
  readonly sagaId: string;
  readonly taskId: string;
  readonly projectId: string | null;
  readonly projectName: string;
  readonly status: TaskStatus;
  readonly addedAt: string;
}

export interface SagaSnapshot {
  readonly id: string;
  readonly description: string;
  readonly status: SagaStatus;
  readonly result?: string;
  readonly notes: readonly TaskNote[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt?: string;
  readonly members: readonly SagaMemberSnapshot[];
}

export interface CreateSagaInput {
  readonly description: string;
}

export interface SagaPatch {
  readonly status?: SagaStatus;
  readonly notes?: string;
  readonly result?: string;
}

export interface SagaListFilter {
  readonly status?: SagaStatus | readonly SagaStatus[];
  /**
   * Membership filter — return only sagas that include at least one
   * member with this projectId. Used by `list_sagas(project:)` to scope
   * to a single project's involvement.
   */
  readonly projectId?: string;
}

export interface AddSagaMemberInput {
  readonly sagaId: string;
  readonly taskId: string;
  readonly projectId: string | null;
}

/**
 * Store interface. Mirrors the `TaskStore` shape so the in-memory test
 * double and the SQLite production impl swap freely.
 */
export interface SagaStore {
  list(filter?: SagaListFilter): SagaRecord[];
  get(id: string): SagaRecord | undefined;
  create(input: CreateSagaInput): SagaRecord;
  update(id: string, patch: SagaPatch): SagaRecord;
  snapshot(id: string): SagaSnapshot | undefined;
  snapshots(filter?: SagaListFilter): SagaSnapshot[];
  size(): number;

  /**
   * Register a task as a member of a saga. Called by `create_task` when
   * `saga_id` is supplied. Throws `UnknownSagaError` if the saga doesn't
   * exist; throws `DuplicateSagaMembershipError` if the task is already
   * in another saga (or this one).
   */
  addMember(input: AddSagaMemberInput): SagaMemberRecord;

  /** Lookup the member row for one task id. `undefined` if not a member. */
  findMemberByTaskId(taskId: string): SagaMemberRecord | undefined;

  /** All members of one saga, in insertion order. */
  listMembers(sagaId: string): readonly SagaMemberRecord[];

  /**
   * Update the cached member status. Idempotent. Called by the
   * SagaRollupListener whenever the underlying task transitions.
   * Returns `undefined` if the task is not a saga member (a fast path
   * for the listener — most tasks aren't saga members).
   */
  updateMemberStatus(taskId: string, status: TaskStatus): SagaMemberRecord | undefined;
}

/** State machine — matches `TaskStatus` exactly (see `state/types.ts`). */
export const SAGA_TRANSITIONS: Readonly<Record<SagaStatus, ReadonlySet<SagaStatus>>> = {
  pending: new Set<SagaStatus>(['in_progress', 'cancelled', 'failed']),
  in_progress: new Set<SagaStatus>(['completed', 'failed', 'cancelled']),
  completed: new Set<SagaStatus>(),
  failed: new Set<SagaStatus>(),
  cancelled: new Set<SagaStatus>(),
};

export function isTerminalSagaStatus(status: SagaStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

export function canTransitionSaga(from: SagaStatus, to: SagaStatus): boolean {
  if (from === to) return true;
  return SAGA_TRANSITIONS[from].has(to);
}

export class InvalidSagaTransitionError extends Error {
  readonly from: SagaStatus;
  readonly to: SagaStatus;
  constructor(from: SagaStatus, to: SagaStatus) {
    super(`SagaStore: invalid transition ${from} -> ${to}`);
    this.name = 'InvalidSagaTransitionError';
    this.from = from;
    this.to = to;
  }
}

export class UnknownSagaError extends Error {
  readonly sagaId: string;
  constructor(sagaId: string) {
    super(`SagaStore: unknown saga '${sagaId}'`);
    this.name = 'UnknownSagaError';
    this.sagaId = sagaId;
  }
}

export class DuplicateSagaMembershipError extends Error {
  readonly taskId: string;
  readonly existingSagaId: string;
  constructor(taskId: string, existingSagaId: string) {
    super(
      `SagaStore: task '${taskId}' is already a member of saga '${existingSagaId}' — saga membership is immutable`,
    );
    this.name = 'DuplicateSagaMembershipError';
    this.taskId = taskId;
    this.existingSagaId = existingSagaId;
  }
}
