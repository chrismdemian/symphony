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
 * Phase 7B.3 — `onWorkerSpawned` lifecycle hook tests.
 *
 * Reuses the ScriptedWorker stub from worker-lifecycle-onstatuschange to
 * drive a worker through spawn and assert the hook fires ONCE, synchronously
 * after `registry.register`, BEFORE any exit, with the `'spawning'` record.
 */

class ScriptedWorker implements Worker {
  readonly id: string;
  sessionId: string | undefined = undefined;
  status: 'spawning' | 'running' | 'completed' | 'failed' | 'killed' | 'timeout' | 'crashed' | 'interrupted' =
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
    return (async function* () {})();
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
      createdAt: '2026-06-03T00:00:00.000Z',
    }),
    list: async () => [],
    remove: async () => {},
    removeIfClean: async () => true,
    status: async () => ({ hasChanges: false, staged: [], unstaged: [], untracked: [] }),
  } as unknown as WorktreeManager;
}

describe('createWorkerLifecycle — onWorkerSpawned (7B.3)', () => {
  it('fires once on spawn with the spawning record, before any exit', async () => {
    const registry = new WorkerRegistry();
    const { mgr } = stubWorkerManager();
    const onSpawned = vi.fn();
    const lc = createWorkerLifecycle({
      registry,
      workerManager: mgr,
      worktreeManager: stubWorktreeManager(),
      onWorkerSpawned: onSpawned,
    });
    await lc.spawn({
      id: 'w1',
      projectPath: '/proj',
      taskDescription: 'foo',
      role: 'researcher',
    });
    expect(onSpawned).toHaveBeenCalledTimes(1);
    const [record] = onSpawned.mock.calls[0]!;
    expect(record.id).toBe('w1');
    expect(record.role).toBe('researcher');
    expect(record.status).toBe('spawning');
    expect(record.projectId).toBeNull();
    expect(record.taskId).toBeNull();
    expect(typeof record.featureIntent).toBe('string');
  });

  it('fires per spawn (once each across multiple workers)', async () => {
    const registry = new WorkerRegistry();
    const { mgr } = stubWorkerManager();
    const onSpawned = vi.fn();
    const lc = createWorkerLifecycle({
      registry,
      workerManager: mgr,
      worktreeManager: stubWorktreeManager(),
      onWorkerSpawned: onSpawned,
    });
    await lc.spawn({ id: 'w1', projectPath: '/proj', taskDescription: 't1', role: 'implementer' });
    await lc.spawn({ id: 'w2', projectPath: '/proj', taskDescription: 't2', role: 'implementer' });
    expect(onSpawned).toHaveBeenCalledTimes(2);
    expect(onSpawned.mock.calls.map((c) => c[0].id)).toEqual(['w1', 'w2']);
  });

  it('does NOT fire on resume (spawn-only hook)', async () => {
    const registry = new WorkerRegistry();
    const { mgr } = stubWorkerManager();
    const onSpawned = vi.fn();
    const lc = createWorkerLifecycle({
      registry,
      workerManager: mgr,
      worktreeManager: stubWorktreeManager(),
      idGenerator: () => 'wk-r',
      onWorkerSpawned: onSpawned,
    });
    const rec = await lc.spawn({ projectPath: '/proj', taskDescription: 'do', role: 'implementer' });
    expect(onSpawned).toHaveBeenCalledTimes(1);
    // Flip to terminal + give it a session so resume is allowed.
    rec.status = 'completed';
    rec.sessionId = 'sess-old';
    await lc.resume({ recordId: 'wk-r', message: 'continue' });
    // Resume re-attaches an existing worker — the spawn hook must NOT re-fire.
    expect(onSpawned).toHaveBeenCalledTimes(1);
  });

  it('a throwing hook does not poison the spawn', async () => {
    const registry = new WorkerRegistry();
    const { mgr } = stubWorkerManager();
    const lc = createWorkerLifecycle({
      registry,
      workerManager: mgr,
      worktreeManager: stubWorktreeManager(),
      onWorkerSpawned: () => {
        throw new Error('consumer broken');
      },
    });
    const rec = await lc.spawn({
      id: 'w1',
      projectPath: '/proj',
      taskDescription: 't',
      role: 'implementer',
    });
    expect(rec.id).toBe('w1');
    expect(registry.get('w1')).toBeDefined();
    expect(lc.getTotalRunning()).toBe(1);
  });
});
