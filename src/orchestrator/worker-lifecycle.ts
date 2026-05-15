import { randomBytes } from 'node:crypto';
import type { WorkerManager } from '../workers/manager.js';
import type {
  StreamEvent,
  Worker,
  WorkerConfig,
  WorkerExitInfo,
  WorkerStatus,
} from '../workers/types.js';
import type { WorktreeManager } from '../worktree/manager.js';
import { deriveFeatureIntent } from './feature-intent.js';
import {
  CircularBuffer,
  DEFAULT_OUTPUT_BUFFER_CAP,
  TERMINAL_WORKER_STATUSES as TERMINAL_STATUSES,
  type WorkerRegistry,
  type WorkerRecord,
} from './worker-registry.js';
import type { PersistedWorkerRecord } from '../state/sqlite-worker-store.js';
import type { AutonomyTier, WorkerRole } from './types.js';

export interface SpawnWorkerInput {
  readonly projectPath: string;
  /**
   * Resolved project ID for SQL persistence (Phase 2B.1b). Caller looks
   * it up via `projectStore.get(name).id`. Pass `null` for unregistered
   * absolute-path projects — consistent with audit M2 from 2A.4a.
   */
  readonly projectId?: string | null;
  /** Optional task association for SQL persistence (Phase 2B.1b). */
  readonly taskId?: string | null;
  readonly taskDescription: string;
  readonly role: WorkerRole;
  readonly model?: string;
  readonly dependsOn?: readonly string[];
  readonly autonomyTier?: AutonomyTier;
  readonly id?: string;
  readonly featureIntent?: string;
  readonly timeoutMs?: number;
  /** AbortSignal from the tool dispatch context; cancels worktree+spawn cooperatively. */
  readonly signal?: AbortSignal;
}

