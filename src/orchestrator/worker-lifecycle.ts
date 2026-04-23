import { randomBytes } from 'node:crypto';
import type { WorkerManager } from '../workers/manager.js';
import type { StreamEvent, Worker, WorkerConfig } from '../workers/types.js';
import type { WorktreeManager } from '../worktree/manager.js';
import { deriveFeatureIntent } from './feature-intent.js';
import {
  CircularBuffer,
  DEFAULT_OUTPUT_BUFFER_CAP,
  type WorkerRegistry,
  type WorkerRecord,
} from './worker-registry.js';
import type { AutonomyTier, WorkerRole } from './types.js';

export interface SpawnWorkerInput {
  readonly projectPath: string;
  readonly taskDescription: string;
  readonly role: WorkerRole;
  readonly model?: string;
  readonly dependsOn?: readonly string[];
  readonly autonomyTier?: AutonomyTier;
  readonly id?: string;
  readonly featureIntent?: string;
  readonly timeoutMs?: number;
}

export interface ResumeWorkerInput {
  readonly recordId: string;
  readonly message: string;
  readonly timeoutMs?: number;
}

export interface WorkerLifecycleOptions {
  readonly registry: WorkerRegistry;
  readonly workerManager: WorkerManager;
  readonly worktreeManager: WorktreeManager;
  readonly outputBufferCap?: number;
  readonly now?: () => number;
  readonly idGenerator?: () => string;
}

export interface WorkerLifecycleHandle {
  spawn(input: SpawnWorkerInput): Promise<WorkerRecord>;
  resume(input: ResumeWorkerInput): Promise<WorkerRecord>;
  cleanup(id: string): void;
  shutdown(): Promise<void>;
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
): () => void {
  let stopped = false;
  void (async () => {
    try {
      for await (const event of worker.events) {
        if (stopped) break;
        buffer.push(event);
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
    const featureIntent = input.featureIntent ?? deriveFeatureIntent(input.taskDescription);
    const worktree = await worktreeManager.create({
      projectPath: input.projectPath,
      workerId: recordId,
      shortDescription: featureIntent,
    });

    const buffer = new CircularBuffer<StreamEvent>(bufferCap);
    const cfg: WorkerConfig = {
      id: recordId,
      cwd: worktree.path,
      prompt: input.taskDescription,
      keepStdinOpen: true,
      deterministicUuidInput: `${recordId}::${worktree.path}`,
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
    record.detach = attachEventTap(worker, buffer, registry, recordId);
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
    reloaded.detach = attachEventTap(worker, reloaded.buffer, registry, record.id);
    wireExit(record.id, worker);
    return reloaded;
  }

  function wireExit(recordId: string, worker: Worker): void {
    void worker
      .waitForExit()
      .then((exitInfo) => {
        registry.markCompleted(recordId, exitInfo, now);
      })
      .catch(() => {
        // exit errors already surface on the buffer
      });
  }

  function cleanup(id: string): void {
    registry.remove(id);
  }

  async function shutdown(): Promise<void> {
    const snapshots = registry.list();
    registry.clear();
    await Promise.all(
      snapshots.map(async (r) => {
        try {
          r.worker.kill('SIGTERM');
        } catch {
          // best effort
        }
        await r.worker.waitForExit().catch(() => {});
      }),
    );
  }

  return { spawn, resume, cleanup, shutdown };
}
