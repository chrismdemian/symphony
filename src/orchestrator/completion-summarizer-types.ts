/**
 * Phase 3K — Worker completion summarizer type surface.
 *
 * Two concerns mirror the notification dispatcher's two-layer split
 * (`src/notifications/types.ts`):
 *
 *   1. The `CompletionSummary` payload that flows through the broker
 *      and out the WS to TUI clients. Plain JSON, no live handles.
 *   2. The dispatcher policy engine (`completion-summarizer.ts`)
 *      consumes the same `onWorkerStatusChange` lifecycle callback the
 *      notification dispatcher already uses, and exposes a `shutdown()`
 *      the server tears down BEFORE `workerLifecycle.shutdown()` so
 *      late-firing exits don't spawn orphan one-shot processes.
 *
 * The summarizer fans through `CompletionsBroker` (sibling to
 * `WorkerEventBroker`) — single channel, no per-worker keying, since
 * completions are global from the TUI's perspective (every chat
 * subscriber wants every completion).
 */

import type { WorkerRecord } from './worker-registry.js';
import type { WorkerStatus } from '../workers/types.js';

/**
 * Status kinds that may appear on a chat SystemSummary row. `killed` is
 * excluded because user-initiated single-worker SIGTERM is silent per
 * the 3H.3 dispatcher policy.
 *
 * Phase 3T: `interrupted` IS allowed here even though per-worker
 * `classifyStatusForSummary` filters it to null (no duplicate per-worker
 * row). The synthetic pivot row pushed by the interrupt action uses
 * `statusKind: 'interrupted'` so the chat carries the gray ⏸ glyph
 * consistent with the worker panel's interrupted indicator.
 */
export type CompletionStatusKind = Exclude<WorkerStatus, 'spawning' | 'running' | 'killed'>;

/**
 * Wire payload — published by the summarizer, consumed by the chat
 * reducer's `pushSystem` action. Plain JSON: traverses the WS as-is.
 */
export interface CompletionSummary {
  readonly workerId: string;
  readonly workerName: string;
  readonly projectName: string;
  readonly statusKind: CompletionStatusKind;
  readonly durationMs: number | null;
  /** One-line description (≤ 80 chars by prompt spec; not enforced here). */
  readonly headline: string;
  /** Optional metrics line (test/build results). */
  readonly metrics?: string;
  /** Optional details line (caveats, TODOs). */
  readonly details?: string;
  /** Producer-stamped ISO timestamp; the broker preserves arrival order. */
  readonly ts: string;
  /** Set when the summary came from the heuristic fallback (not the LLM). */
  readonly fallback: boolean;
}

export type CompletionsListener = (summary: CompletionSummary) => void;

/**
 * Pub-sub for completion summaries. Single channel — no per-worker
 * keying, since the TUI's chat panel is a global consumer.
 *
 * Mirrors `WorkerEventBroker`'s shape: snapshot-then-iterate, swallow
 * listener throws so a faulty subscriber can't poison fan-out for
 * siblings. Back-pressure (slow client) is handled at the WS-server
 * layer, not here.
 */
export interface CompletionsBroker {
  subscribe(listener: CompletionsListener): () => void;
  publish(summary: CompletionSummary): void;
  /** Drop all subscribers — called on RPC server close. */
  clear(): void;
  /** Test seam. */
  subscriberCount(): number;
}

/**
 * Dependency surface for `createCompletionSummarizer`. Only `oneShot`
 * and `broker` are required; everything else has sensible defaults so
 * callers (server.ts, integration tests) wire minimally.
 */
export interface CompletionSummarizerDeps {
  /** Broker the summary is published to. Server.ts hands a real one. */
  readonly broker: CompletionsBroker;
  /**
   * One-shot runner. In production this is `defaultOneShotRunner` from
   * `src/orchestrator/one-shot.ts`. Tests inject a stub returning
   * canned JSON or throwing `OneShotExecutionError`.
   */
  readonly oneShot: OneShotInvoker;
  /**
   * Resolve a worker's display name (`Violin`, `Cello`, …). The
   * orchestrator instrument pool is TUI-side; server-side we currently
   * fall back to the worker's `featureIntent` head when no name is
   * known. Future Phase 4F may persist names — until then this is a
   * server-side stub.
   */
  readonly getWorkerName: (record: WorkerRecord) => string;
  /** Resolve a worker's display project name. */
  readonly getProjectName: (record: WorkerRecord) => string;
  /** Test seam — defaults to `Date.now`. */
  readonly now?: () => number;
  /** Test seam — defaults to `60_000`. */
  readonly oneShotTimeoutMs?: number;
  /**
   * Default model for the summarizer one-shot. Defaults to
   * `claude-haiku-4-5-20251001` — fast + cheap, this is summarization
   * not synthesis. Test seam.
   */
  readonly model?: string;
  /**
   * Sink for summarizer errors. Defaults to no-op (Ink owns stdout).
   * Tests inject a `vi.fn()` to assert error paths.
   */
  readonly onError?: (err: Error) => void;
}

/**
 * Function shape the summarizer expects from its one-shot runner. This
 * lets us depend on the abstract shape and keep `defaultOneShotRunner`
 * an injectable rather than a hard import — clean test surface.
 */
export type OneShotInvoker = (input: OneShotInvokerInput) => Promise<OneShotInvokerResult>;

export interface OneShotInvokerInput {
  readonly prompt: string;
  readonly cwd: string;
  readonly model?: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface OneShotInvokerResult {
  /** Envelope-unwrapped text the parser will consume. */
  readonly text: string;
  readonly exitCode: number | null;
}

export interface CompletionSummarizerHandle {
  /**
   * Called by the worker lifecycle's `wireExit` AFTER `markCompleted`.
   * Fire-and-forget from the lifecycle's perspective (returns void).
   * Internal one-shot runs in a detached promise; failures route to
   * the heuristic fallback so a summary still publishes.
   *
   * Idempotent: if the worker has already produced a summary (rare —
   * lifecycle exits fire once), the second call is a no-op.
   */
  onWorkerExit(record: WorkerRecord): void;
  /**
   * Wait for all in-flight summarizer one-shots to settle (success OR
   * fallback). Called from the server's close path BEFORE
   * `workerLifecycle.shutdown()` so late-arriving exits don't spawn
   * orphan one-shot processes after teardown began. Idempotent.
   */
  shutdown(): Promise<void>;
}
