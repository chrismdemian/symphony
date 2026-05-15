import { describe, expect, it } from 'vitest';
import { createWorkerLifecycle } from '../../src/orchestrator/worker-lifecycle.js';
import { WorkerRegistry } from '../../src/orchestrator/worker-registry.js';
import type { WorkerManager } from '../../src/workers/manager.js';
import type {
  KillSignal,
  StopIntent,
  StreamEvent,
  Worker,
  WorkerConfig,
  WorkerExitInfo,
} from '../../src/workers/types.js';
import type { WorktreeManager } from '../../src/worktree/manager.js';
import type { CreateWorktreeOptions, WorktreeInfo } from '../../src/worktree/types.js';

/**
 * Phase 3T — batch primitives on WorkerLifecycleHandle:
 *   - killAllRunning(): SIGTERM every non-terminal worker with
 *     intent='interrupt' so classifyExit lands them at 'interrupted'.
 *   - cancelAllQueued(): reject every pending queued spawn with
 *     QueueCancelledError; composed from listPendingGlobal + cancelQueued.
 */

class ScriptedWorker implements Worker {
  readonly id: string;
  sessionId: string | undefined = undefined;
  status: 'spawning' | 'running' | 'completed' | 'failed' | 'killed' | 'timeout' | 'crashed' | 'interrupted' =
    'running';
  killCalls: Array<{ signal: KillSignal | undefined; intent: StopIntent | undefined }> = [];
  private resolveExit: ((info: WorkerExitInfo) => void) | null = null;
  private readonly exitPromise: Promise<WorkerExitInfo>;

  constructor(id: string) {
    this.id = id;
    this.exitPromise = new Promise<WorkerExitInfo>((resolve) => {
      this.resolveExit = resolve;
    });
  }

  get events(): AsyncIterable<StreamEvent> {
    return (async function* () {})();
  }
  sendFollowup(): void {}
  endInput(): void {}
  kill(signal?: KillSignal, intent?: StopIntent): void {
    this.killCalls.push({ signal, intent });
    this.status = intent === 'interrupt' ? 'interrupted' : 'killed';
    this.resolveExit?.({
      status: this.status,
      exitCode: null,
      signal: signal ?? null,
      durationMs: 0,
    });
  }
  waitForExit(): Promise<WorkerExitInfo> {
    return this.exitPromise;
  }
}

function makeManager(
  spawnImpl: (cfg: WorkerConfig) => Promise<Worker>,
): WorkerManager {
  return {
    spawn: spawnImpl,
    shutdown: async () => {},
  } as unknown as WorkerManager;
}

function makeWorktreeManager(): WorktreeManager {
  return {
    create: async (opts: CreateWorktreeOptions): Promise<WorktreeInfo> => ({
      id: opts.workerId ?? 'fake',
      path: `/tmp/wt-${opts.workerId ?? 'fake'}`,
      branch: `symphony/${opts.workerId ?? 'fake'}/main`,
      baseRef: 'HEAD',
      projectPath: opts.projectPath,
      createdAt: '2026-04-23T00:00:00.000Z',
    }),
    removeIfClean: async () => true,
  } as unknown as WorktreeManager;
}

describe('WorkerLifecycle — 3T batch primitives', () => {
  it('killAllRunning calls worker.kill("SIGTERM", "interrupt") on every non-terminal worker', async () => {
    const workersBySpawn: ScriptedWorker[] = [];
    const manager = makeManager(async (cfg) => {
      const w = new ScriptedWorker(cfg.id);
      workersBySpawn.push(w);
      return w;
    });
    const registry = new WorkerRegistry();
    const lifecycle = createWorkerLifecycle({
      workerManager: manager,
      worktreeManager: makeWorktreeManager(),
      registry,
    });

    await lifecycle.spawn({
      projectPath: '/tmp/p1',
      projectId: 'p1',
      taskDescription: 'task A',
      role: 'implementer',
      id: 'w-a',
    });
    await lifecycle.spawn({
      projectPath: '/tmp/p1',
      projectId: 'p1',
      taskDescription: 'task B',
      role: 'implementer',
      id: 'w-b',
    });

    const result = lifecycle.killAllRunning();
    expect([...result.killedIds].sort()).toEqual(['w-a', 'w-b'].sort());
    expect(workersBySpawn).toHaveLength(2);
    for (const w of workersBySpawn) {
      expect(w.killCalls).toEqual([{ signal: 'SIGTERM', intent: 'interrupt' }]);
    }
  });

  it('killAllRunning skips already-terminal workers (idempotent)', async () => {
    const workersBySpawn: ScriptedWorker[] = [];
    const manager = makeManager(async (cfg) => {
      const w = new ScriptedWorker(cfg.id);
      workersBySpawn.push(w);
      return w;
    });
    const registry = new WorkerRegistry();
    const lifecycle = createWorkerLifecycle({
      workerManager: manager,
      worktreeManager: makeWorktreeManager(),
      registry,
    });

    await lifecycle.spawn({
      projectPath: '/tmp/p1',
      projectId: 'p1',
      taskDescription: 'task A',
      role: 'implementer',
      id: 'w-a',
    });

    const first = lifecycle.killAllRunning();
    expect(first.killedIds).toEqual(['w-a']);

    // Manually mark the registry entry terminal (mirror what wireExit
    // does after a real exit). Then killAllRunning should be a no-op.
    registry.markCompleted('w-a', { status: 'interrupted', exitCode: null, signal: null, durationMs: 0 });
    const second = lifecycle.killAllRunning();
    expect(second.killedIds).toEqual([]);
  });

  it('cancelAllQueued rejects every pending queued spawn with QueueCancelledError', async () => {
    // Force every spawn to queue by setting the cap to 1, then enqueueing 3.
    const workersBySpawn: ScriptedWorker[] = [];
    const manager = makeManager(async (cfg) => {
      const w = new ScriptedWorker(cfg.id);
      workersBySpawn.push(w);
      return w;
    });
    const registry = new WorkerRegistry();
    const lifecycle = createWorkerLifecycle({
      workerManager: manager,
      worktreeManager: makeWorktreeManager(),
      registry,
      getMaxConcurrentWorkers: () => 1,
    });

    // First spawn gets a slot immediately, second and third are queued.
    const first = lifecycle.spawn({
      projectPath: '/tmp/p1',
      projectId: 'p1',
      taskDescription: 'A',
      role: 'implementer',
      id: 'w-a',
    });
    const second = lifecycle.spawn({
      projectPath: '/tmp/p1',
      projectId: 'p1',
      taskDescription: 'B',
      role: 'implementer',
      id: 'w-b',
    });
    const third = lifecycle.spawn({
      projectPath: '/tmp/p1',
      projectId: 'p1',
      taskDescription: 'C',
      role: 'implementer',
      id: 'w-c',
    });

    await first;
    // second + third should be pending now.
    expect(lifecycle.listPendingGlobal().map((p) => p.recordId).sort()).toEqual(
      ['w-b', 'w-c'].sort(),
    );

    const result = lifecycle.cancelAllQueued();
    expect([...result.cancelledIds].sort()).toEqual(['w-b', 'w-c'].sort());

    // The pending promises now reject.
    await expect(second).rejects.toThrow(/queued/i);
    await expect(third).rejects.toThrow(/queued/i);

    // Idempotent: a second call returns empty.
    const again = lifecycle.cancelAllQueued();
    expect(again.cancelledIds).toEqual([]);
  });
});
