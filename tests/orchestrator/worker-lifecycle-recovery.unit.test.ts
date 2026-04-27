import { describe, expect, it } from 'vitest';
import { createWorkerLifecycle } from '../../src/orchestrator/worker-lifecycle.js';
import { WorkerRegistry } from '../../src/orchestrator/worker-registry.js';
import type { WorkerManager } from '../../src/workers/manager.js';
import type {
  PersistedWorkerRecord,
  WorkerStore,
  WorkerStoreUpdatePatch,
} from '../../src/state/sqlite-worker-store.js';
import type {
  StreamEvent,
  Worker,
  WorkerConfig,
  WorkerExitInfo,
  WorkerStatus,
} from '../../src/workers/types.js';
import type { WorktreeManager } from '../../src/worktree/manager.js';

class ScriptedWorker implements Worker {
  readonly id: string;
  sessionId: string | undefined = undefined;
  status: WorkerStatus = 'running';
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

function stubWorkerManager(workers: ScriptedWorker[]): WorkerManager {
  let i = 0;
  return {
    spawn: async (cfg: WorkerConfig) => {
      void cfg;
      const w = workers[i];
      i += 1;
      if (!w) throw new Error('stubWorkerManager: no queued worker');
      return w;
    },
    list: () => [],
    get: () => undefined,
    shutdown: async () => {},
  } as unknown as WorkerManager;
}

function stubWorktreeManager(): WorktreeManager {
  return {
    create: async (opts: { workerId: string; projectPath: string }) =>
      ({
        id: opts.workerId,
        path: `/wt/${opts.workerId}`,
        branch: `symphony/${opts.workerId}`,
        baseRef: 'refs/heads/main',
        projectPath: opts.projectPath,
        createdAt: '2026-04-25T00:00:00.000Z',
      }),
    list: async () => [],
    remove: async () => {},
    removeIfClean: async () => true,
    status: async () => ({ hasChanges: false, staged: [], unstaged: [], untracked: [] }),
  } as unknown as WorktreeManager;
}

interface FakeStoreState {
  rows: Map<string, PersistedWorkerRecord>;
}

function makeFakeStore(initial: PersistedWorkerRecord[] = []): {
  store: WorkerStore;
  state: FakeStoreState;
} {
  const rows = new Map<string, PersistedWorkerRecord>();
  for (const r of initial) rows.set(r.id, r);
  const store: WorkerStore = {
    insert(record) {
      rows.set(record.id, record);
    },
    update(id, patch: WorkerStoreUpdatePatch) {
      const existing = rows.get(id);
      if (!existing) return;
      const merged: { -readonly [K in keyof PersistedWorkerRecord]: PersistedWorkerRecord[K] } = {
        ...existing,
      };
      if (patch.status !== undefined) merged.status = patch.status;
      if (patch.sessionId !== undefined) {
        if (patch.sessionId === null) delete (merged as { sessionId?: string }).sessionId;
        else merged.sessionId = patch.sessionId;
      }
      if (patch.completedAt !== undefined) {
        if (patch.completedAt === null) delete (merged as { completedAt?: string }).completedAt;
        else merged.completedAt = patch.completedAt;
      }
      if (patch.lastEventAt !== undefined) {
        if (patch.lastEventAt === null) delete (merged as { lastEventAt?: string }).lastEventAt;
        else merged.lastEventAt = patch.lastEventAt;
      }
      if (patch.exitCode !== undefined) {
        if (patch.exitCode === null) delete (merged as { exitCode?: number | null }).exitCode;
        else merged.exitCode = patch.exitCode;
      }
      if (patch.exitSignal !== undefined) {
        if (patch.exitSignal === null) delete (merged as { exitSignal?: NodeJS.Signals }).exitSignal;
        else merged.exitSignal = patch.exitSignal;
      }
      rows.set(id, merged);
    },
    delete(id) {
      rows.delete(id);
    },
    get(id) {
      return rows.get(id);
    },
    list(filter) {
      let out = Array.from(rows.values());
      if (filter?.projectId !== undefined) {
        out = out.filter((r) => r.projectId === filter.projectId);
      }
      if (filter?.status !== undefined) {
        const set = Array.isArray(filter.status)
          ? new Set(filter.status)
          : new Set([filter.status]);
        out = out.filter((r) => set.has(r.status));
      }
      return out;
    },
    size() {
      return rows.size;
    },
  };
  return { store, state: { rows } };
}

function persistedRow(
  id: string,
  status: WorkerStatus,
  overrides: Partial<PersistedWorkerRecord> = {},
): PersistedWorkerRecord {
  return {
    id,
    projectId: 'p1',
    taskId: null,
    worktreePath: `/wt/${id}`,
    role: 'implementer',
    featureIntent: 'do',
    taskDescription: 'do thing',
    autonomyTier: 1,
    dependsOn: [],
    status,
    createdAt: '2026-04-25T00:00:00.000Z',
    ...overrides,
  };
}

describe('createWorkerLifecycle.recoverFromStore', () => {
  it('flips spawning + running rows to crashed; leaves terminal rows alone', () => {
    const { store } = makeFakeStore([
      persistedRow('wk-spawning', 'spawning'),
      persistedRow('wk-running', 'running', { sessionId: 'sess-r' }),
      persistedRow('wk-completed', 'completed', { completedAt: 'old' }),
      persistedRow('wk-failed', 'failed', { completedAt: 'old' }),
      persistedRow('wk-killed', 'killed', { completedAt: 'old' }),
      persistedRow('wk-crashed', 'crashed', { completedAt: 'old' }),
    ]);
    const registry = new WorkerRegistry({ store });
    const lc = createWorkerLifecycle({
      registry,
      workerManager: stubWorkerManager([]),
      worktreeManager: stubWorktreeManager(),
    });
    const result = lc.recoverFromStore();
    expect([...result.crashedIds].sort()).toEqual(['wk-running', 'wk-spawning']);
    expect(store.get('wk-spawning')?.status).toBe('crashed');
    expect(store.get('wk-running')?.status).toBe('crashed');
    expect(store.get('wk-running')?.sessionId).toBe('sess-r'); // session preserved for resume
    expect(store.get('wk-completed')?.status).toBe('completed');
    expect(store.get('wk-failed')?.status).toBe('failed');
    expect(store.get('wk-killed')?.status).toBe('killed');
    expect(store.get('wk-crashed')?.status).toBe('crashed'); // already crashed → unchanged
    expect(store.get('wk-completed')?.completedAt).toBe('old'); // not re-stamped
  });

  it('stamps completedAt on newly-crashed rows', () => {
    const { store } = makeFakeStore([persistedRow('wk-running', 'running')]);
    const registry = new WorkerRegistry({ store });
    const lc = createWorkerLifecycle({
      registry,
      workerManager: stubWorkerManager([]),
      worktreeManager: stubWorktreeManager(),
      now: () => 1_700_000_000_000,
    });
    lc.recoverFromStore();
    const row = store.get('wk-running');
    expect(row?.status).toBe('crashed');
    expect(row?.completedAt).toBe(new Date(1_700_000_000_000).toISOString());
  });

  it('returns empty report when no store is configured', () => {
    const registry = new WorkerRegistry();
    const lc = createWorkerLifecycle({
      registry,
      workerManager: stubWorkerManager([]),
      worktreeManager: stubWorktreeManager(),
    });
    expect(lc.recoverFromStore()).toEqual({ crashedIds: [] });
  });

  it('idempotent: a second call after recovery is a no-op', () => {
    const { store } = makeFakeStore([persistedRow('wk-running', 'running')]);
    const registry = new WorkerRegistry({ store });
    const lc = createWorkerLifecycle({
      registry,
      workerManager: stubWorkerManager([]),
      worktreeManager: stubWorktreeManager(),
    });
    lc.recoverFromStore();
    expect(store.get('wk-running')?.status).toBe('crashed');
    const second = lc.recoverFromStore();
    expect(second.crashedIds).toEqual([]);
  });
});

describe('createWorkerLifecycle.shutdown — markCompleted runs before clear', () => {
  it('clean shutdown stamps status="killed" via wireExit (not "running")', async () => {
    const w = new ScriptedWorker('wk-sh');
    const wm = stubWorkerManager([w]);
    const wt = stubWorktreeManager();
    const { store } = makeFakeStore();
    const registry = new WorkerRegistry({ store });
    const lc = createWorkerLifecycle({
      registry,
      workerManager: wm,
      worktreeManager: wt,
      idGenerator: () => 'wk-sh',
    });
    await lc.spawn({
      projectPath: '/proj',
      projectId: 'p1',
      taskDescription: 'go',
      role: 'implementer',
    });
    // Persisted row exists at status='spawning' after register.
    expect(store.get('wk-sh')?.status).toBe('spawning');

    // Shutdown should kill, await exit (firing wireExit's markCompleted),
    // then clear. Persisted row should reflect the terminal status.
    await lc.shutdown();
    const row = store.get('wk-sh');
    expect(row?.status).toBe('killed');
    expect(row?.completedAt).toBeDefined();
  });
});
