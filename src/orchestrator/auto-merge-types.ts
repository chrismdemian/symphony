/**
 * Phase 3O.1 — Auto-merge gate event surface.
 *
 * Two concerns mirror the completions-broker split (`completion-summarizer-
 * types.ts`):
 *
 *   1. The `AutoMergeEvent` payload that flows through the broker and out
 *      the WS to TUI clients. Plain JSON, no live handles.
 *   2. The dispatcher interface (`AutoMergeDispatcherHandle`) the server
 *      wires into `FinalizeDeps.onFinalize` and
 *      `QuestionStore.onQuestionAnswered`.
 *
 * Events fan through `AutoMergeBroker` (sibling to `WorkerCompletionsBroker`)
 * — single channel, no per-worker keying, since the TUI chat panel is the
 * single global consumer.
 */

import type { QuestionRecord } from '../state/question-registry.js';
import type { FinalizeRunResult } from './finalize-runner.js';
import type { FinalizeCallbackContext } from './tools/finalize.js';

/**
 * Discriminant for `AutoMergeEvent`. Five kinds cover the gate's full
 * state machine:
 *
 *   - `asked`    — `autoMerge='ask'`: question enqueued, awaiting user.
 *   - `merged`   — merge + cleanup succeeded.
 *   - `declined` — user answered no (or unclear answer fail-safed).
 *   - `failed`   — merge step threw (conflict / push reject / cleanup-only).
 *   - `ready`    — `autoMerge='never'`: branch left for manual review.
 */
export type AutoMergeKind = 'asked' | 'merged' | 'declined' | 'failed' | 'ready';

/**
 * Wire payload — published by the dispatcher, consumed by the chat
 * reducer's `pushSystem` action (via the TUI's `useAutoMergeEvents`
 * hook). Plain JSON: traverses the WS as-is.
 *
 * `headline` is the one-line system-row body. The TUI doesn't compose
 * its own string — server-side controls phrasing for consistency
 * across remote clients.
 */
export interface AutoMergeEvent {
  readonly kind: AutoMergeKind;
  readonly workerId: string;
  readonly branch: string;
  readonly projectName: string;
  readonly mergeTo: string;
  readonly headline: string;
  /** Set on `merged` — the merge commit sha. */
  readonly mergeSha?: string;
  /** Set on `failed` — short reason (typed error name + stderr tail). */
  readonly reason?: string;
  /** Set on `merged` if worktree cleanup failed AFTER successful merge. */
  readonly cleanupWarning?: string;
  /** Set on `declined` when the user's answer couldn't be parsed as y/n. */
  readonly unclearAnswer?: string;
  /** Producer-stamped ISO timestamp; the broker preserves arrival order. */
  readonly ts: string;
}

export type AutoMergeListener = (event: AutoMergeEvent) => void;

/**
 * Pub-sub for auto-merge events. Single channel — no per-worker keying,
 * since the TUI's chat panel is a global consumer.
 *
 * Mirrors `WorkerCompletionsBroker`'s shape: snapshot-then-iterate,
 * swallow listener throws so a faulty subscriber can't poison fan-out.
 */
export interface AutoMergeBroker {
  subscribe(listener: AutoMergeListener): () => void;
  publish(event: AutoMergeEvent): void;
  /** Drop all subscribers — called on RPC server close. */
  clear(): void;
  /** Test seam. */
  subscriberCount(): number;
}

/**
 * Dispatcher handle the server wires into the finalize tool +
 * QuestionStore. Both entry points are fire-and-forget from the caller's
 * perspective; internal async work is detached.
 *
 * Shutdown ordering (mirror notifications-dispatcher 3H.3 audit M2):
 *   close → autoMergeDispatcher.shutdown()
 *         → notificationDispatcher.shutdown()
 *         → workerLifecycle.shutdown()
 *
 * The `disposed` flag short-circuits all entry points post-shutdown so
 * late-firing lifecycle exits (during the SIGTERM kill window) don't
 * spawn orphan merge processes.
 */
export interface AutoMergeDispatcherHandle {
  /**
   * Wire target for `FinalizeDeps.onFinalize`. Called fire-and-forget by
   * the finalize tool when `result.ok === true`. The dispatcher reads
   * config fresh, branches by mode, and either: (a) emits a `ready`
   * event (mode='never'), (b) starts a merge (mode='auto'), or (c)
   * enqueues a y/n question + emits `asked` (mode='ask').
   *
   * Short-circuits to no-op when `ctx.mergeToSpecified === true`
   * (Maestro already merged via tier-3 finalize).
   */
  onFinalize(result: FinalizeRunResult, ctx: FinalizeCallbackContext): void;
  /**
   * Wire target for `QuestionStoreOptions.onQuestionAnswered`. Called
   * synchronously by the store post-update. The dispatcher looks up the
   * question id in its `pendingAsks` map; if found, it parses y/n and
   * either starts a merge or emits `declined`. Unknown question ids
   * pass through silently (the dispatcher is one of several consumers
   * of this hook — e.g., the notification dispatcher's future use).
   */
  onQuestionAnswered(record: QuestionRecord): void;
  /**
   * Wait for all in-flight merges + cleanups to settle. Called from the
   * server's close path BEFORE `notificationDispatcher.shutdown()` so
   * late-arriving finalize callbacks don't spawn merge processes after
   * teardown began. Idempotent.
   */
  shutdown(): Promise<void>;
}