export interface ResumeWorkerInput {
  readonly recordId: string;
  readonly message: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface WorkerLifecycleOptions {
  readonly registry: WorkerRegistry;
  readonly workerManager: WorkerManager;
  readonly worktreeManager: WorktreeManager;
  readonly outputBufferCap?: number;
  readonly now?: () => number;
  readonly idGenerator?: () => string;
  /**
   * Phase 2B.1b — used by `recoverFromStore` to map persisted
   * `projectId` back to a filesystem path when rehydrating in-memory
   * records. Without it, recovered records have an empty `projectPath`
   * and won't match `--project` filters in `list_workers`.
   */
  readonly resolveProjectPath?: (projectId: string | null) => string;
  /**
   * Phase 2B.2 — fired for every stream event the tap observes. The
   * RPC `WorkerEventBroker` installs itself here to fan out events to
   * subscribed clients. The lifecycle keeps the single-consumer
   * iterator; the broker is downstream of the tap.
   *
   * Defaults to a no-op. Errors thrown by the callback are swallowed so
   * a misbehaving consumer can't poison the lifecycle.
   */
  readonly onEvent?: (workerId: string, event: StreamEvent) => void;
  /**
   * Phase 3H.2 — per-project worker concurrency cap. When set, `spawn`
   * gates new workers: under-cap → spawn immediately; at-cap → queue
   * with backpressure and resolve when a slot frees (a running worker
   * completes / fails / is killed). Returns `Infinity` (no cap) when
   * undefined or returns a non-positive value.
   *
   * Sync because `readSymphonyConfig` (the per-project source) is sync
   * and the global value is a snapshot at server startup. Cap changes
   * during a session require restart — same shape as `modelMode`. See
   * `server.ts`'s `getMaxConcurrentWorkers` constructor for the
   * project-vs-global lookup.
   */
  readonly getMaxConcurrentWorkers?: (projectPath: string) => number;
  /**
   * Phase 3H.2 — default model when `input.model === undefined`. The
   * server wires this to return `'claude-opus-4-7'` when the user's
   * `modelMode === 'opus'`; when `'mixed'`, returns undefined and
   * Maestro's explicit per-task `model` arg drives the choice
   * (matching the prompt's "Always pass `model:` explicitly" rule).
   * Caller-provided `input.model` ALWAYS wins.
   */
  readonly getDefaultModel?: () => string | undefined;
  /**
   * Phase 3S — default autonomy tier when `input.autonomyTier === undefined`.
   * The server wires this to `() => config.autonomyTier` (read fresh per
   * spawn so user tier flips reflect immediately on new spawns). When
   * undefined, falls back to Tier 1 (Free reign) — matches pre-3S
   * behavior for legacy test rigs.
   *
   * Per-worker tier is metadata-only in 3S — surfaced in `list_workers`
   * for Maestro's prompt awareness and as a Tier-3 chip on the worker
   * row, but NOT enforced at the capability shim (workers don't
   * dispatch through Maestro's MCP). Phase 7's worker-side MCP layer
   * wires the architectural enforcement.
   */
  readonly getDefaultAutonomyTier?: () => AutonomyTier;
  /**
   * Phase 3H.3 — fired whenever a worker transitions to a terminal
   * status (`completed` / `failed` / `killed` / `timeout` / `crashed`).
   * The callback receives the record AFTER `registry.markCompleted` has
   * stamped the new status, AND AFTER the running-count `release()` has
   * decremented the per-project counter. `totalRunning` is the global
   * sum across every project — `0` indicates "no workers anywhere",
   * which is the signal the notifications dispatcher uses to fire its
   * all-done rollup.
   *
   * Errors thrown by the callback are swallowed so a misbehaving
   * consumer can't poison the lifecycle's exit chain (mirrors the
   * `onEvent` broker convention).
   */
  readonly onWorkerStatusChange?: (record: WorkerRecord, totalRunning: number) => void;
}

/**
 * Phase 3H.2 — snapshot of the queue state for one project. `running` is
 * the number of workers currently in `spawning` or `running` state for
 * the project; `capacity` is the cap (`Infinity` means uncapped);
 * `pending` is the queued spawn requests in FIFO order.
 */
export interface QueueSnapshot {
  readonly running: number;
  readonly capacity: number;
  readonly pending: ReadonlyArray<{
    readonly recordId: string;
    readonly featureIntent: string;
    readonly taskDescription: string;
  }>;
}

/**
 * Phase 3L — wire-shape for one queued spawn, suitable for cross-project
 * display in the TUI's task queue panel. `enqueuedAt` is the epoch-ms
 * timestamp captured when `spawn()` queued the request; the TUI sorts
 * the flat list ascending by this field so the global "Next →" pointer
 * is the earliest enqueued across all projects.
 */
export interface PendingSpawnSnapshot {
  readonly recordId: string;
  readonly projectPath: string;
  readonly featureIntent: string;
  readonly taskDescription: string;
  readonly enqueuedAt: number;
  /**
   * Phase 3S — per-worker autonomy tier override for queued spawns.
   * `undefined` means "use the orchestrator default at spawn time"
   * (resolved at the actual spawn moment, not enqueue moment, so a
   * user who flips Ctrl+Y while requests are queued sees the new tier
   * on drained spawns).
   */
  readonly autonomyTier?: AutonomyTier;
}

/**
 * Phase 3L — thrown into the caller's `spawn()` promise when
 * `cancelQueued` removes a still-pending entry from the queue. Maestro's
 * `spawn_worker` tool surfaces the typed code so the chat can render
 * "task cancelled while queued" distinctly from generic spawn failure.
 */
export class QueueCancelledError extends Error {
  readonly code = 'queue-cancelled';
  readonly recordId: string;
  constructor(recordId: string) {
    super(`spawn_worker cancelled while queued (recordId=${recordId})`);
    this.name = 'QueueCancelledError';
    this.recordId = recordId;
  }
}

export interface RecoveryReport {
  /** Worker IDs whose status was flipped from non-terminal to `crashed`. */
  readonly crashedIds: readonly string[];
}

export interface WorkerLifecycleHandle {
  spawn(input: SpawnWorkerInput): Promise<WorkerRecord>;
  resume(input: ResumeWorkerInput): Promise<WorkerRecord>;
  cleanup(id: string): void;
  shutdown(): Promise<void>;
  /**
   * Phase 2B.1b — at startup, mark every persisted worker still in a
   * non-terminal state (`spawning` | `running`) as `crashed`. The live
   * subprocess died with the previous orchestrator; user/Maestro resumes
   * via `resume_worker` with a meaningful follow-up message.
   *
   * No-op when the registry was constructed without a store. Safe to
   * call multiple times — terminal rows are left untouched.
   */
  recoverFromStore(): RecoveryReport;
  /**
   * Phase 2B.2 (Audit m12 follow-up) — late-bind the per-event callback
   * the lifecycle's tap uses to fan out to the RPC broker. The setter
   * affects all FUTURE taps and previously-attached taps that read the
   * callback through the lifecycle's closure (this is the path used by
   * `attachEventTap`). Calling with `undefined` clears the binding.
   *
   * Custom lifecycles passed via `WorkerLifecycleOptions.workerLifecycle`
   * MUST honor this setter so `startOrchestratorServer` can wire the
   * broker regardless of who constructed the lifecycle.
   */
  setOnEvent(callback: ((workerId: string, event: StreamEvent) => void) | undefined): void;
  /**
   * Phase 3H.2 — current queue state for `projectPath`. Returns
   * `{running: 0, capacity: Infinity, pending: []}` when uncapped or
   * the project has no in-flight workers.
   */
  getQueueSnapshot(projectPath: string): QueueSnapshot;
  /**
   * Phase 3H.3 — global running count across every project. Sums the
   * per-project counters maintained by `incRunning` / `decRunning`.
   * The notifications dispatcher reads this in its `onWorkerExit`
   * callback to detect the all-done transition (count → 0).
   */
  getTotalRunning(): number;
  /**
   * Phase 3L — flat list of every pending spawn across every project,
   * sorted ascending by `enqueuedAt`. The TUI's task queue panel renders
   * this directly; the "Next →" marker is index 0.
   */
  listPendingGlobal(): readonly PendingSpawnSnapshot[];
  /**
   * Phase 3L — remove `recordId` from its project's pending queue and
   * reject the caller's `spawn()` promise with `QueueCancelledError`.
   * No-op (returns `{cancelled:false, reason:'not in queue'}`) if the
   * record is not currently pending — caller may be racing the drain.
   */
  cancelQueued(recordId: string): { cancelled: boolean; reason?: string };
  /**
   * Phase 3L — swap `recordId` with its same-project neighbor in the
   * pending queue, also swapping `enqueuedAt` so the global merge
   * reflects the new order. `up` swaps with the predecessor; `down`
   * with the successor. Cross-project reorder is meaningless (per-
   * project drain) and returns `{moved:false, reason:'no neighbor'}`
   * at project boundaries.
   */
  reorderQueued(
    recordId: string,
    direction: 'up' | 'down',
  ): { moved: boolean; reason?: string };
  /**
   * Phase 3T — SIGTERM every non-terminal worker with intent='interrupt'
   * so classifyExit lands them at status `'interrupted'`. Synchronous;
   * does NOT await worker exits (those fire async through the existing
   * wireExit chain). Recovered stub workers are filtered out — their
   * `kill()` is a no-op, mirroring the `workers.kill` RPC's audit m9
   * precedent. Returns the killed-worker IDs for logging/telemetry.
   *
   * Idempotent: a second call returns an empty list because the first
   * already moved every worker into a terminal state.
   */
  killAllRunning(): { killedIds: readonly string[] };
  /**
   * Phase 3T — reject every pending queued spawn across every project
   * with `QueueCancelledError`. Composed from `listPendingGlobal()` +
   * `cancelQueued(id)`. Synchronous. Returns the cancelled recordIds.
   *
   * Idempotent: a second call returns an empty list.
   */
  cancelAllQueued(): { cancelledIds: readonly string[] };
}

function defaultIdGenerator(): string {
  return `wk-${randomBytes(4).toString('hex')}`;
}

/**
 * Phase 3H.2 — internal queued-spawn entry. Holds the original input
 * and the deferred resolver/rejector for the caller's promise.
 *
 * Phase 3L — `enqueuedAt` (epoch ms) lets `listPendingGlobal()` merge
 * pending entries across projects in deterministic order, and lets
 * `reorderQueued()` swap timestamps alongside positions so the merge
 * reflects the new order.
 */
interface PendingSpawn {
  readonly recordId: string;
  readonly input: SpawnWorkerInput;
  readonly resolve: (record: WorkerRecord) => void;
  readonly reject: (err: Error) => void;
  enqueuedAt: number;
}

function nowIso(now: () => number): string {
  return new Date(now()).toISOString();
}

/** Tap a worker's event stream into a circular buffer. Returns an unsubscribe that drains once. */
function attachEventTap(
  worker: Worker,
  buffer: CircularBuffer<StreamEvent>,
  registry: WorkerRegistry,
  recordId: string,
  now: () => number,
  onEventRef: { current: ((workerId: string, event: StreamEvent) => void) | undefined },
): () => void {
  let stopped = false;
  void (async () => {
    try {
      for await (const event of worker.events) {
        if (stopped) break;
        buffer.push(event);
        registry.updateLastEventAt(recordId, new Date(now()).toISOString());
        if (event.type === 'system_init') {
          registry.updateSessionId(recordId, event.sessionId);
          registry.updateStatus(recordId, 'running');
        } else if (event.type === 'result') {
          registry.updateSessionId(recordId, event.sessionId);
          // Phase 2B.1b m1 — capture cumulative session cost so
          // `markCompleted` can persist it into the workers table.
          if (event.costUsd !== undefined) {
            registry.updateCostUsd(recordId, event.costUsd);
          }
          // Phase 3N.1 — same shape as cost. `sessionUsage` is the CLI's
          // authoritative cumulative usage roll-up (parser walks
          // `result.usage` directly; see `stream-parser.ts:233`). Workers
          // that finish with no token data leave the field absent.
          if (event.sessionUsage !== undefined) {
            registry.updateSessionUsage(recordId, event.sessionUsage);
          }
        }
        // Read through the ref so `setOnEvent` late-binding from the
        // orchestrator wires the broker for taps that started before it.
        const onEvent = onEventRef.current;
        if (onEvent !== undefined) {
          try {
            onEvent(recordId, event);
          } catch {
            // Downstream consumer (RPC broker etc.) must not poison the tap.
          }
        }
      }
    } catch {
      // stream errors surface via waitForExit
    }
  })();
  return () => {
    stopped = true;
  };
}

export function createWorkerLifecycle(opts: WorkerLifecycleOptions): WorkerLifecycleHandle {
  const { registry, workerManager, worktreeManager } = opts;
  const bufferCap = opts.outputBufferCap ?? DEFAULT_OUTPUT_BUFFER_CAP;
  const now = opts.now ?? Date.now;
  const genId = opts.idGenerator ?? defaultIdGenerator;
  const resolveProjectPath = opts.resolveProjectPath ?? (() => '');
  // `onEventRef` is a mutable closure cell so `attachEventTap` reads the
  // CURRENT value on each event push, not the value at attach time. This
  // lets `setOnEvent` late-bind the broker callback after the lifecycle
  // is already running (Audit m12).
  const onEventRef: { current: ((id: string, e: StreamEvent) => void) | undefined } = {
    current: opts.onEvent,
  };
  const inflight = new Map<string, Promise<WorkerRecord>>();

  // Phase 3H.2 — concurrency cap state. Counts running spawns per
  // project; queued spawns block until a slot frees. The counter
  // increments at the start of `doSpawn` (after the cap check) and
  // decrements when (a) `doSpawn` itself fails before producing a
  // record, or (b) a successfully-spawned worker exits via wireExit.
  // `pendingPerProject` holds queued requests in FIFO order.
  const runningPerProject = new Map<string, number>();
  const pendingPerProject = new Map<string, PendingSpawn[]>();

  function inflightKey(recordId: string, projectPath: string): string {
    return `${recordId}::${projectPath}`;
  }

  function getCap(projectPath: string): number {
    if (opts.getMaxConcurrentWorkers === undefined) return Number.POSITIVE_INFINITY;
    const cap = opts.getMaxConcurrentWorkers(projectPath);
    // Audit m1: require integer in addition to finite + >= 1. A future
    // option-injecting caller passing 2.5 would otherwise bend the
    // running counter against a fractional cap.
    if (!Number.isFinite(cap) || !Number.isInteger(cap) || cap < 1) {
      return Number.POSITIVE_INFINITY;
    }
    return cap;
  }

  function incRunning(projectPath: string): void {
    runningPerProject.set(projectPath, (runningPerProject.get(projectPath) ?? 0) + 1);
  }

  function decRunning(projectPath: string): void {
    const cur = runningPerProject.get(projectPath) ?? 0;
    if (cur <= 1) runningPerProject.delete(projectPath);
    else runningPerProject.set(projectPath, cur - 1);
  }

  // Drain pending spawns for a project up to its capacity. Called after
  // a slot frees (worker exits OR doSpawn rejects). Pending entries
  // whose AbortSignal has fired since they were queued are rejected
  // synchronously and the loop continues — they never count against
  // the cap.
  function drain(projectPath: string): void {
    const cap = getCap(projectPath);
    const list = pendingPerProject.get(projectPath);
    if (list === undefined || list.length === 0) return;
    while (list.length > 0) {
      const running = runningPerProject.get(projectPath) ?? 0;
      if (running >= cap) break;
      const next = list.shift()!;
      // Aborted while queued — fail without consuming a slot.
      if (next.input.signal !== undefined && next.input.signal.aborted) {
        next.reject(new Error(`spawn_worker aborted while queued (recordId=${next.recordId})`));
        continue;
      }
      // Synchronously reserve the slot to prevent another concurrent
      // drain/spawn from racing in. doSpawn is responsible for
      // decrementing on failure.
      incRunning(projectPath);
      const promise = doSpawn(next.recordId, next.input).finally(() => {
        if (inflight.get(inflightKey(next.recordId, next.input.projectPath)) === promise) {
          inflight.delete(inflightKey(next.recordId, next.input.projectPath));
        }
      });
      inflight.set(inflightKey(next.recordId, next.input.projectPath), promise);
      promise.then(next.resolve, next.reject);
    }
    if (list.length === 0) pendingPerProject.delete(projectPath);
  }

  async function spawn(input: SpawnWorkerInput): Promise<WorkerRecord> {
    const recordId = input.id ?? genId();
    const key = inflightKey(recordId, input.projectPath);
    const existing = inflight.get(key);
    if (existing !== undefined) return existing;

    // Audit C1 (3H.2 review): if `signal` is ALREADY aborted before
    // we register the listener, WHATWG fires no `abort` event. Reject
    // synchronously so a pre-aborted spawn that would queue doesn't
    // hang forever waiting for a worker exit to drain it.
    if (input.signal !== undefined && input.signal.aborted) {
      throw new Error(`spawn_worker aborted before queue (recordId=${recordId})`);
    }

    // Audit M3 (3H.2 review): close the dedup gap during the queue
    // window. The immediate-spawn path stores the in-flight promise in
    // `inflight` AT REGISTRATION; a concurrent `spawn` with the same
    // recordId reuses it. The queue path also needs that. We allocate
    // a deferred Promise + resolver, store it in `inflight` immediately,
    // and resolve it from drain when the spawn lands.
    let queuedResolve: ((record: WorkerRecord) => void) | undefined;
    let queuedReject: ((err: Error) => void) | undefined;

    // Phase 3H.2 — cap gate. If at capacity, queue and return a
    // promise that resolves when drain picks up this request.
    const cap = getCap(input.projectPath);
    const running = runningPerProject.get(input.projectPath) ?? 0;
    if (running >= cap) {
      const queuedPromise = new Promise<WorkerRecord>((resolve, reject) => {
        queuedResolve = resolve;
        queuedReject = reject;
        const list = pendingPerProject.get(input.projectPath) ?? [];
        const entry: PendingSpawn = {
          recordId,
          input,
          resolve,
          reject,
          enqueuedAt: now(),
        };
        list.push(entry);
        pendingPerProject.set(input.projectPath, list);
        // Cancel-on-abort: remove from queue + reject. Never spawns.
        if (input.signal !== undefined) {
          const onAbort = (): void => {
            const cur = pendingPerProject.get(input.projectPath);
            if (cur !== undefined) {
              const idx = cur.indexOf(entry);
              if (idx !== -1) {
                cur.splice(idx, 1);
                if (cur.length === 0) pendingPerProject.delete(input.projectPath);
              }
            }
            // Always reject — covers both "still queued" and the
            // (edge) case where drain already pulled the entry but
            // its inner doSpawn hasn't progressed yet (doSpawn checks
            // signal.aborted itself and rejects there).
            reject(new Error(`spawn_worker aborted while queued (recordId=${recordId})`));
          };
          input.signal.addEventListener('abort', onAbort, { once: true });
        }
      });
      inflight.set(key, queuedPromise);
      queuedPromise
        .finally(() => {
          if (inflight.get(key) === queuedPromise) inflight.delete(key);
        })
        .catch(() => {});
      return queuedPromise;
    }

    incRunning(input.projectPath);
    const promise = doSpawn(recordId, input);
    inflight.set(key, promise);
    promise
      .finally(() => {
        if (inflight.get(key) === promise) inflight.delete(key);
      })
      .catch(() => {
        // caller observes rejection
      });
    return promise;
    // queuedResolve/queuedReject reference avoids "declared but never used"
    // when the cap branch isn't taken — they're closure-only.
    void queuedResolve;
    void queuedReject;
  }

  async function doSpawn(recordId: string, input: SpawnWorkerInput): Promise<WorkerRecord> {
    // Phase 3H.2: doSpawn ASSUMES the caller has already incremented
    // runningPerProject (either `spawn` for the immediate path or
    // `drain` for the queued path). On failure here, we decrement +
    // drain so a queued sibling can take the slot.
    let succeeded = false;
    try {
      if (registry.has(recordId)) {
        throw new Error(`worker '${recordId}' already registered`);
      }
      // Fast-fail if already aborted — don't touch the filesystem.
      if (input.signal !== undefined && input.signal.aborted) {
        throw new Error(`spawn_worker aborted before worktree creation (recordId=${recordId})`);
      }
      const featureIntent = input.featureIntent ?? deriveFeatureIntent(input.taskDescription);
      const worktree = await worktreeManager.create({
        projectPath: input.projectPath,
        workerId: recordId,
        shortDescription: featureIntent,
      });
      if (input.signal !== undefined && input.signal.aborted) {
        throw new Error(`spawn_worker aborted after worktree creation (recordId=${recordId})`);
      }

      // Phase 3H.2 — resolve model: caller-provided wins; otherwise the
      // server's `getDefaultModel` (driven by `modelMode`) supplies the
      // default. The resolved value is recorded on the WorkerRecord so
      // SQL persistence reflects the model the worker actually ran on.
      const resolvedModel = input.model ?? opts.getDefaultModel?.();
      const buffer = new CircularBuffer<StreamEvent>(bufferCap);
      const cfg: WorkerConfig = {
        id: recordId,
        cwd: worktree.path,
        prompt: input.taskDescription,
        keepStdinOpen: true,
        deterministicUuidInput: `${recordId}::${worktree.path}`,
        ...(input.signal !== undefined ? { signal: input.signal } : {}),
        ...(resolvedModel !== undefined ? { model: resolvedModel } : {}),
        ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      };

      // Worktree is created before spawn. If workerManager.spawn throws, we
      // intentionally leave the worktree in place for post-mortem. Cleaning
      // it up is a 2A.4 `finalize` concern, not ours.
      const worker = await workerManager.spawn(cfg);

      const record: WorkerRecord = {
        id: recordId,
        projectPath: input.projectPath,
        projectId: input.projectId ?? null,
        taskId: input.taskId ?? null,
        worktreePath: worktree.path,
        role: input.role,
        featureIntent,
        taskDescription: input.taskDescription,
        // Phase 3S — default at spawn time to the orchestrator's
        // configured tier (server wires `() => context.tier` so a Ctrl+Y
        // mid-session flips the default for subsequent spawns). Pre-3S
        // behavior preserved when `getDefaultAutonomyTier` is undefined:
        // legacy test rigs and older config-less callers default to
        // Tier 1.
        autonomyTier:
          input.autonomyTier ?? opts.getDefaultAutonomyTier?.() ?? 1,
        dependsOn: input.dependsOn ?? [],
        status: 'spawning',
        createdAt: nowIso(now),
        worker,
        buffer,
        detach: () => {},
        ...(resolvedModel !== undefined ? { model: resolvedModel } : {}),
      };
      registry.register(record);
      record.detach = attachEventTap(worker, buffer, registry, recordId, now, onEventRef);
      wireExit(recordId, worker, input.projectPath);
      succeeded = true;
      return record;
    } finally {
      if (!succeeded) {
        // Failed before the worker started — release the reservation
        // synchronously and drain so a queued sibling can claim the
        // slot. Successful spawns release in `wireExit` after the
        // worker actually exits.
        decRunning(input.projectPath);
        drain(input.projectPath);
      }
    }
  }

  /**
   * Phase 3H.2 audit M1: `resume()` does NOT gate against the
   * concurrency cap. Resume revives an EXISTING worker that the user
   * (or Maestro) explicitly asked to bring back. Queueing a resume
   * behind unrelated active workers would surprise a user who typed
   * "resume the failed worker" expecting immediate action. Resumes
   * still increment `runningPerProject` so the counter accurately
   * reflects live workers (including over-cap during a resume burst);
   * `getQueueSnapshot.running` may briefly exceed `capacity`.
   */
  async function resume(input: ResumeWorkerInput): Promise<WorkerRecord> {
    const record = registry.get(input.recordId);
    if (!record) throw new Error(`worker '${input.recordId}' not found`);
    if (record.status === 'running' || record.status === 'spawning') {
      throw new Error(
        `worker '${input.recordId}' is ${record.status}; use send_to_worker for follow-ups`,
      );
    }
    const key = inflightKey(record.id, record.projectPath);
    const existing = inflight.get(key);
    if (existing !== undefined) return existing;

    const promise = doResume(record, input);
    inflight.set(key, promise);
    promise
      .finally(() => {
        if (inflight.get(key) === promise) inflight.delete(key);
      })
      .catch(() => {
        // caller observes
      });
    return promise;
  }

  async function doResume(record: WorkerRecord, input: ResumeWorkerInput): Promise<WorkerRecord> {
    const cfg: WorkerConfig = {
      id: record.id,
      cwd: record.worktreePath,
      prompt: input.message,
      keepStdinOpen: true,
      deterministicUuidInput: `${record.id}::${record.worktreePath}`,
      // prefer explicit sessionId so `claude -p` resumes the same conversation
      onStaleResume: 'warn-and-fresh',
      ...(record.sessionId !== undefined ? { sessionId: record.sessionId } : {}),
      ...(record.model !== undefined ? { model: record.model } : {}),
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    };

    // Phase 3H.2: resume re-enters the running pool — count it against
    // the cap. Failure rolls back via the catch block; success holds
    // the slot until wireExit's release.
    incRunning(record.projectPath);
    let succeeded = false;
    try {
      const worker = await workerManager.spawn(cfg);
      registry.replace(record.id, {
        worker,
        buffer: record.buffer,
        detach: () => {},
        ...(record.sessionId !== undefined ? { sessionId: record.sessionId } : {}),
      });
      const reloaded = registry.get(record.id);
      if (!reloaded) throw new Error(`worker '${record.id}' disappeared during resume`);
      reloaded.detach = attachEventTap(worker, reloaded.buffer, registry, record.id, now, onEventRef);
      wireExit(record.id, worker, record.projectPath);
      succeeded = true;
      return reloaded;
    } finally {
      if (!succeeded) {
        decRunning(record.projectPath);
        drain(record.projectPath);
      }
    }
  }

  function wireExit(recordId: string, worker: Worker, projectPath: string): void {
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      decRunning(projectPath);
      drain(projectPath);
    };
    void worker
      .waitForExit()
      .then((exitInfo) => {
        // Defend against resume race: if the record was replaced between spawn
        // and exit, the old worker's exit must not overwrite the new worker's
        // status or sessionId. Identity check on the live worker handle.
        const current = registry.get(recordId);
        if (current === undefined || current.worker !== worker) {
          // Old worker exited after replace — its slot was already
          // re-claimed by the new worker. Don't release a slot the new
          // one is using.
          return;
        }
        registry.markCompleted(recordId, exitInfo, now);
        release();
        // Phase 3H.3 — fire the lifecycle hook AFTER markCompleted (so
        // record.status reflects the terminal state) AND AFTER release()
        // (so getTotalRunning() returns the post-decrement value, which
        // is what the notifications dispatcher's all-done condition
        // depends on). Errors swallowed: a misbehaving consumer must
        // not poison the exit chain.
        if (opts.onWorkerStatusChange !== undefined) {
          try {
            const reloaded = registry.get(recordId);
            if (reloaded !== undefined) {
              opts.onWorkerStatusChange(reloaded, getTotalRunning());
            }
          } catch {
            // swallow
          }
        }
      })
      .catch(() => {
        // exit errors already surface on the buffer; release the slot
        // anyway so a queued sibling can spawn.
        release();
      });
  }

