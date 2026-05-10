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
 * Phase 3L — global pending list, cancel, and reorder on the
 * lifecycle handle. Mirrors the queue-cap harness from `3H.2`.
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

function queuedWorkerManager(): {
  mgr: WorkerManager;
  scripts: Map<string, ScriptedWorker>;
  spawnCalls: WorkerConfig[];
} {
  const spawnCalls: WorkerConfig[] = [];
  const scripts = new Map<string, ScriptedWorker>();
  const mgr = {
    spawn: async (cfg: WorkerConfig): Promise<Worker> => {
      spawnCalls.push(cfg);
      const w = new ScriptedWorker(cfg.id, emitEvents([]));
      scripts.set(cfg.id, w);
      return w;
    },
    list: () => [],
    get: () => undefined,
    shutdown: async () => {},
  } as unknown as WorkerManager;
  return { mgr, scripts, spawnCalls };
}

function stubWorktreeManager(): WorktreeManager {
  return {
    create: async (opts: CreateWorktreeOptions): Promise<WorktreeInfo> => ({
      id: opts.workerId,
      path: `/wt/${opts.workerId}`,
      branch: `symphony/${opts.workerId}`,
      baseRef: 'refs/heads/main',
      projectPath: opts.projectPath,
      createdAt: '2026-05-10T00:00:00.000Z',
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

/** Build a cap=1 lifecycle with a deterministic monotonic clock and prefilled queue. */
async function setup(): Promise<{
  lc: ReturnType<typeof createWorkerLifecycle>;
  wm: ReturnType<typeof queuedWorkerManager>;
  tick: () => number;
}> {
  const registry = new WorkerRegistry();
  const wm = queuedWorkerManager();
  let t = 1000;
  const tick = (): number => {
    t += 1;
    return t;
  };
  const lc = createWorkerLifecycle({
    registry,
    workerManager: wm.mgr,
    worktreeManager: stubWorktreeManager(),
    getMaxConcurrentWorkers: () => 1,
    now: tick,
  });
  return { lc, wm, tick };
}

describe('listPendingGlobal (3L)', () => {
  it('returns empty when nothing is queued', async () => {
    const { lc } = await setup();
    expect(lc.listPendingGlobal()).toEqual([]);
  });

  it('returns flat list sorted by enqueuedAt ascending across projects', async () => {
    const { lc, wm } = await setup();
    const settle = async (): Promise<void> => {
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
    };
    // First spawn fills cap on /projA; others queue.
    const p1 = lc.spawn({
      id: 'a1',
      projectPath: '/projA',
      taskDescription: 'A1 task',
      featureIntent: 'a1-intent',
      role: 'implementer',
    });
    await settle();
    const p2 = lc.spawn({
      id: 'b1',
      projectPath: '/projB',
      taskDescription: 'B1 task',
      featureIntent: 'b1-intent',
      role: 'implementer',
    });
    await settle();
    const p3 = lc.spawn({
      id: 'a2',
      projectPath: '/projA',
      taskDescription: 'A2 task',
      featureIntent: 'a2-intent',
      role: 'implementer',
    });
    await settle();
    const p4 = lc.spawn({
      id: 'b2',
      projectPath: '/projB',
      taskDescription: 'B2 task',
      featureIntent: 'b2-intent',
      role: 'implementer',
    });
    await settle();

    // a1 + b1 are running (different projects, cap=1 each). a2 + b2 queued.
    const flat = lc.listPendingGlobal();
    expect(flat.map((p) => p.recordId)).toEqual(['a2', 'b2']);
    expect(flat[0]!.projectPath).toBe('/projA');
    expect(flat[0]!.featureIntent).toBe('a2-intent');
    expect(flat[0]!.taskDescription).toBe('A2 task');
    expect(flat[0]!.enqueuedAt).toBeLessThan(flat[1]!.enqueuedAt);

    // Drain to keep test fixtures clean.
    wm.scripts.get('a1')!.complete({ status: 'completed', exitCode: 0, signal: null, durationMs: 1 });
    wm.scripts.get('b1')!.complete({ status: 'completed', exitCode: 0, signal: null, durationMs: 1 });
    await Promise.all([p1, p2, p3, p4]);
    wm.scripts.get('a2')!.complete({ status: 'completed', exitCode: 0, signal: null, durationMs: 1 });
    wm.scripts.get('b2')!.complete({ status: 'completed', exitCode: 0, signal: null, durationMs: 1 });
  });

  it('derives featureIntent from taskDescription when caller omits it', async () => {
    const { lc, wm } = await setup();
    const p1 = lc.spawn({
      id: 'w1',
      projectPath: '/p',
      taskDescription: 'first',
      role: 'implementer',
    });
    await new Promise((r) => setImmediate(r));
    const p2 = lc.spawn({
      id: 'w2',
      projectPath: '/p',
      taskDescription: 'Add search filters for the catalog page',
      role: 'implementer',
    });
    await new Promise((r) => setImmediate(r));
    const flat = lc.listPendingGlobal();
    expect(flat.length).toBe(1);
    expect(flat[0]!.recordId).toBe('w2');
    // deriveFeatureIntent returns a non-empty short string from the
    // task description; exact algorithm not asserted, just non-empty.
    expect(flat[0]!.featureIntent.length).toBeGreaterThan(0);
    wm.scripts.get('w1')!.complete({ status: 'completed', exitCode: 0, signal: null, durationMs: 1 });
    await Promise.all([p1, p2]);
    wm.scripts.get('w2')!.complete({ status: 'completed', exitCode: 0, signal: null, durationMs: 1 });
  });
});

describe('cancelQueued (3L)', () => {
  it('removes the entry and rejects the caller spawn promise with QueueCancelledError', async () => {
    const { lc, wm } = await setup();
    const p1 = lc.spawn({
      id: 'running',
      projectPath: '/p',
      taskDescription: 'running',
      role: 'implementer',
    });
    await new Promise((r) => setImmediate(r));
    const p2 = lc.spawn({
      id: 'queued',
      projectPath: '/p',
      taskDescription: 'queued',
      role: 'implementer',
    });
    await new Promise((r) => setImmediate(r));
    expect(lc.listPendingGlobal().map((p) => p.recordId)).toEqual(['queued']);
    const result = lc.cancelQueued('queued');
    expect(result).toEqual({ cancelled: true });
    expect(lc.listPendingGlobal()).toEqual([]);
    await expect(p2).rejects.toBeInstanceOf(QueueCancelledError);
    await expect(p2).rejects.toMatchObject({ code: 'queue-cancelled', recordId: 'queued' });
    // Running worker survives — only the queued one was cancelled.
    wm.scripts.get('running')!.complete({ status: 'completed', exitCode: 0, signal: null, durationMs: 1 });
    await p1;
  });

  it('returns {cancelled:false, reason:"not in queue"} for unknown recordId', async () => {
    const { lc } = await setup();
    expect(lc.cancelQueued('nonexistent')).toEqual({
      cancelled: false,
      reason: 'not in queue',
    });
  });

  it('lets the next queued entry drain after a cancel — running cap unaffected', async () => {
    const { lc, wm } = await setup();
    const p1 = lc.spawn({
      id: 'w1',
      projectPath: '/p',
      taskDescription: 'first',
      role: 'implementer',
    });
    await new Promise((r) => setImmediate(r));
    const p2 = lc.spawn({
      id: 'w2',
      projectPath: '/p',
      taskDescription: 'second (will be cancelled)',
      role: 'implementer',
    });
    await new Promise((r) => setImmediate(r));
    const p3 = lc.spawn({
      id: 'w3',
      projectPath: '/p',
      taskDescription: 'third',
      role: 'implementer',
    });
    await new Promise((r) => setImmediate(r));
    expect(lc.listPendingGlobal().map((p) => p.recordId)).toEqual(['w2', 'w3']);
    // Cancel w2 — w3 remains queued behind w1.
    lc.cancelQueued('w2');
    await expect(p2).rejects.toBeInstanceOf(QueueCancelledError);
    expect(lc.listPendingGlobal().map((p) => p.recordId)).toEqual(['w3']);
    // Exit w1 → drain → w3 spawns.
    wm.scripts.get('w1')!.complete({ status: 'completed', exitCode: 0, signal: null, durationMs: 1 });
    const r3 = await p3;
    expect(r3.id).toBe('w3');
    await p1;
    wm.scripts.get('w3')!.complete({ status: 'completed', exitCode: 0, signal: null, durationMs: 1 });
  });

  it('cleans up the per-project bucket when the cancelled entry was the last one', async () => {
    const { lc, wm } = await setup();
    const p1 = lc.spawn({
      id: 'r1',
      projectPath: '/proj',
      taskDescription: 'running',
      role: 'implementer',
    });
    await new Promise((r) => setImmediate(r));
    const p2 = lc.spawn({
      id: 'only-queued',
      projectPath: '/proj',
      taskDescription: 'only queued',
      role: 'implementer',
    });
    await new Promise((r) => setImmediate(r));
    lc.cancelQueued('only-queued');
    await expect(p2).rejects.toBeInstanceOf(QueueCancelledError);
    // getQueueSnapshot reads pendingPerProject directly; an empty bucket
    // means the entry was actually removed (not left as a stale empty
    // array).
    expect(lc.getQueueSnapshot('/proj').pending.length).toBe(0);
    wm.scripts.get('r1')!.complete({ status: 'completed', exitCode: 0, signal: null, durationMs: 1 });
    await p1;
  });
});

describe('reorderQueued (3L)', () => {
  it('swaps adjacent same-project entries up and swaps their enqueuedAt values', async () => {
    const { lc, wm } = await setup();
    const p1 = lc.spawn({
      id: 'running',
      projectPath: '/p',
      taskDescription: 'running',
      role: 'implementer',
    });
    await new Promise((r) => setImmediate(r));
    const p2 = lc.spawn({
      id: 'q1',
      projectPath: '/p',
      taskDescription: 'q1',
      role: 'implementer',
    });
    await new Promise((r) => setImmediate(r));
    const p3 = lc.spawn({
      id: 'q2',
      projectPath: '/p',
      taskDescription: 'q2',
      role: 'implementer',
    });
    await new Promise((r) => setImmediate(r));
    const before = lc.listPendingGlobal();
    expect(before.map((p) => p.recordId)).toEqual(['q1', 'q2']);
    const beforeQ1At = before[0]!.enqueuedAt;
    const beforeQ2At = before[1]!.enqueuedAt;

    const result = lc.reorderQueued('q2', 'up');
    expect(result).toEqual({ moved: true });

    const after = lc.listPendingGlobal();
    expect(after.map((p) => p.recordId)).toEqual(['q2', 'q1']);
    expect(after[0]!.enqueuedAt).toBe(beforeQ1At);
    expect(after[1]!.enqueuedAt).toBe(beforeQ2At);

    wm.scripts.get('running')!.complete({ status: 'completed', exitCode: 0, signal: null, durationMs: 1 });
    await p1;
    // After swap, q2 is at the head — it should spawn first.
    const r2 = await p3;
    expect(r2.id).toBe('q2');
    wm.scripts.get('q2')!.complete({ status: 'completed', exitCode: 0, signal: null, durationMs: 1 });
    const r1 = await p2;
    expect(r1.id).toBe('q1');
    wm.scripts.get('q1')!.complete({ status: 'completed', exitCode: 0, signal: null, durationMs: 1 });
  });

  it('swaps down: q1 (head) → after, q2 (tail) → head; new head drains first', async () => {
    const { lc, wm } = await setup();
    const pRunning = lc.spawn({
      id: 'running',
      projectPath: '/p',
      taskDescription: 'r',
      role: 'implementer',
    });
    await new Promise((r) => setImmediate(r));
    const pQ1 = lc.spawn({
      id: 'q1',
      projectPath: '/p',
      taskDescription: 'q1',
      role: 'implementer',
    });
    await new Promise((r) => setImmediate(r));
    const pQ2 = lc.spawn({
      id: 'q2',
      projectPath: '/p',
      taskDescription: 'q2',
      role: 'implementer',
    });
    await new Promise((r) => setImmediate(r));
    expect(lc.reorderQueued('q1', 'down')).toEqual({ moved: true });
    expect(lc.listPendingGlobal().map((p) => p.recordId)).toEqual(['q2', 'q1']);
    // Drain order respects the new head: complete `running` → q2
    // spawns next (pQ2 resolves) → complete q2 → q1 spawns (pQ1 resolves).
    wm.scripts.get('running')!.complete({
      status: 'completed',
      exitCode: 0,
      signal: null,
      durationMs: 1,
    });
    await pRunning;
    const r2 = await pQ2;
    expect(r2.id).toBe('q2');
    wm.scripts.get('q2')!.complete({
      status: 'completed',
      exitCode: 0,
      signal: null,
      durationMs: 1,
    });
    const r1 = await pQ1;
    expect(r1.id).toBe('q1');
    wm.scripts.get('q1')!.complete({
      status: 'completed',
      exitCode: 0,
      signal: null,
      durationMs: 1,
    });
  });

  it('returns {moved:false, reason:"no neighbor"} at project boundaries', async () => {
    const { lc, wm } = await setup();
    const p1 = lc.spawn({
      id: 'r',
      projectPath: '/p',
      taskDescription: 'r',
      role: 'implementer',
    });
    await new Promise((r) => setImmediate(r));
    const p2 = lc.spawn({
      id: 'only',
      projectPath: '/p',
      taskDescription: 'only',
      role: 'implementer',
    });
    await new Promise((r) => setImmediate(r));
    expect(lc.reorderQueued('only', 'up')).toEqual({ moved: false, reason: 'no neighbor' });
    expect(lc.reorderQueued('only', 'down')).toEqual({ moved: false, reason: 'no neighbor' });
    wm.scripts.get('r')!.complete({ status: 'completed', exitCode: 0, signal: null, durationMs: 1 });
    await Promise.all([p1, p2]);
    wm.scripts.get('only')!.complete({ status: 'completed', exitCode: 0, signal: null, durationMs: 1 });
  });

  it('returns {moved:false, reason:"not in queue"} for unknown recordId', async () => {
    const { lc } = await setup();
    expect(lc.reorderQueued('nonexistent', 'up')).toEqual({
      moved: false,
      reason: 'not in queue',
    });
  });

  it('cross-project pending: reorder is per-project (refuses with no neighbor)', async () => {
    const { lc, wm } = await setup();
    const a1 = lc.spawn({
      id: 'a1',
      projectPath: '/projA',
      taskDescription: 'A1',
      role: 'implementer',
    });
    await new Promise((r) => setImmediate(r));
    const a2 = lc.spawn({
      id: 'a2',
      projectPath: '/projA',
      taskDescription: 'A2',
      role: 'implementer',
    });
    await new Promise((r) => setImmediate(r));
    const b1 = lc.spawn({
      id: 'b1',
      projectPath: '/projB',
      taskDescription: 'B1',
      role: 'implementer',
    });
    await new Promise((r) => setImmediate(r));
    const b2 = lc.spawn({
      id: 'b2',
      projectPath: '/projB',
      taskDescription: 'B2',
      role: 'implementer',
    });
    await new Promise((r) => setImmediate(r));
    // a2 is at the head of projA's queue (1 entry: a2); b2 is at the
    // head of projB's queue (1 entry: b2). Neither has a same-project
    // neighbor to swap with.
    expect(lc.reorderQueued('a2', 'up')).toEqual({ moved: false, reason: 'no neighbor' });
    expect(lc.reorderQueued('a2', 'down')).toEqual({ moved: false, reason: 'no neighbor' });
    expect(lc.reorderQueued('b2', 'up')).toEqual({ moved: false, reason: 'no neighbor' });
    expect(lc.reorderQueued('b2', 'down')).toEqual({ moved: false, reason: 'no neighbor' });

    wm.scripts.get('a1')!.complete({ status: 'completed', exitCode: 0, signal: null, durationMs: 1 });
    wm.scripts.get('b1')!.complete({ status: 'completed', exitCode: 0, signal: null, durationMs: 1 });
    await Promise.all([a1, a2, b1, b2]);
    wm.scripts.get('a2')!.complete({ status: 'completed', exitCode: 0, signal: null, durationMs: 1 });
    wm.scripts.get('b2')!.complete({ status: 'completed', exitCode: 0, signal: null, durationMs: 1 });
  });
});

describe('PendingSpawn enqueuedAt + global merge invariants', () => {
  it('shutdown rejects pending entries (does not deadlock on the new fields)', async () => {
    const { lc, wm } = await setup();
    const p1 = lc.spawn({
      id: 'r1',
      projectPath: '/p',
      taskDescription: 'r1',
      role: 'implementer',
    });
    await new Promise((r) => setImmediate(r));
    const p2 = lc.spawn({
      id: 'q1',
      projectPath: '/p',
      taskDescription: 'q1',
      role: 'implementer',
    });
    await new Promise((r) => setImmediate(r));
    const shutdown = lc.shutdown();
    // q1's caller observes a rejection; shutdown synthesizes its own
    // Error (not QueueCancelledError — 3H.2 shape preserved).
    await expect(p2).rejects.toThrow(/spawn_worker aborted: lifecycle shutdown/);
    // Make scripted worker exit so shutdown can complete.
    wm.scripts.get('r1')!.complete({ status: 'killed', exitCode: null, signal: 'SIGTERM', durationMs: 0 });
    await p1;
    await shutdown;
  });
});
