/**
 * Phase 3P — TaskReadyDispatcher event surface.
 *
 * Mirrors the 3O.1 auto-merge trio (types / broker / dispatcher) shape
 * exactly:
 *
 *   1. The `TaskReadyEvent` payload that flows through the broker and
 *      out the WS to TUI clients. Plain JSON, no live handles.
 *   2. The `TaskReadyBroker` pub-sub channel — single global feed (no
 *      per-task keying); the TUI's chat panel is the only consumer.
 *   3. The `TaskReadyDispatcherHandle` interface the server wires into
 *      `TaskStoreOptions.onTaskStatusChange`.
 *
 * The dispatcher fires when a task transitions to `completed` AND any
 * dependent task's readiness flips. Each newly-ready dependent
 * produces one `task_ready` event with `headline` already composed
 * server-side (matches 3O.1 m1 — phrasing must be identical across
 * desktop / web / mobile clients).
 *
 * `unblocked_by` is the id of the task whose completion unblocked the
 * dependent. The dispatcher fires one event PER newly-ready dependent;
 * a single completion can yield multiple events (fan-out: A → {B,C,D}).
 */
import type { TaskSnapshot } from '../state/types.js';

/**
 * Discriminant for `TaskReadyEvent`. Just one kind today, but the shape
 * mirrors `AutoMergeKind` so a future extension (e.g., `dep-broken`
 * when a dep transitions to `failed`/`cancelled`) slots in without a
 * type refactor.
 */
export type TaskReadyKind = 'task_ready';

/**
 * Wire payload. Single source of truth for chat row phrasing — TUI
 * renders `headline` verbatim. `unblockedBy` is the snapshot of the
 * just-completed prerequisite captured at fire time so the chat row
 * can show "now ready after Tk-1234 (CRE Pipeline) completed" without
 * a follow-up store read on the TUI side.
 */
export interface TaskReadyEvent {
  readonly kind: TaskReadyKind;
  /** The newly-ready task. Frozen snapshot captured at fire time. */
  readonly task: TaskSnapshot;
  /** Display name of `task.projectId`; falls back to `(unknown)`. */
  readonly projectName: string;
  /** The prerequisite whose completion unblocked `task`. */
  readonly unblockedBy: TaskSnapshot;
  /** Display name of `unblockedBy.projectId`. */
  readonly unblockedByProjectName: string;
  /** One-line system-row body. Composed server-side. */
  readonly headline: string;
  /** Producer-stamped ISO timestamp; broker preserves arrival order. */
  readonly ts: string;
}

export type TaskReadyListener = (event: TaskReadyEvent) => void;

/**
 * Pub-sub for task-ready events. Single channel — no per-task keying,
 * since the TUI's chat panel is a global consumer.
 *
 * Mirrors `AutoMergeBroker` / `WorkerCompletionsBroker` shape:
 * snapshot-then-iterate so listener cleanup mid-publish doesn't skip
 * remaining subscribers; swallow listener throws so a faulty subscriber
 * can't poison fan-out for siblings.
 */
export interface TaskReadyBroker {
  subscribe(listener: TaskReadyListener): () => void;
  publish(event: TaskReadyEvent): void;
  /** Drop all subscribers — called on RPC server close. */
  clear(): void;
  /** Test seam. */
  subscriberCount(): number;
}

/**
 * Dispatcher handle the server wires into the task store's
 * `onTaskStatusChange` callback.
 *
 * Shutdown ordering (mirror 3O.1 audit M2):
 *   close → autoMergeDispatcher.shutdown()
 *         → taskReadyDispatcher.shutdown()
 *         → notificationDispatcher.shutdown()
 *         → workerLifecycle.shutdown()
 *
 * Entry-only `disposed` flag short-circuits `onTaskStatusChange` post-
 * shutdown so late status writes (during the SIGTERM kill window)
 * don't fan out to dead subscribers. Idempotent.
 */
export interface TaskReadyDispatcherHandle {
  /**
   * Wire target for `TaskStoreOptions.onTaskStatusChange`. Called
   * synchronously by the store post-update with a frozen snapshot of
   * the transitioned task. The dispatcher inspects the new status:
   * only `completed` transitions trigger dependent-readiness checks.
   * Other transitions are silently ignored.
   */
  onTaskStatusChange(snapshot: TaskSnapshot): void;
  /**
   * Drop all in-flight bookkeeping + dispose. Idempotent. Called on
   * server close BEFORE the lifecycle/store shutdown so a final
   * cascading completion (e.g., `markCompleted` during graceful drain)
   * doesn't surface a chat row in a dying TUI.
   */
  shutdown(): Promise<void>;
}