  function getTotalRunning(): number {
    let sum = 0;
    for (const n of runningPerProject.values()) sum += n;
    return sum;
  }

  function cleanup(id: string): void {
    registry.remove(id);
  }

  /**
   * Order: reject queued → kill → await exits → clear. Reordered from
   * the original (which cleared first) so `wireExit` can still observe
   * the live record and call `markCompleted` — without it, clean
   * shutdowns leave SQL rows in `running` state, indistinguishable
   * from a true crash. The 8-second SIGKILL grace from `WorkerManager`
   * still bounds the wait time.
   *
   * Audit M2 (3H.2 review): pending queued spawns are rejected BEFORE
   * we kill running workers. Otherwise, a worker exit during
   * `Promise.all(... waitForExit ...)` would call `release` →
   * `drain`, which would pull a queued entry and spawn ANOTHER worker
   * mid-shutdown. That worker's registration would survive the
   * subsequent `registry.clear()` only as a process-without-record.
   */
  async function shutdown(): Promise<void> {
    // 1. Reject every pending queued spawn — they will not get a slot.
    for (const [projectPath, list] of pendingPerProject) {
      while (list.length > 0) {
        const entry = list.shift()!;
        entry.reject(new Error(`spawn_worker aborted: lifecycle shutdown (recordId=${entry.recordId})`));
      }
      pendingPerProject.delete(projectPath);
    }
    const snapshots = registry.list();
    // 2. Kill — sets stopIntent so classifier returns 'killed'.
    for (const r of snapshots) {
      try {
        r.worker.kill('SIGTERM');
      } catch {
        // best effort
      }
    }
    // 3. Await exits — wireExit fires markCompleted; SQL store gets terminal status.
    await Promise.all(
      snapshots.map((r) => r.worker.waitForExit().catch(() => {})),
    );
    // 4. Drop in-memory state. Rows remain in SQL.
    registry.clear();
    // Defensive — wireExit's release() should have decremented every
    // counter, but a race between an early return path and the clear
    // could leave a stale entry. Cheap belt-and-suspenders.
    runningPerProject.clear();
  }

