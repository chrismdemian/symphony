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

class ScriptedWorker implements Worker {
  readonly id: string;
  sessionId: string | undefined = undefined;
  status: 'spawning' | 'running' | 'completed' | 'failed' | 'killed' | 'timeout' | 'crashed' | 'interrupted' =
    'running';
  private readonly events_: AsyncIterable<StreamEvent>;
  private resolveExit: ((info: WorkerExitInfo) => void) | null = null;
  private killed = false;
  followups: string[] = [];
  inputEnded = false;
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

  sendFollowup(text: string): void {
    this.followups.push(text);
  }

  endInput(): void {
    this.inputEnded = true;
  }

  kill(): void {
    this.killed = true;
    this.complete({
      status: 'killed',
      exitCode: null,
      signal: 'SIGTERM',
      durationMs: 0,
    });
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
  for (const ev of events) {
    yield ev;
  }
}

interface StubWorkerManager {
  mgr: WorkerManager;
  spawnCalls: WorkerConfig[];
  setNextWorker(worker: ScriptedWorker): void;
  setNextError(err: Error): void;
}

function stubWorkerManager(): StubWorkerManager {
  const spawnCalls: WorkerConfig[] = [];
  let nextWorker: ScriptedWorker | null = null;
  let nextError: Error | null = null;
  const mgr = {
    spawn: async (cfg: WorkerConfig) => {
      spawnCalls.push(cfg);
      if (nextError) {
        const err = nextError;
        nextError = null;
        throw err;
      }
      if (!nextWorker) throw new Error('stubWorkerManager: no queued worker');
      const w = nextWorker;
      nextWorker = null;
      return w;
    },
    list: () => [],
    get: () => undefined,
    shutdown: async () => {},
  } as unknown as WorkerManager;
  return {
    mgr,
    spawnCalls,
    setNextWorker: (w) => {
      nextWorker = w;
    },
    setNextError: (e) => {
      nextError = e;
    },
  };
}

function stubWorktreeManager(): {
  mgr: WorktreeManager;
  createCalls: CreateWorktreeOptions[];
} {
  const createCalls: CreateWorktreeOptions[] = [];
  const mgr = {
    create: async (opts: CreateWorktreeOptions): Promise<WorktreeInfo> => {
      createCalls.push(opts);
      return {
        id: opts.workerId,
        path: `/wt/${opts.workerId}`,
        branch: `symphony/${opts.workerId}`,
        baseRef: 'refs/heads/main',
        projectPath: opts.projectPath,
        createdAt: '2026-04-23T00:00:00.000Z',
      };
    },
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
  return { mgr, createCalls };
}

describe('createWorkerLifecycle', () => {
  it('spawn() creates a worktree, spawns, registers, and taps events', async () => {
    const registry = new WorkerRegistry();
    const { mgr: wm, spawnCalls } = stubWorkerManager();
    const { mgr: wt, createCalls } = stubWorktreeManager();
    const lc = createWorkerLifecycle({
      registry,
      workerManager: wm,
      worktreeManager: wt,
      idGenerator: () => 'wk-unit',
    });
    const events: StreamEvent[] = [
      {
        type: 'system_init',
        sessionId: 'sess-1',
        model: 'claude-opus',
      } as StreamEvent,
      { type: 'assistant_text', text: 'hi' } as StreamEvent,
    ];
    const worker = new ScriptedWorker('wk-unit', emitEvents(events));
    (wm.spawn as unknown as { mockWorker?: unknown }).mockWorker = worker;
    const stubbed = wm as unknown as {
      spawn: (cfg: WorkerConfig) => Promise<Worker>;
    };
    stubbed.spawn = (async (cfg: WorkerConfig) => {
      spawnCalls.push(cfg);
      return worker;
    }) as unknown as (cfg: WorkerConfig) => Promise<Worker>;

    const record = await lc.spawn({
      projectPath: '/proj',
      taskDescription: 'Refactor auth',
      role: 'implementer',
      autonomyTier: 2,
    });

    expect(record.id).toBe('wk-unit');
    expect(record.worktreePath).toBe('/wt/wk-unit');
    expect(record.featureIntent).toBe('refactor-auth');
    expect(registry.has('wk-unit')).toBe(true);
    expect(createCalls[0]).toMatchObject({
      projectPath: '/proj',
      workerId: 'wk-unit',
      shortDescription: 'refactor-auth',
    });
    expect(spawnCalls[0]).toMatchObject({
      id: 'wk-unit',
      cwd: '/wt/wk-unit',
      prompt: 'Refactor auth',
      keepStdinOpen: true,
    });

    // Allow the event tap microtask to drain
    await new Promise((r) => setImmediate(r));
    const reloaded = registry.get('wk-unit');
    expect(reloaded?.sessionId).toBe('sess-1');
    expect(reloaded?.status).toBe('running');
    expect(reloaded?.buffer.size()).toBeGreaterThan(0);
  });

  it('event tap captures sessionUsage + costUsd from a result event (3N.1)', async () => {
    const registry = new WorkerRegistry();
    const { mgr: wm, spawnCalls } = stubWorkerManager();
    const { mgr: wt } = stubWorktreeManager();
    const events: StreamEvent[] = [
      {
        type: 'system_init',
        sessionId: 'sess-3n1',
        model: 'claude-opus',
      } as StreamEvent,
      {
        type: 'result',
        sessionId: 'sess-3n1',
        isError: false,
        resultText: 'done',
        durationMs: 1234,
        numTurns: 1,
        costUsd: 0.0427,
        usageByModel: {},
        sessionUsage: {
          inputTokens: 15_000,
          outputTokens: 2_100,
          cacheReadTokens: 12_500,
          cacheWriteTokens: 800,
        },
      } as StreamEvent,
    ];
    const worker = new ScriptedWorker('wk-usage', emitEvents(events));
    const stubbed = wm as unknown as { spawn: (cfg: WorkerConfig) => Promise<Worker> };
    stubbed.spawn = (async (cfg: WorkerConfig) => {
      spawnCalls.push(cfg);
      return worker;
    }) as unknown as (cfg: WorkerConfig) => Promise<Worker>;

    const lc = createWorkerLifecycle({
      registry,
      workerManager: wm,
      worktreeManager: wt,
      idGenerator: () => 'wk-usage',
    });
    await lc.spawn({
      projectPath: '/proj',
      taskDescription: 'Capture tokens',
      role: 'implementer',
      autonomyTier: 2,
    });
    // Drain the event-tap microtask so all events flow through.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    const rec = registry.get('wk-usage');
    expect(rec?.costUsd).toBeCloseTo(0.0427);
    expect(rec?.sessionUsage).toEqual({
      inputTokens: 15_000,
      outputTokens: 2_100,
      cacheReadTokens: 12_500,
      cacheWriteTokens: 800,
    });
  });

  it('spawn() deduplicates concurrent calls with the same id+projectPath', async () => {
    const registry = new WorkerRegistry();
    const { mgr: wm, spawnCalls } = stubWorkerManager();
    const { mgr: wt } = stubWorktreeManager();
    const worker = new ScriptedWorker('wk-dup', emitEvents([]));
    const stubbed = wm as unknown as {
      spawn: (cfg: WorkerConfig) => Promise<Worker>;
    };
    stubbed.spawn = (async (cfg: WorkerConfig) => {
      spawnCalls.push(cfg);
      return worker;
    }) as unknown as (cfg: WorkerConfig) => Promise<Worker>;

    const lc = createWorkerLifecycle({
      registry,
      workerManager: wm,
      worktreeManager: wt,
    });
    // Fire two spawns concurrently with the same id
    const [a, b] = await Promise.all([
      lc.spawn({
        projectPath: '/proj',
        taskDescription: 'do',
        role: 'implementer',
        id: 'wk-dup',
      }),
      lc.spawn({
        projectPath: '/proj',
        taskDescription: 'do',
        role: 'implementer',
        id: 'wk-dup',
      }),
    ]);
    expect(a).toBe(b);
    expect(spawnCalls.length).toBe(1);
  });

  it('spawn() re-raises when workerManager.spawn throws (worktree already created)', async () => {
    const registry = new WorkerRegistry();
    const { mgr: wm } = stubWorkerManager();
    const { mgr: wt, createCalls } = stubWorktreeManager();
    const stubbed = wm as unknown as {
      spawn: (cfg: WorkerConfig) => Promise<Worker>;
    };
    stubbed.spawn = (async () => {
      throw new Error('trust failure');
    }) as unknown as (cfg: WorkerConfig) => Promise<Worker>;

    const lc = createWorkerLifecycle({
      registry,
      workerManager: wm,
      worktreeManager: wt,
      idGenerator: () => 'wk-fail',
    });
    await expect(
      lc.spawn({ projectPath: '/proj', taskDescription: 'x', role: 'implementer' }),
    ).rejects.toThrow(/trust failure/);
    // Worktree was still created — that's intentional; finalize cleans up
    expect(createCalls.length).toBe(1);
    expect(registry.has('wk-fail')).toBe(false);
  });

  it('resume() rejects a running worker and forwards sessionId on terminal', async () => {
    const registry = new WorkerRegistry();
    const { mgr: wm, spawnCalls } = stubWorkerManager();
    const { mgr: wt } = stubWorktreeManager();
    const first = new ScriptedWorker('wk-r', emitEvents([]));
    const second = new ScriptedWorker('wk-r', emitEvents([]));
    const stubbed = wm as unknown as {
      spawn: (cfg: WorkerConfig) => Promise<Worker>;
    };
    let spawnCount = 0;
    stubbed.spawn = (async (cfg: WorkerConfig) => {
      spawnCalls.push(cfg);
      spawnCount += 1;
      return spawnCount === 1 ? first : second;
    }) as unknown as (cfg: WorkerConfig) => Promise<Worker>;

    const lc = createWorkerLifecycle({
      registry,
      workerManager: wm,
      worktreeManager: wt,
      idGenerator: () => 'wk-r',
    });
    const rec = await lc.spawn({
      projectPath: '/proj',
      taskDescription: 'do',
      role: 'implementer',
    });
    // still "running" via initial status — resume should reject
    rec.status = 'running';
    await expect(
      lc.resume({ recordId: 'wk-r', message: 'more' }),
    ).rejects.toThrow(/running/);

    // Flip to terminal; resume should now succeed
    rec.status = 'completed';
    rec.sessionId = 'sess-old';
    await lc.resume({ recordId: 'wk-r', message: 'continue' });
    const resumeCfg = spawnCalls[1];
    expect(resumeCfg?.sessionId).toBe('sess-old');
    expect(resumeCfg?.onStaleResume).toBe('warn-and-fresh');
    expect(resumeCfg?.prompt).toBe('continue');
  });

  it('shutdown() kills each worker and awaits exit', async () => {
    const registry = new WorkerRegistry();
    const { mgr: wm, spawnCalls } = stubWorkerManager();
    const { mgr: wt } = stubWorktreeManager();
    const worker = new ScriptedWorker('wk-sh', emitEvents([]));
    const stubbed = wm as unknown as {
      spawn: (cfg: WorkerConfig) => Promise<Worker>;
    };
    stubbed.spawn = (async (cfg: WorkerConfig) => {
      spawnCalls.push(cfg);
      return worker;
    }) as unknown as (cfg: WorkerConfig) => Promise<Worker>;

    const lc = createWorkerLifecycle({
      registry,
      workerManager: wm,
      worktreeManager: wt,
      idGenerator: () => 'wk-sh',
    });
    await lc.spawn({
      projectPath: '/proj',
      taskDescription: 'do',
      role: 'implementer',
    });
    await lc.shutdown();
    // registry cleared
    expect(registry.list().length).toBe(0);
  });

  it('wireExit guards against resume race — late old-worker exit does not clobber new worker status (M2 fix)', async () => {
    const registry = new WorkerRegistry();
    const { mgr: wm } = stubWorkerManager();
    const { mgr: wt } = stubWorktreeManager();
    const oldWorker = new ScriptedWorker('wk-race', emitEvents([]));
    const newWorker = new ScriptedWorker('wk-race', emitEvents([]));
    let spawnCount = 0;
    const stubbed = wm as unknown as { spawn: (cfg: WorkerConfig) => Promise<Worker> };
    stubbed.spawn = (async (cfg: WorkerConfig) => {
      void cfg;
      spawnCount += 1;
      return spawnCount === 1 ? oldWorker : newWorker;
    }) as unknown as (cfg: WorkerConfig) => Promise<Worker>;

    const lc = createWorkerLifecycle({
      registry,
      workerManager: wm,
      worktreeManager: wt,
      idGenerator: () => 'wk-race',
    });
    const rec = await lc.spawn({
      projectPath: '/p',
      taskDescription: 'x',
      role: 'implementer',
    });
    // Simulate the tool-layer precondition: record is terminal by status but
    // the old worker's waitForExit has NOT yet resolved.
    rec.status = 'completed';

    const resumePromise = lc.resume({ recordId: 'wk-race', message: 'continue' });
    // Now resolve the OLD worker's exit — this fires AFTER registry.replace
    // has swapped in the new worker. The M2 fix's identity check blocks
    // markCompleted from overwriting the new worker's fresh status.
    oldWorker.complete({
      status: 'failed',
      exitCode: 1,
      signal: null,
      sessionId: 'old-sess',
      durationMs: 0,
    });
    await resumePromise;
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    const snap = registry.snapshot('wk-race');
    expect(snap?.status).not.toBe('failed');
    expect(snap?.sessionId).not.toBe('old-sess');
  });

  it('updates status to completed via registry.markCompleted on natural exit', async () => {
    const registry = new WorkerRegistry();
    const { mgr: wm } = stubWorkerManager();
    const { mgr: wt } = stubWorktreeManager();
    const worker = new ScriptedWorker('wk-nat', emitEvents([]));
    const stubbed = wm as unknown as {
      spawn: (cfg: WorkerConfig) => Promise<Worker>;
    };
    stubbed.spawn = (async () => worker) as unknown as (
      cfg: WorkerConfig,
    ) => Promise<Worker>;

    const lc = createWorkerLifecycle({
      registry,
      workerManager: wm,
      worktreeManager: wt,
      idGenerator: () => 'wk-nat',
    });
    await lc.spawn({
      projectPath: '/proj',
      taskDescription: 'do',
      role: 'implementer',
    });
    worker.complete({
      status: 'completed',
      exitCode: 0,
      signal: null,
      sessionId: 'final',
      durationMs: 42,
    });
    await new Promise((r) => setImmediate(r));
    const snap = registry.snapshot('wk-nat');
    expect(snap?.status).toBe('completed');
    expect(snap?.sessionId).toBe('final');
  });

  // Phase 3S — per-worker autonomy override default-resolution.

  it('spawn() uses input.autonomyTier when explicitly provided (3S)', async () => {
    const registry = new WorkerRegistry();
    const { mgr: wm } = stubWorkerManager();
    const { mgr: wt } = stubWorktreeManager();
    const worker = new ScriptedWorker('wk-t3', emitEvents([]));
    const stubbed = wm as unknown as { spawn: (cfg: WorkerConfig) => Promise<Worker> };
    stubbed.spawn = (async () => worker) as unknown as (
      cfg: WorkerConfig,
    ) => Promise<Worker>;
    const lc = createWorkerLifecycle({
      registry,
      workerManager: wm,
      worktreeManager: wt,
      idGenerator: () => 'wk-t3',
      // Default-getter returns 2, but explicit input should win.
      getDefaultAutonomyTier: () => 2,
    });
    const record = await lc.spawn({
      projectPath: '/proj',
      taskDescription: 'do',
      role: 'implementer',
      autonomyTier: 3,
    });
    expect(record.autonomyTier).toBe(3);
  });

  it('spawn() falls back to getDefaultAutonomyTier when input omits it (3S)', async () => {
    const registry = new WorkerRegistry();
    const { mgr: wm } = stubWorkerManager();
    const { mgr: wt } = stubWorktreeManager();
    const worker = new ScriptedWorker('wk-t2', emitEvents([]));
    const stubbed = wm as unknown as { spawn: (cfg: WorkerConfig) => Promise<Worker> };
    stubbed.spawn = (async () => worker) as unknown as (
      cfg: WorkerConfig,
    ) => Promise<Worker>;
    const lc = createWorkerLifecycle({
      registry,
      workerManager: wm,
      worktreeManager: wt,
      idGenerator: () => 'wk-t2',
      getDefaultAutonomyTier: () => 2,
    });
    const record = await lc.spawn({
      projectPath: '/proj',
      taskDescription: 'do',
      role: 'implementer',
    });
    expect(record.autonomyTier).toBe(2);
  });

  it('spawn() reads getDefaultAutonomyTier fresh per spawn (3S)', async () => {
    // Simulates Ctrl+Y cycling between spawns: first spawn reads Tier 2,
    // then the dispatcher cursor flips to Tier 3, second spawn reads it.
    const registry = new WorkerRegistry();
    const { mgr: wm } = stubWorkerManager();
    const { mgr: wt } = stubWorktreeManager();
    let currentTier: 1 | 2 | 3 = 2;
    let counter = 0;
    const stubbed = wm as unknown as { spawn: (cfg: WorkerConfig) => Promise<Worker> };
    stubbed.spawn = (async () => {
      counter += 1;
      return new ScriptedWorker(`wk-tier-${counter}`, emitEvents([]));
    }) as unknown as (cfg: WorkerConfig) => Promise<Worker>;
    const lc = createWorkerLifecycle({
      registry,
      workerManager: wm,
      worktreeManager: wt,
      idGenerator: () => `wk-tier-${counter + 1}`,
      getDefaultAutonomyTier: () => currentTier,
    });
    const first = await lc.spawn({
      projectPath: '/proj-a',
      taskDescription: 'first',
      role: 'implementer',
    });
    currentTier = 3;
    const second = await lc.spawn({
      projectPath: '/proj-b',
      taskDescription: 'second',
      role: 'implementer',
    });
    expect(first.autonomyTier).toBe(2);
    expect(second.autonomyTier).toBe(3);
  });

  it('spawn() falls back to Tier 1 when getDefaultAutonomyTier is omitted (3S, legacy compat)', async () => {
    const registry = new WorkerRegistry();
    const { mgr: wm } = stubWorkerManager();
    const { mgr: wt } = stubWorktreeManager();
    const worker = new ScriptedWorker('wk-legacy', emitEvents([]));
    const stubbed = wm as unknown as { spawn: (cfg: WorkerConfig) => Promise<Worker> };
    stubbed.spawn = (async () => worker) as unknown as (
      cfg: WorkerConfig,
    ) => Promise<Worker>;
    const lc = createWorkerLifecycle({
      registry,
      workerManager: wm,
      worktreeManager: wt,
      idGenerator: () => 'wk-legacy',
    });
    const record = await lc.spawn({
      projectPath: '/proj',
      taskDescription: 'do',
      role: 'implementer',
    });
    expect(record.autonomyTier).toBe(1);
  });
});
