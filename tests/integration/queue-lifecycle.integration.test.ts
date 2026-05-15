import { describe, expect, it } from 'vitest';
import {
  QueueCancelledError,
  createWorkerLifecycle,
} from '../../src/orchestrator/worker-lifecycle.js';
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
 * Phase 3L integration — end-to-end queue lifecycle. Real
 * `createWorkerLifecycle`, real `WorkerRegistry`, real cap/queue/drain
 * machinery; stub `WorkerManager` + `WorktreeManager` (the lifecycle's
 * boundary with the OS).
 *
 * Scenario: cap=1, three spawns across two projects. Cancel the second
 * queued in /projA, reorder the third up so it becomes the new head of
 * /projA's queue. Drain. Assert the cancel rejected with
 * `QueueCancelledError` and the reordered worker spawned next.
 */

class ScriptedWorker implements Worker {
  readonly id: string;
  sessionId: string | undefined = undefined;
  status: 'spawning' | 'running' | 'completed' | 'failed' | 'killed' | 'timeout' | 'crashed' | 'interrupted' =
    'running';
  private readonly events_: AsyncIterable<StreamEvent>;
  private resolveExit: ((info: WorkerExitInfo) => void) | null = null;
  private readonly exitPromise: Promise<WorkerExitInfo>;
  constructor(id: string) {
    this.id = id;
    this.events_ = (async function* () {})();
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

function setup(): {
  lc: ReturnType<typeof createWorkerLifecycle>;
  scripts: Map<string, ScriptedWorker>;
  spawnOrder: string[];
} {
  const registry = new WorkerRegistry();
  const scripts = new Map<string, ScriptedWorker>();
  const spawnOrder: string[] = [];
  const wm = {
    spawn: async (cfg: WorkerConfig): Promise<Worker> => {
      spawnOrder.push(cfg.id);
      const w = new ScriptedWorker(cfg.id);
      scripts.set(cfg.id, w);
      return w;
    },
    list: () => [],
    get: () => undefined,
    shutdown: async () => {},
  } as unknown as WorkerManager;
  const worktree = {
    create: async (opts: CreateWorktreeOptions): Promise<WorktreeInfo> => ({
      id: opts.workerId,
      path: `/wt/${opts.workerId}`,
      branch: `symphony/${opts.workerId}`,
      baseRef: 'refs/heads/main',
      projectPath: opts.projectPath,
      createdAt: new Date().toISOString(),
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
  let t = 1000;
  const lc = createWorkerLifecycle({
    registry,
    workerManager: wm,
    worktreeManager: worktree,
    getMaxConcurrentWorkers: () => 1,
    now: () => {
      t += 1;
      return t;
    },
  });
  return { lc, scripts, spawnOrder };
}

const settle = async (): Promise<void> => {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
};

describe('queue lifecycle integration (3L)', () => {
  it('cancel + reorder + drain across two projects respects FIFO and the reorder', async () => {
    const { lc, scripts, spawnOrder } = setup();

    // Project A: a1 runs immediately (cap=1), a2 + a3 queue.
    // Project B: b1 runs immediately (different project), b2 queues.
    const pA1 = lc.spawn({
      id: 'a1',
      projectPath: '/projA',
      taskDescription: 'A1 task',
      role: 'implementer',
    });
    await settle();
    const pA2 = lc.spawn({
      id: 'a2',
      projectPath: '/projA',
      taskDescription: 'A2 task',
      role: 'implementer',
    });
    await settle();
    const pA3 = lc.spawn({
      id: 'a3',
      projectPath: '/projA',
      taskDescription: 'A3 task',
      role: 'implementer',
    });
    await settle();
    const pB1 = lc.spawn({
      id: 'b1',
      projectPath: '/projB',
      taskDescription: 'B1 task',
      role: 'implementer',
    });
    await settle();
    const pB2 = lc.spawn({
      id: 'b2',
      projectPath: '/projB',
      taskDescription: 'B2 task',
      role: 'implementer',
    });
    await settle();

    expect(spawnOrder).toEqual(['a1', 'b1']);
    const flat = lc.listPendingGlobal();
    expect(flat.map((p) => p.recordId)).toEqual(['a2', 'a3', 'b2']);

    // Cancel a2 — a3 stays in queue (now /projA's head).
    const cancelResult = lc.cancelQueued('a2');
    expect(cancelResult).toEqual({ cancelled: true });
    await expect(pA2).rejects.toBeInstanceOf(QueueCancelledError);
    expect(lc.listPendingGlobal().map((p) => p.recordId)).toEqual(['a3', 'b2']);

    // Reorder a3 down — but a3 is the only /projA queued entry; no-op.
    expect(lc.reorderQueued('a3', 'down')).toEqual({
      moved: false,
      reason: 'no neighbor',
    });

    // Drain: complete a1 → a3 spawns next.
    scripts.get('a1')!.complete({
      status: 'completed',
      exitCode: 0,
      signal: null,
      durationMs: 1,
    });
    const rA3 = await pA3;
    expect(rA3.id).toBe('a3');
    expect(spawnOrder).toEqual(['a1', 'b1', 'a3']);

    // Complete b1 → b2 drains.
    scripts.get('b1')!.complete({
      status: 'completed',
      exitCode: 0,
      signal: null,
      durationMs: 1,
    });
    const rB2 = await pB2;
    expect(rB2.id).toBe('b2');
    expect(spawnOrder).toEqual(['a1', 'b1', 'a3', 'b2']);

    // Final cleanup.
    await pA1;
    await pB1;
    scripts.get('a3')!.complete({
      status: 'completed',
      exitCode: 0,
      signal: null,
      durationMs: 1,
    });
    scripts.get('b2')!.complete({
      status: 'completed',
      exitCode: 0,
      signal: null,
      durationMs: 1,
    });
  });

  it('reorder within same project changes spawn order on drain', async () => {
    const { lc, scripts, spawnOrder } = setup();

    const pR = lc.spawn({
      id: 'running',
      projectPath: '/p',
      taskDescription: 'running',
      role: 'implementer',
    });
    await settle();
    const pQ1 = lc.spawn({
      id: 'q1',
      projectPath: '/p',
      taskDescription: 'q1',
      role: 'implementer',
    });
    await settle();
    const pQ2 = lc.spawn({
      id: 'q2',
      projectPath: '/p',
      taskDescription: 'q2',
      role: 'implementer',
    });
    await settle();
    const pQ3 = lc.spawn({
      id: 'q3',
      projectPath: '/p',
      taskDescription: 'q3',
      role: 'implementer',
    });
    await settle();

    expect(lc.listPendingGlobal().map((p) => p.recordId)).toEqual(['q1', 'q2', 'q3']);

    // Move q3 to the front by reordering twice.
    expect(lc.reorderQueued('q3', 'up')).toEqual({ moved: true });
    expect(lc.reorderQueued('q3', 'up')).toEqual({ moved: true });
    expect(lc.listPendingGlobal().map((p) => p.recordId)).toEqual(['q3', 'q1', 'q2']);

    // Drain head-to-tail: running → q3 → q1 → q2
    scripts.get('running')!.complete({ status: 'completed', exitCode: 0, signal: null, durationMs: 1 });
    expect((await pQ3).id).toBe('q3');
    scripts.get('q3')!.complete({ status: 'completed', exitCode: 0, signal: null, durationMs: 1 });
    expect((await pQ1).id).toBe('q1');
    scripts.get('q1')!.complete({ status: 'completed', exitCode: 0, signal: null, durationMs: 1 });
    expect((await pQ2).id).toBe('q2');
    scripts.get('q2')!.complete({ status: 'completed', exitCode: 0, signal: null, durationMs: 1 });

    expect(spawnOrder).toEqual(['running', 'q3', 'q1', 'q2']);
    await pR;
  });

  it('cancel during draining race: returns not-in-queue if the entry was just promoted', async () => {
    const { lc, scripts, spawnOrder } = setup();

    const pR = lc.spawn({
      id: 'running',
      projectPath: '/p',
      taskDescription: 'r',
      role: 'implementer',
    });
    await settle();
    const pQ = lc.spawn({
      id: 'queued',
      projectPath: '/p',
      taskDescription: 'q',
      role: 'implementer',
    });
    await settle();
    // Complete running → drain pulls 'queued' off the list synchronously
    // (incRunning() + doSpawn() chain inside drain), so by the time we
    // try to cancel, the entry is no longer in pendingPerProject.
    scripts.get('running')!.complete({ status: 'completed', exitCode: 0, signal: null, durationMs: 1 });
    await pR;
    await pQ; // wait for queued to actually spawn
    const result = lc.cancelQueued('queued');
    expect(result).toEqual({ cancelled: false, reason: 'not in queue' });

    expect(spawnOrder).toEqual(['running', 'queued']);
    scripts.get('queued')!.complete({ status: 'completed', exitCode: 0, signal: null, durationMs: 1 });
  });
});