  function recoverFromStore(): RecoveryReport {
    const store = registry.getStore();
    if (store === undefined) return { crashedIds: [] };
    const survivors = store.list({ status: ['spawning', 'running'] });
    const iso = nowIso(now);
    const crashedIds: string[] = [];
    for (const w of survivors) {
      // Flip in SQL first.
      store.update(w.id, { status: 'crashed', completedAt: iso });
      // Then rehydrate in-memory with a stub record so ID-based tools
      // (`resume_worker`, `find_worker`, `get_worker_output`, `kill_worker`,
      // `send_to_worker`) can address the recovered worker. The stub
      // Worker is non-operational; `resume_worker` is the natural caller
      // that swaps it for a real handle via `replace()` (C1 fix from
      // 2B.1b review).
      const rehydrated = rehydrateRecord(w, bufferCap, resolveProjectPath);
      registry.rehydrate({
        ...rehydrated,
        status: 'crashed',
        completedAt: iso,
      });
      crashedIds.push(w.id);
    }
    return { crashedIds };
  }

  function setOnEvent(callback: ((workerId: string, event: StreamEvent) => void) | undefined): void {
    onEventRef.current = callback;
  }

  function getQueueSnapshot(projectPath: string): QueueSnapshot {
    const running = runningPerProject.get(projectPath) ?? 0;
    const capacity = getCap(projectPath);
    const pending = (pendingPerProject.get(projectPath) ?? []).map((p) => ({
      recordId: p.recordId,
      featureIntent: p.input.featureIntent ?? deriveFeatureIntent(p.input.taskDescription),
      taskDescription: p.input.taskDescription,
    }));
    return { running, capacity, pending };
  }

