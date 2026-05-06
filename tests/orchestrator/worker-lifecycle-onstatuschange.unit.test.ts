import { describe, expect, it, vi } from 'vitest';
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
 * Phase 3H.3 — `onWorkerStatusChange` lifecycle hook tests.
 *
 * Reuses the ScriptedWorker pattern from worker-lifecycle-queue.unit.test.ts
 * to drive a worker through spawn → exit and assert the hook fires
 * AFTER `markCompleted` AND AFTER `release()` (so totalRunning reflects
 * post-decrement reality).
 */

class ScriptedWorker implements Worker {
  readonly id: string;
  sessionId: string | undefined = undefined;
  status: 'spawning' | 'running' | 'completed' | 'failed' | 'killed' | 'timeout' | 'crashed' =
    'running';
  private resolveExit: ((info: WorkerExitInfo) => void) | null = null;
  private readonly exitPromise: Promise<WorkerExitInfo>;

  constructor(id: string) {
    this.id = id;
    this.exitPromise = new Promise<WorkerExitInfo>((resolve) => {
      this.resolveExit = resolve;
    });
  }

  get events(): AsyncIterable<StreamEvent> {
    return (async function* () {
      // Empty — the lifecycle's tap handles that without complaint.
    })();
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

function stubWorkerManager(): { mgr: WorkerManager; scripts: Map<string, ScriptedWorker> } {
  const scripts = new Map<string, ScriptedWorker>();
  const mgr = {
    spawn: async (cfg: WorkerConfig): Promise<Worker> => {
      const w = new ScriptedWorker(cfg.id);
      scripts.set(cfg.id, w);
      return w;
    },
    list: () => [],
    get: () => undefined,
    shutdown: async () => {},
  } as unknown as WorkerManager;
  return { mgr, scripts };
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

describe('createWorkerLifecycle — onWorkerStatusChange (3H.3)', () => {
  it('fires the hook AFTER markCompleted with the terminal-status record', async () => {
    const registry = new WorkerRegistry();
    const { mgr, scripts } = stubWorkerManager();
    const onChange = vi.fn();
    const lc = createWorkerLifecycle({
      registry,
      workerManager: mgr,
      worktreeManager: stubWorktreeManager(),
      onWorkerStatusChange: onChange,
    });
    await lc.spawn({
      id: 'w1',
      projectPath: '/proj',
      taskDescription: 'foo',
      role: 'implementer',
    });
    expect(onChange).not.toHaveBeenCalled();
    scripts.get('w1')!.complete({
      status: 'failed',
      exitCode: 1,
      signal: null,
      durationMs: 100,
    });
    // Allow the wireExit `.then` chain + the callback fire to settle.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(onChange).toHaveBeenCalledTimes(1);
    const [record, totalRunning] = onChange.mock.calls[0]!;
    expect(record.id).toBe('w1');
    expect(record.status).toBe('failed');
    expect(totalRunning).toBe(0);
  });

  it('totalRunning reflects post-decrement state across multiple workers', async () => {
    const registry = new WorkerRegistry();
    const { mgr, scripts } = stubWorkerManager();
    const onChange = vi.fn();
    const lc = createWorkerLifecycle({
      registry,
      workerManager: mgr,
      worktreeManager: stubWorktreeManager(),
      onWorkerStatusChange: onChange,
    });
    await lc.spawn({
      id: 'w1',
      projectPath: '/proj',
      taskDescription: 't1',
      role: 'implementer',
    });
    await lc.spawn({
      id: 'w2',
      projectPath: '/proj',
      taskDescription: 't2',
      role: 'implementer',
    });
    await lc.spawn({
      id: 'w3',
      projectPath: '/proj',
      taskDescription: 't3',
      role: 'implementer',
    });
    expect(lc.getTotalRunning()).toBe(3);
    scripts.get('w1')!.complete({
      status: 'completed',
      exitCode: 0,
      signal: null,
      durationMs: 1,
    });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0]![1]).toBe(2);
    scripts.get('w2')!.complete({
      status: 'completed',
      exitCode: 0,
      signal: null,
      durationMs: 1,
    });
    scripts.get('w3')!.complete({
      status: 'failed',
      exitCode: 1,
      signal: null,
      durationMs: 1,
    });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(onChange).toHaveBeenCalledTimes(3);
    // The last call (w3) must see totalRunning === 0 (all-done condition).
    const lastCall = onChange.mock.calls[onChange.mock.calls.length - 1]!;
    expect(lastCall[1]).toBe(0);
  });

  it('hook is NOT fired when the resume race rejects the stale exit (identity check)', async () => {
    // The wireExit's pre-existing identity check (current.worker !== worker)
    // returns BEFORE the hook fires. We can't easily simulate that without
    // a real resume, but we can at least assert the hook respects it: when
    // the registry's record has been replaced, the OLD worker's exit
    // should not trigger the hook for the NEW worker.
    //
    // Approach: drop the registry entry between exit and the wireExit
    // microtask drain — the identity check returns undefined and the hook
    // skips.
    const registry = new WorkerRegistry();
    const { mgr, scripts } = stubWorkerManager();
    const onChange = vi.fn();
    const lc = createWorkerLifecycle({
      registry,
      workerManager: mgr,
      worktreeManager: stubWorktreeManager(),
      onWorkerStatusChange: onChange,
    });
    await lc.spawn({
      id: 'w1',
      projectPath: '/proj',
      taskDescription: 't',
      role: 'implementer',
    });
    // Remove the record, then complete. The wireExit will see
    // current === undefined and bail without firing.
    registry.remove('w1');
    scripts.get('w1')!.complete({
      status: 'completed',
      exitCode: 0,
      signal: null,
      durationMs: 1,
    });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('a throwing hook does not poison the lifecycle — counter still decrements', async () => {
    const registry = new WorkerRegistry();
    const { mgr, scripts } = stubWorkerManager();
    const lc = createWorkerLifecycle({
      registry,
      workerManager: mgr,
      worktreeManager: stubWorktreeManager(),
      onWorkerStatusChange: () => {
        throw new Error('consumer broken');
      },
    });
    await lc.spawn({
      id: 'w1',
      projectPath: '/proj',
      taskDescription: 't',
      role: 'implementer',
    });
    expect(lc.getTotalRunning()).toBe(1);
    scripts.get('w1')!.complete({
      status: 'failed',
      exitCode: 1,
      signal: null,
      durationMs: 1,
    });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    // Counter decremented even though the hook threw.
    expect(lc.getTotalRunning()).toBe(0);
  });
});
