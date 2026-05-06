/**
 * Phase 3H.3 — Notifications dispatcher type surface.
 *
 * Two concerns:
 *   1. The cross-platform spawn shim (`spawn-toast.ts`) only needs the
 *      raw title + body. Title is short (<70 chars in practice — the
 *      dispatcher passes `Symphony · <projectName>`); body is truncated
 *      to 120 chars by the dispatcher before reaching the shim.
 *   2. The dispatcher policy engine (`dispatcher.ts`) consumes lifecycle
 *      callbacks (`onWorkerExit`, `onQuestion`) and exposes a
 *      `flushAwayDigest` for the TUI's awayMode-flip RPC trigger.
 *
 * The two-layer split keeps platform-specific spawn logic in a leaf
 * module that's straightforward to mock in tests, while the policy
 * engine stays platform-agnostic and tests against an injected
 * `spawnToast` stub.
 */

import type { WorkerRecord } from '../orchestrator/worker-registry.js';
import type { QuestionRecord } from '../state/question-registry.js';
import type { LoadResult } from '../utils/config.js';

export type Platform = 'win32' | 'darwin' | 'linux';

/** Input for the platform-spawning shim. Title + body are pre-truncated by the caller. */
export interface ToastInput {
  readonly title: string;
  readonly body: string;
  /** Override the platform (test seam). Defaults to `process.platform`. */
  readonly platform?: Platform;
  /**
   * Override the spawn function (test seam). Defaults to
   * `child_process.spawn`. Mocked in `spawn-toast.unit.test.ts`.
   */
  readonly spawnImpl?: SpawnImpl;
  /** Override the timeout (default 5000 ms). */
  readonly timeoutMs?: number;
}

export interface SpawnImpl {
  (
    command: string,
    args: readonly string[],
    options: SpawnOptions,
  ): SpawnHandle;
}

export interface SpawnOptions {
  readonly stdio?: readonly ('pipe' | 'ignore' | 'inherit')[];
  readonly windowsHide?: boolean;
}

export interface SpawnHandle {
  readonly stdin: { write(data: string): void; end(): void };
  on(event: 'error' | 'exit' | 'close', listener: (...args: unknown[]) => void): SpawnHandle;
  kill(signal?: NodeJS.Signals): boolean;
}

/**
 * The dispatcher's dependency surface. Reads config fresh per call so
 * a `setConfig` from the TUI is reflected immediately without any
 * watcher / cache-invalidation plumbing.
 */
export interface DispatcherDeps {
  loadConfig(): Promise<LoadResult>;
  spawnToast(input: ToastInput): Promise<void>;
  /**
   * Resolve a project ID (or null for unregistered absolute-path
   * workers) to a display name. Server.ts wires this from
   * `projectStore.get(id)?.name`.
   */
  getProjectName(projectId: string | null): string;
  /** Test seam — defaults to `() => process.stdout.isTTY === true`. */
  isTTY?(): boolean;
  /** Test seam — defaults to `() => Boolean(process.env.CI)`. */
  isCI?(): boolean;
  /** Test seam — defaults to `Date.now`. */
  now?(): number;
  /**
   * Spawn-error sink (test seam). Defaults to a no-op so production
   * never logs to stdout (Ink owns it). Test cases inject a vi.fn() to
   * assert error paths.
   */
  onError?(err: Error): void;
}

export interface DispatcherHandle {
  /**
   * Called by the worker lifecycle's `wireExit` AFTER `markCompleted`
   * AND after the running-counter `release()` so that `totalRunning`
   * reflects post-decrement reality.
   */
  onWorkerExit(record: WorkerRecord, totalRunning: number): void;
  /** Called by the question store's `enqueue` post-insert. */
  onQuestion(record: QuestionRecord): void;
  /**
   * Drain the awayMode buffer + reset the all-done tally, and emit a
   * single digest if anything is pending. Idempotent: a flush on an
   * empty buffer is a no-op.
   */
  flushAwayDigest(): Promise<void>;
  /** Final flush; called from server shutdown before lifecycle teardown. */
  shutdown(): Promise<void>;
}