  function listPendingGlobal(): readonly PendingSpawnSnapshot[] {
    const flat: PendingSpawnSnapshot[] = [];
    for (const [projectPath, list] of pendingPerProject) {
      for (const entry of list) {
        flat.push({
          recordId: entry.recordId,
          projectPath,
          featureIntent:
            entry.input.featureIntent ?? deriveFeatureIntent(entry.input.taskDescription),
          taskDescription: entry.input.taskDescription,
          enqueuedAt: entry.enqueuedAt,
          // Phase 3S — surface the queued spawn's tier so the queue
          // panel can render a Tier-3 chip. Spread guard: omit when
          // undefined so the snapshot remains shape-stable for
          // serialization across the RPC boundary.
          ...(entry.input.autonomyTier !== undefined
            ? { autonomyTier: entry.input.autonomyTier }
            : {}),
        });
      }
    }
    // Stable secondary sort by recordId keeps test fixtures with
    // identical timestamps deterministic across runs.
    flat.sort((a, b) => {
      if (a.enqueuedAt !== b.enqueuedAt) return a.enqueuedAt - b.enqueuedAt;
      return a.recordId < b.recordId ? -1 : a.recordId > b.recordId ? 1 : 0;
    });
    return flat;
  }

  function findPending(
    recordId: string,
  ): { list: PendingSpawn[]; index: number; projectPath: string } | null {
    for (const [projectPath, list] of pendingPerProject) {
      const index = list.findIndex((p) => p.recordId === recordId);
      if (index !== -1) return { list, index, projectPath };
    }
    return null;
  }

