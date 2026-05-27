/**
 * Phase 5E — saga rollup writer.
 *
 * Recomputes a saga's status from its members' cached statuses whenever
 * a member task transitions. Wired in `server.ts` via
 * `TaskStore.onTaskStatusChange`. Pure helper `computeRollup` is the
 * unit-tested core; `createSagaRollupListener` is the integration that
 * also writes the member cache + saga row.
 *
 * Rollup rules:
 *   - any member `failed` or `cancelled`  → saga `failed`
 *     (a saga is the unit of intent; one casualty fails the whole thing)
 *   - else all members `completed`        → saga `completed`
 *   - else any member `in_progress`       → saga `in_progress`
 *   - else (all `pending`)                → saga `pending`
 *
 * `update_saga(status='cancelled')` is the explicit recovery path — a
 * saga in `failed` is a terminal state per the state machine; the user
 * cancels and creates a new saga.
 */
import type { TaskSnapshot, TaskStatus } from './types.js';
import {
  canTransitionSaga,
  isTerminalSagaStatus,
  type SagaMemberRecord,
  type SagaStatus,
  type SagaStore,
} from './saga-types.js';

/**
 * Pure function: given the cached member statuses and the just-transitioned
 * task's new status, derive the target saga status. The just-transitioned
 * task may not yet be reflected in `members[]` (the listener writes the
 * cache AFTER computing the rollup), so we layer its status on top.
 */
export function computeRollup(
  members: readonly SagaMemberRecord[],
  justChanged: { readonly taskId: string; readonly status: TaskStatus },
): SagaStatus {
  if (members.length === 0) {
    // Saga has no members yet — keep it pending. Defensive: every saga
    // created via `create_saga` lands at least one member synchronously
    // via `create_task`, so this branch is mainly for tests that create
    // empty sagas.
    return 'pending';
  }
  const statuses = members.map((m) =>
    m.taskId === justChanged.taskId ? justChanged.status : m.status,
  );
  if (statuses.some((s) => s === 'failed' || s === 'cancelled')) return 'failed';
  if (statuses.every((s) => s === 'completed')) return 'completed';
  if (statuses.some((s) => s === 'in_progress')) return 'in_progress';
  return 'pending';
}

export interface SagaRollupListenerDeps {
  readonly sagaStore: SagaStore;
}

/**
 * Returns a `TaskStore.onTaskStatusChange` callback. Idempotent — calling
 * with the same status twice is a no-op.
 *
 * The listener:
 *   1. Looks up the member row for the transitioning task. If the task
 *      isn't a saga member (the common case), returns immediately.
 *   2. Snapshots the saga's members BEFORE the cache write.
 *   3. Computes the rollup using the just-changed status overlaid on
 *      the snapshot.
 *   4. Writes the member cache (saga_members.status).
 *   5. If the rollup target differs from the saga's current status AND
 *      the transition is legal, writes the saga row.
 *
 * Errors thrown by the listener are caught by the TaskStore's wrapper
 * (per `TaskRegistryOptions.onTaskStatusChange` JSDoc) — but we also
 * try/catch internally to log a clear message via `onError` if supplied.
 */
export function createSagaRollupListener(
  deps: SagaRollupListenerDeps & {
    readonly onError?: (err: unknown, taskId: string) => void;
  },
): (snapshot: TaskSnapshot) => void {
  return (snapshot) => {
    try {
      const member = deps.sagaStore.findMemberByTaskId(snapshot.id);
      if (member === undefined) return;
      const members = deps.sagaStore.listMembers(member.sagaId);
      const nextSagaStatus = computeRollup(members, {
        taskId: snapshot.id,
        status: snapshot.status,
      });
      deps.sagaStore.updateMemberStatus(snapshot.id, snapshot.status);
      const saga = deps.sagaStore.get(member.sagaId);
      if (saga === undefined) return;
      if (saga.status === nextSagaStatus) return;
      if (isTerminalSagaStatus(saga.status)) return; // terminal sagas are immutable
      if (!canTransitionSaga(saga.status, nextSagaStatus)) return;
      deps.sagaStore.update(member.sagaId, { status: nextSagaStatus });
    } catch (err) {
      if (deps.onError) deps.onError(err, snapshot.id);
      // else: swallow — the TaskStore contract requires us not to
      // poison the update path.
    }
  };
}
