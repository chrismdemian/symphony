import { describe, expect, it } from 'vitest';
import { createWorkerLifecycle } from '../../src/orchestrator/worker-lifecycle.js';
import { WorkerRegistry } from '../../src/orchestrator/worker-registry.js';
import type { WorkerManager } from '../../src/workers/manager.js';
import type {
  StreamEvent,
  Worker,
  WorkerConfig,
  WorkerExitInfo,
} from '../../src/workers/types.js';
import type { WorktreeManager } from '../../src/worktree/manager.js';
import type { CreateWorktreeOptions, WorktreeInfo } from '../../src/worktree/types.js';

/**
 * Phase 3H.2 — concurrency cap + queue gate behavior. Spawns are
 * gated by `getMaxConcurrentWorkers`; over-cap requests queue and
 * resolve when an in-flight worker exits (or the spawn itself fails).
 */

class ScriptedWorker implements Worker {
  readonly id: string;
  sessionId: string | undefined = undefined;
  status: 'spawning' | 'running' | 'completed' | 'failed' | 'killed' | 'timeout' | 'crashed' =
    'running';
  private readonly events_: AsyncIterable<StreamEvent>;
  private resolveExit: ((info: WorkerExitInfo) => void) | null = null;
  private readonly exitPromise: Promise<WorkerExitInfo>;

  constructor(id: string, events: AsyncIterable<StreamEvent>) {
    this.id = id;
    this.events_ = events;
    this.exitPromise = new Promise<WorkerExitInfo>((resolve) => {
      this.resolveExit = resolve;
    });
  }

  get events(): AsyncIterable<StreamEvent> {
    return this.events_;
  }
  sendFollowup(): void {}
  endInput(): void {}
  kill(): void {
    this.complete({ status: 'killed', exitCode: null, signal: 'SIGTERM', durationMs: 0 });
  }
  waitForExit(): Promise<WorkerExitInfo> {
    return this.exitPromise;
  }
  complete(info: WorkerExitInfo): void {
    this.status = info.status;
    this.resolveExit?.(info);
  }
}

async function* emitEvents(events: StreamEvent[]): AsyncGenerator<StreamEvent> {
  for (const ev of events) yield ev;
}

interface QueuedWorkerManager {
  mgr: WorkerManager;
  spawnCalls: WorkerConfig[];
  scripts: Map<string, ScriptedWorker>;
  failOnNextSpawn(err: Error): void;
}

function queuedWorkerManager(): QueuedWorkerManager {
  const spawnCalls: WorkerConfig[] = [];
  const scripts = new Map<string, ScriptedWorker>();
  let nextError: Error | null = null;
  const mgr = {
    spawn: async (cfg: WorkerConfig): Promise<Worker> => {
      spawnCalls.push(cfg);
      if (nextError) {
        const err = nextError;
        nextError = null;
        throw err;
      }
      const w = new ScriptedWorker(cfg.id, emitEvents([]));
      scripts.set(cfg.id, w);
      return w;
    },
    list: () => [],
    get: () => undefined,
    shutdown: async () => {},
  } as unknown as WorkerManager;
  return {
    mgr,
    spawnCalls,
    scripts,
    failOnNextSpawn: (err: Error) => {
      nextError = err;
    },
  };
}

function stubWorktreeManager(): WorktreeManager {
  return {
    create: async (opts: CreateWorktreeOptions): Promise<WorktreeInfo> => ({
      id: opts.workerId,
      path: `/wt/${opts.workerId}`,
      branch: `symphony/${opts.workerId}`,
      baseRef: 'refs/heads/main',
      projectPath: opts.projectPath,
      createdAt: '2026-05-06T00:00:00.000Z',
    }),
    list: async () => [],
    remove: async () => {},
    removeIfClean: async () => true,
    status: async () => ({
      hasChanges: false,
      staged: [],
      unstaged: [],
      untracked: [],
    }),
  } as unknown as WorktreeManager;
}