  function cancelQueued(recordId: string): { cancelled: boolean; reason?: string } {
    const hit = findPending(recordId);
    if (hit === null) return { cancelled: false, reason: 'not in queue' };
    const [entry] = hit.list.splice(hit.index, 1);
    if (hit.list.length === 0) pendingPerProject.delete(hit.projectPath);
    // Reject AFTER removing from the list so the rejection handler can
    // observe the post-removal state. Synchronous — no I/O here.
    entry!.reject(new QueueCancelledError(recordId));
    return { cancelled: true };
  }

  function killAllRunning(): { killedIds: readonly string[] } {
    const killedIds: string[] = [];
    for (const record of registry.list()) {
      if (TERMINAL_STATUSES.has(record.status)) continue;
      try {
        // Pass intent='interrupt' so WorkerImpl.kill stamps stopIntent
        // accordingly (precedence-aware — see Phase 3T commit 2).
        // Recovered stubs have terminal status and are filtered out
        // by the TERMINAL_STATUSES guard above.
        record.worker.kill('SIGTERM', 'interrupt');
        killedIds.push(record.id);
      } catch {
        // best effort — a worker that throws during kill is already
        // exiting; the wireExit chain will classify it on its own.
      }
    }
    return { killedIds };
  }

  function cancelAllQueued(): { cancelledIds: readonly string[] } {
    const cancelledIds: string[] = [];
    // Walk a snapshot of recordIds (listPendingGlobal is already a snapshot)
    // so `cancelQueued`'s in-place splice doesn't shift the iteration.
    for (const entry of listPendingGlobal()) {
      const result = cancelQueued(entry.recordId);
      if (result.cancelled) cancelledIds.push(entry.recordId);
    }
    return { cancelledIds };
  }

