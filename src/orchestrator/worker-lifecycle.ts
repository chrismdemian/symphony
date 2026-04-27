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
}

function defaultIdGenerator(): string {
  return `wk-${randomBytes(4).toString('hex')}`;
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
  const inflight = new Map<string, Promise<WorkerRecord>>();

  function inflightKey(recordId: string, projectPath: string): string {
    return `${recordId}::${projectPath}`;
  }

  async function spawn(input: SpawnWorkerInput): Promise<WorkerRecord> {
    const recordId = input.id ?? genId();
    const key = inflightKey(recordId, input.projectPath);
    const existing = inflight.get(key);
    if (existing !== undefined) return existing;

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
  }

  async function doSpawn(recordId: string, input: SpawnWorkerInput): Promise<WorkerRecord> {
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

    const buffer = new CircularBuffer<StreamEvent>(bufferCap);
    const cfg: WorkerConfig = {
      id: recordId,
      cwd: worktree.path,
      prompt: input.taskDescription,
      keepStdinOpen: true,
      deterministicUuidInput: `${recordId}::${worktree.path}`,
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
      ...(input.model !== undefined ? { model: input.model } : {}),
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
      autonomyTier: input.autonomyTier ?? 1,
      dependsOn: input.dependsOn ?? [],
      status: 'spawning',
      createdAt: nowIso(now),
      worker,
      buffer,
      detach: () => {},
      ...(input.model !== undefined ? { model: input.model } : {}),
    };
    registry.register(record);
    record.detach = attachEventTap(worker, buffer, registry, recordId, now);
    wireExit(recordId, worker);
    return record;
  }

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

    const worker = await workerManager.spawn(cfg);
    registry.replace(record.id, {
      worker,
      buffer: record.buffer,
      detach: () => {},
      ...(record.sessionId !== undefined ? { sessionId: record.sessionId } : {}),
    });
    const reloaded = registry.get(record.id);
    if (!reloaded) throw new Error(`worker '${record.id}' disappeared during resume`);
    reloaded.detach = attachEventTap(worker, reloaded.buffer, registry, record.id, now);
    wireExit(record.id, worker);
    return reloaded;
  }

  function wireExit(recordId: string, worker: Worker): void {
    void worker
      .waitForExit()
      .then((exitInfo) => {
        // Defend against resume race: if the record was replaced between spawn
        // and exit, the old worker's exit must not overwrite the new worker's
        // status or sessionId. Identity check on the live worker handle.
        const current = registry.get(recordId);
        if (current === undefined || current.worker !== worker) return;
        registry.markCompleted(recordId, exitInfo, now);
      })
      .catch(() => {
        // exit errors already surface on the buffer
      });
  }

  function cleanup(id: string): void {
    registry.remove(id);
  }

  /**
   * Order: kill → await exits → clear. Reordered from the original
   * (which cleared first) so `wireExit` can still observe the live
   * record and call `markCompleted` — without it, clean shutdowns leave
   * SQL rows in `running` state, indistinguishable from a true crash.
   * The 8-second SIGKILL grace from `WorkerManager` still bounds the
   * wait time.
   */
  async function shutdown(): Promise<void> {
    const snapshots = registry.list();
    // 1. Kill first — sets stopIntent so classifier returns 'killed'.
    for (const r of snapshots) {
      try {
        r.worker.kill('SIGTERM');
      } catch {
        // best effort
      }
    }
    // 2. Await exits — wireExit fires markCompleted; SQL store gets terminal status.
    await Promise.all(
      snapshots.map((r) => r.worker.waitForExit().catch(() => {})),
    );
    // 3. Now drop in-memory state. Rows remain in SQL.
    registry.clear();
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

  return { spawn, resume, cleanup, shutdown, recoverFromStore };
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