describe('createWorkerLifecycle — concurrency cap + queue (3H.2)', () => {
  it('uncapped (no getMaxConcurrentWorkers): all spawns proceed immediately', async () => {
    const registry = new WorkerRegistry();
    const wm = queuedWorkerManager();
    const lc = createWorkerLifecycle({
      registry,
      workerManager: wm.mgr,
      worktreeManager: stubWorktreeManager(),
    });
    const ids = ['a', 'b', 'c', 'd'];
    const results = await Promise.all(
      ids.map((id) =>
        lc.spawn({
          id,
          projectPath: '/proj',
          taskDescription: `task ${id}`,
          role: 'implementer',
        }),
      ),
    );
    expect(results.map((r) => r.id)).toEqual(ids);
    expect(wm.spawnCalls.length).toBe(4);
  });

  it('cap=2, three spawn requests: third queues until first exits', async () => {
    const registry = new WorkerRegistry();
    const wm = queuedWorkerManager();
    const lc = createWorkerLifecycle({
      registry,
      workerManager: wm.mgr,
      worktreeManager: stubWorktreeManager(),
      getMaxConcurrentWorkers: () => 2,
    });
    // Fire all three concurrently. The third should not call
    // workerManager.spawn until the first exits.
    const p1 = lc.spawn({
      id: 'w1',
      projectPath: '/proj',
      taskDescription: 'first',
      role: 'implementer',
    });
    const p2 = lc.spawn({
      id: 'w2',
      projectPath: '/proj',
      taskDescription: 'second',
      role: 'implementer',
    });
    const p3 = lc.spawn({
      id: 'w3',
      projectPath: '/proj',
      taskDescription: 'third',
      role: 'implementer',
    });
    // Allow first two to settle.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(wm.spawnCalls.length).toBe(2);
    let snap = lc.getQueueSnapshot('/proj');
    expect(snap.running).toBe(2);
    expect(snap.capacity).toBe(2);
    expect(snap.pending.length).toBe(1);
    expect(snap.pending[0]?.recordId).toBe('w3');

    await p1;
    await p2;

    // Exit w1 → drain → w3 spawns.
    wm.scripts.get('w1')!.complete({
      status: 'completed',
      exitCode: 0,
      signal: null,
      durationMs: 100,
    });
    const r3 = await p3;
    expect(r3.id).toBe('w3');
    expect(wm.spawnCalls.length).toBe(3);

    snap = lc.getQueueSnapshot('/proj');
    expect(snap.running).toBe(2); // w2 still running, w3 just spawned, w1 exited
    expect(snap.pending.length).toBe(0);
  });

  it('cap is per-project: project A and project B don\'t block each other', async () => {
    const registry = new WorkerRegistry();
    const wm = queuedWorkerManager();
    const lc = createWorkerLifecycle({
      registry,
      workerManager: wm.mgr,
      worktreeManager: stubWorktreeManager(),
      getMaxConcurrentWorkers: () => 1,
    });
    const a1 = lc.spawn({
      id: 'a1',
      projectPath: '/projA',
      taskDescription: 'A1',
      role: 'implementer',
    });
    const b1 = lc.spawn({
      id: 'b1',
      projectPath: '/projB',
      taskDescription: 'B1',
      role: 'implementer',
    });
    await Promise.all([a1, b1]);
    // Both spawned despite cap=1, because they're in different projects.
    expect(wm.spawnCalls.length).toBe(2);
    expect(lc.getQueueSnapshot('/projA').running).toBe(1);
    expect(lc.getQueueSnapshot('/projB').running).toBe(1);
  });

  it('AbortSignal aborts a queued spawn without ever calling workerManager.spawn', async () => {
    const registry = new WorkerRegistry();
    const wm = queuedWorkerManager();
    const lc = createWorkerLifecycle({
      registry,
      workerManager: wm.mgr,
      worktreeManager: stubWorktreeManager(),
      getMaxConcurrentWorkers: () => 1,
    });
    const ac = new AbortController();
    const p1 = lc.spawn({
      id: 'first',
      projectPath: '/proj',
      taskDescription: 'first',
      role: 'implementer',
    });
    const p2 = lc.spawn({
      id: 'queued',
      projectPath: '/proj',
      taskDescription: 'queued',
      role: 'implementer',
      signal: ac.signal,
    });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(wm.spawnCalls.length).toBe(1);
    expect(lc.getQueueSnapshot('/proj').pending.length).toBe(1);

    ac.abort();
    await expect(p2).rejects.toThrow(/aborted while queued/);
    // queue cleared; first still running
    expect(lc.getQueueSnapshot('/proj').pending.length).toBe(0);
    expect(wm.spawnCalls.length).toBe(1);
    await p1; // p1 still resolves cleanly
  });

  it('failed spawn (workerManager throws) drains the queue so a sibling can claim the slot', async () => {
    const registry = new WorkerRegistry();
    const wm = queuedWorkerManager();
    const lc = createWorkerLifecycle({
      registry,
      workerManager: wm.mgr,
      worktreeManager: stubWorktreeManager(),
      getMaxConcurrentWorkers: () => 1,
    });
    wm.failOnNextSpawn(new Error('boom'));
    const p1 = lc.spawn({
      id: 'failing',
      projectPath: '/proj',
      taskDescription: 'fails',
      role: 'implementer',
    });
    const p2 = lc.spawn({
      id: 'sibling',
      projectPath: '/proj',
      taskDescription: 'second',
      role: 'implementer',
    });
    await expect(p1).rejects.toThrow(/boom/);
    const r2 = await p2;
    expect(r2.id).toBe('sibling');
    expect(wm.spawnCalls.length).toBe(2); // first attempted (threw), second succeeded
    expect(lc.getQueueSnapshot('/proj').running).toBe(1);
  });

  it.each([0, -1, Number.NaN, -Number.POSITIVE_INFINITY, 0.5, 2.5])(
    'out-of-range cap (%s) is treated as uncapped',
    async (cap) => {
      const registry = new WorkerRegistry();
      const wm = queuedWorkerManager();
      const lc = createWorkerLifecycle({
        registry,
        workerManager: wm.mgr,
        worktreeManager: stubWorktreeManager(),
        getMaxConcurrentWorkers: () => cap,
      });
      const results = await Promise.all([
        lc.spawn({ id: 'x', projectPath: '/p', taskDescription: 't', role: 'implementer' }),
        lc.spawn({ id: 'y', projectPath: '/p', taskDescription: 't', role: 'implementer' }),
      ]);
      expect(results.length).toBe(2);
      expect(wm.spawnCalls.length).toBe(2);
      expect(lc.getQueueSnapshot('/p').capacity).toBe(Number.POSITIVE_INFINITY);
    },
  );

  it('pre-aborted signal at queue time rejects synchronously (audit C1)', async () => {
    const registry = new WorkerRegistry();
    const wm = queuedWorkerManager();
    const lc = createWorkerLifecycle({
      registry,
      workerManager: wm.mgr,
      worktreeManager: stubWorktreeManager(),
      getMaxConcurrentWorkers: () => 1,
    });
    // First spawn occupies the slot but stays alive (no exit yet).
    const first = lc.spawn({
      id: 'first',
      projectPath: '/p',
      taskDescription: 'first',
      role: 'implementer',
    });
    await new Promise((r) => setImmediate(r));

    // Second spawn arrives with an ALREADY-aborted signal. Without
    // the C1 fix, this would queue + hang because the abort listener
    // never fires.
    const ac = new AbortController();
    ac.abort();
    await expect(
      lc.spawn({
        id: 'preaborted',
        projectPath: '/p',
        taskDescription: 'pre',
        role: 'implementer',
        signal: ac.signal,
      }),
    ).rejects.toThrow(/aborted before queue/);

    // The queue is empty after rejection; first still resolves cleanly.
    expect(lc.getQueueSnapshot('/p').pending.length).toBe(0);
    await first;
  });

  it('shutdown rejects pending queued spawns and prevents drain mid-shutdown (audit M2)', async () => {
    const registry = new WorkerRegistry();
    const wm = queuedWorkerManager();
    const lc = createWorkerLifecycle({
      registry,
      workerManager: wm.mgr,
      worktreeManager: stubWorktreeManager(),
      getMaxConcurrentWorkers: () => 1,
    });
    const first = lc.spawn({
      id: 'first',
      projectPath: '/p',
      taskDescription: 'first',
      role: 'implementer',
    });
    const queued = lc.spawn({
      id: 'queued',
      projectPath: '/p',
      taskDescription: 'queued',
      role: 'implementer',
    });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(wm.spawnCalls.length).toBe(1);
    expect(lc.getQueueSnapshot('/p').pending.length).toBe(1);

    // Drive shutdown: queued must reject; running gets killed.
    const queuedRejection = expect(queued).rejects.toThrow(/shutdown/);
    const shutdownPromise = lc.shutdown();
    await queuedRejection;
    // first will resolve (kill triggers complete); shutdown waits.
    await first.catch(() => {});
    await shutdownPromise;
    // Even though `first` exited mid-shutdown, no new worker was spawned
    // for the queued entry.
    expect(wm.spawnCalls.length).toBe(1);
  });

  it('concurrent same-recordId during queue dedups via inflight map (audit M3)', async () => {
    const registry = new WorkerRegistry();
    const wm = queuedWorkerManager();
    const lc = createWorkerLifecycle({
      registry,
      workerManager: wm.mgr,
      worktreeManager: stubWorktreeManager(),
      getMaxConcurrentWorkers: () => 1,
    });
    const first = lc.spawn({
      id: 'first',
      projectPath: '/p',
      taskDescription: 'first',
      role: 'implementer',
    });
    await new Promise((r) => setImmediate(r));
    const queuedA = lc.spawn({
      id: 'dup',
      projectPath: '/p',
      taskDescription: 'a',
      role: 'implementer',
    });
    const queuedB = lc.spawn({
      id: 'dup',
      projectPath: '/p',
      taskDescription: 'b',
      role: 'implementer',
    });
    // Async function wrappers wrap the inflight promise so identity
    // doesn't match. The dedup contract is "same recordId resolves to
    // same record without spawning twice" — assert via resolved values
    // and the spawn-call count.
    await new Promise((r) => setImmediate(r));
    expect(lc.getQueueSnapshot('/p').pending.length).toBe(1);

    // Drain by completing first.
    wm.scripts.get('first')!.complete({
      status: 'completed',
      exitCode: 0,
      signal: null,
      durationMs: 1,
    });
    await first;
    const [recA, recB] = await Promise.all([queuedA, queuedB]);
    expect(recA).toBe(recB);
    expect(recA.id).toBe('dup');
    // Critically: only ONE workerManager.spawn call for the dup id.
    expect(wm.spawnCalls.filter((c) => c.id === 'dup').length).toBe(1);
  });

  it('empty-string projectPath does not cross-contaminate per-project counters (audit C2-adjacent)', async () => {
    // The lifecycle itself uses string keys verbatim; the server-side
    // getMaxConcurrentWorkers short-circuits empty path to global. This
    // test exercises the lifecycle's own bucket keying — empty path
    // maps to its own bucket, distinct from named projects.
    const registry = new WorkerRegistry();
    const wm = queuedWorkerManager();
    const lc = createWorkerLifecycle({
      registry,
      workerManager: wm.mgr,
      worktreeManager: stubWorktreeManager(),
      getMaxConcurrentWorkers: () => 1,
    });
    const empty = lc.spawn({
      id: 'orphan',
      projectPath: '',
      taskDescription: 'orphan',
      role: 'implementer',
    });
    const named = lc.spawn({
      id: 'named',
      projectPath: '/proj',
      taskDescription: 'named',
      role: 'implementer',
    });
    await Promise.all([empty, named]);
    expect(wm.spawnCalls.length).toBe(2);
    expect(lc.getQueueSnapshot('').running).toBe(1);
    expect(lc.getQueueSnapshot('/proj').running).toBe(1);
  });

  it('getQueueSnapshot returns a stable structure for an empty project', () => {
    const registry = new WorkerRegistry();
    const wm = queuedWorkerManager();
    const lc = createWorkerLifecycle({
      registry,
      workerManager: wm.mgr,
      worktreeManager: stubWorktreeManager(),
      getMaxConcurrentWorkers: () => 4,
    });
    const snap = lc.getQueueSnapshot('/empty');
    expect(snap).toEqual({ running: 0, capacity: 4, pending: [] });
  });

  it('drain processes multiple queued entries when cap allows', async () => {
    const registry = new WorkerRegistry();
    const wm = queuedWorkerManager();
    const lc = createWorkerLifecycle({
      registry,
      workerManager: wm.mgr,
      worktreeManager: stubWorktreeManager(),
      getMaxConcurrentWorkers: () => 2,
    });
    // Spawn 4 — first 2 run, last 2 queue.
    const ps = ['a', 'b', 'c', 'd'].map((id) =>
      lc.spawn({
        id,
        projectPath: '/p',
        taskDescription: id,
        role: 'implementer',
      }),
    );
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(wm.spawnCalls.length).toBe(2);
    expect(lc.getQueueSnapshot('/p').pending.length).toBe(2);

    // Exit a + b → c + d both drain.
    wm.scripts.get('a')!.complete({
      status: 'completed',
      exitCode: 0,
      signal: null,
      durationMs: 1,
    });
    wm.scripts.get('b')!.complete({
      status: 'completed',
      exitCode: 0,
      signal: null,
      durationMs: 1,
    });
    await Promise.all(ps);
    expect(wm.spawnCalls.length).toBe(4);
    expect(lc.getQueueSnapshot('/p').pending.length).toBe(0);
  });
});