  function reorderQueued(
    recordId: string,
    direction: 'up' | 'down',
  ): { moved: boolean; reason?: string } {
    const hit = findPending(recordId);
    if (hit === null) return { moved: false, reason: 'not in queue' };
    const neighborIdx = direction === 'up' ? hit.index - 1 : hit.index + 1;
    if (neighborIdx < 0 || neighborIdx >= hit.list.length) {
      return { moved: false, reason: 'no neighbor' };
    }
    const a = hit.list[hit.index]!;
    const b = hit.list[neighborIdx]!;
    // Swap positions AND timestamps so the cross-project merge in
    // `listPendingGlobal` reflects the new order.
    hit.list[hit.index] = b;
    hit.list[neighborIdx] = a;
    const tmp = a.enqueuedAt;
    a.enqueuedAt = b.enqueuedAt;
    b.enqueuedAt = tmp;
    return { moved: true };
  }

  return {
    spawn,
    resume,
    cleanup,
    shutdown,
    recoverFromStore,
    setOnEvent,
    getQueueSnapshot,
    getTotalRunning,
    listPendingGlobal,
    cancelQueued,
    reorderQueued,
    killAllRunning,
    cancelAllQueued,
  };
}

/**
 * A non-operational `Worker` used for rehydrated records whose live
 * subprocess died with the previous orchestrator. Calls to `kill`,
 * `sendFollowup`, `endInput` no-op; `events` is empty; `waitForExit`
 * resolves immediately with the recovered status. Tools that DO try to
 * use the live handle (e.g. `kill_worker`) get a clean no-op rather
 * than an exception.
 */
