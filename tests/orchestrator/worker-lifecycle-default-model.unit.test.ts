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
 * Phase 3H.2 — `getDefaultModel` injection at spawn time. When the
 * caller omits `input.model`, the lifecycle consults `getDefaultModel`
 * for the default. server.ts wires this from `globalModelMode`:
 * `'opus' → 'claude-opus-4-7'`; `'mixed' → undefined` (Maestro picks
 * per task explicitly).
 */

class StubWorker implements Worker {
  readonly id: string;
  sessionId: string | undefined = undefined;
  status: 'spawning' | 'running' | 'completed' | 'failed' | 'killed' | 'timeout' | 'crashed' | 'interrupted' =
    'running';
  events: AsyncIterable<StreamEvent> = (async function* () {})();
  constructor(id: string) {
    this.id = id;
  }
  sendFollowup(): void {}
  endInput(): void {}
  kill(): void {}
  waitForExit(): Promise<WorkerExitInfo> {
    return new Promise(() => {}); // never resolves; tests don't need exit
  }
}

function makeWm(): { mgr: WorkerManager; configs: WorkerConfig[] } {
  const configs: WorkerConfig[] = [];
  const mgr = {
    spawn: async (cfg: WorkerConfig): Promise<Worker> => {
      configs.push(cfg);
      return new StubWorker(cfg.id);
    },
    list: () => [],
    get: () => undefined,
    shutdown: async () => {},
  } as unknown as WorkerManager;
  return { mgr, configs };
}

function stubWt(): WorktreeManager {
  return {
    create: async (opts: CreateWorktreeOptions): Promise<WorktreeInfo> => ({
      id: opts.workerId,
      path: `/wt/${opts.workerId}`,
      branch: `b/${opts.workerId}`,
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

describe('createWorkerLifecycle — getDefaultModel injection (3H.2)', () => {
  it('caller-provided input.model wins over getDefaultModel', async () => {
    const wm = makeWm();
    const lc = createWorkerLifecycle({
      registry: new WorkerRegistry(),
      workerManager: wm.mgr,
      worktreeManager: stubWt(),
      getDefaultModel: () => 'claude-opus-4-7',
    });
    const rec = await lc.spawn({
      id: 'caller-wins',
      projectPath: '/p',
      taskDescription: 't',
      role: 'implementer',
      model: 'claude-sonnet-4-6',
    });
    expect(rec.model).toBe('claude-sonnet-4-6');
    expect(wm.configs[0]?.model).toBe('claude-sonnet-4-6');
  });

  it('falls back to getDefaultModel when input.model omitted (opus mode)', async () => {
    const wm = makeWm();
    const lc = createWorkerLifecycle({
      registry: new WorkerRegistry(),
      workerManager: wm.mgr,
      worktreeManager: stubWt(),
      getDefaultModel: () => 'claude-opus-4-7',
    });
    const rec = await lc.spawn({
      id: 'opus-default',
      projectPath: '/p',
      taskDescription: 't',
      role: 'implementer',
    });
    expect(rec.model).toBe('claude-opus-4-7');
    expect(wm.configs[0]?.model).toBe('claude-opus-4-7');
  });

  it('omits model when getDefaultModel returns undefined (mixed mode)', async () => {
    const wm = makeWm();
    const lc = createWorkerLifecycle({
      registry: new WorkerRegistry(),
      workerManager: wm.mgr,
      worktreeManager: stubWt(),
      getDefaultModel: () => undefined,
    });
    const rec = await lc.spawn({
      id: 'no-default',
      projectPath: '/p',
      taskDescription: 't',
      role: 'implementer',
    });
    expect(rec.model).toBeUndefined();
    expect(wm.configs[0]?.model).toBeUndefined();
  });

  it('omits model when getDefaultModel option is not provided', async () => {
    const wm = makeWm();
    const lc = createWorkerLifecycle({
      registry: new WorkerRegistry(),
      workerManager: wm.mgr,
      worktreeManager: stubWt(),
    });
    const rec = await lc.spawn({
      id: 'no-option',
      projectPath: '/p',
      taskDescription: 't',
      role: 'implementer',
    });
    expect(rec.model).toBeUndefined();
    expect(wm.configs[0]?.model).toBeUndefined();
  });
});