function makeStubWorker(id: string, status: WorkerStatus, sessionId?: string): Worker {
  const exitInfo: WorkerExitInfo = {
    status,
    exitCode: null,
    signal: null,
    durationMs: 0,
    ...(sessionId !== undefined ? { sessionId } : {}),
  };
  return {
    id,
    sessionId,
    status,
    events: (async function* () {})(),
    sendFollowup() {
      throw new Error(`worker ${id} is ${status}; resume_worker first`);
    },
    endInput() {},
    kill() {},
    waitForExit: async () => exitInfo,
  };
}

function rehydrateRecord(
  persisted: PersistedWorkerRecord,
  bufferCap: number,
  resolveProjectPath: (projectId: string | null) => string,
): WorkerRecord {
  const stubWorker = makeStubWorker(persisted.id, persisted.status, persisted.sessionId);
  return {
    id: persisted.id,
    projectPath: resolveProjectPath(persisted.projectId),
    projectId: persisted.projectId,
    taskId: persisted.taskId,
    worktreePath: persisted.worktreePath,
    role: persisted.role,
    featureIntent: persisted.featureIntent,
    taskDescription: persisted.taskDescription,
    autonomyTier: persisted.autonomyTier,
    dependsOn: persisted.dependsOn,
    status: persisted.status,
    createdAt: persisted.createdAt,
    worker: stubWorker,
    buffer: new CircularBuffer<StreamEvent>(bufferCap),
    detach: () => {},
    ...(persisted.model !== undefined ? { model: persisted.model } : {}),
    ...(persisted.sessionId !== undefined ? { sessionId: persisted.sessionId } : {}),
    ...(persisted.completedAt !== undefined ? { completedAt: persisted.completedAt } : {}),
    ...(persisted.lastEventAt !== undefined ? { lastEventAt: persisted.lastEventAt } : {}),
    ...(persisted.costUsd !== undefined ? { costUsd: persisted.costUsd } : {}),
    ...(persisted.sessionUsage !== undefined ? { sessionUsage: persisted.sessionUsage } : {}),
    ...(persisted.exitCode !== undefined && persisted.exitCode !== null
      ? {
          exitInfo: {
            status: persisted.status,
            exitCode: persisted.exitCode,
            signal: persisted.exitSignal ?? null,
            durationMs: 0,
          },
        }
      : {}),
  };
}
