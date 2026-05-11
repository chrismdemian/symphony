/**
 * Phase 3N.1 production scenario — token persistence end-to-end.
 *
 * Real `SymphonyDatabase` (in-memory SQLite), real `WorkerRegistry` backed
 * by real `SqliteWorkerStore`, real `createWorkerLifecycle`. Stub
 * `WorkerManager`/`WorktreeManager` give us a controlled `Worker` handle
 * whose event stream emits a `result` with `costUsd` + `sessionUsage`
 * shaped exactly the way the parser produces them.
 *
 * What we're proving: the event-tap path in `worker-lifecycle.ts:281-289`
 * → `registry.updateCostUsd` + `registry.updateSessionUsage` →
 * `markCompleted` patch → `SqliteWorkerStore.update` writes BOTH
 * `cost_usd` AND the four token columns onto the row. SELECT against
 * the real schema confirms the schema-contract → migration → store chain
 * is wired end-to-end.
 */
import { describe, it, expect } from 'vitest';
import { SymphonyDatabase } from '../../src/state/db.js';
import { SqliteWorkerStore } from '../../src/state/sqlite-worker-store.js';
import { WorkerRegistry } from '../../src/orchestrator/worker-registry.js';
import { createWorkerLifecycle } from '../../src/orchestrator/worker-lifecycle.js';
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
  status: Worker['status'] = 'running';
  private readonly events_: AsyncIterable<StreamEvent>;
  private resolveExit: ((info: WorkerExitInfo) => void) | null = null;
  private readonly exitPromise: Promise<WorkerExitInfo>;
  constructor(id: string, events: AsyncIterable<StreamEvent>) {
    this.id = id;
    this.events_ = events;
    this.exitPromise = new Promise((r) => {
      this.resolveExit = r;
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

async function* emit(events: StreamEvent[]): AsyncGenerator<StreamEvent> {
  for (const e of events) yield e;
}

function stubWorkerManager(worker: ScriptedWorker): WorkerManager {
  return {
    spawn: async (_cfg: WorkerConfig) => worker,
    list: () => [],
    get: () => undefined,
    shutdown: async () => {},
  } as unknown as WorkerManager;
}

function stubWorktreeManager(): WorktreeManager {
  return {
    create: async (opts: CreateWorktreeOptions): Promise<WorktreeInfo> => ({
      id: opts.workerId,
      path: `/wt/${opts.workerId}`,
      branch: `symphony/${opts.workerId}`,
      baseRef: 'refs/heads/master',
      projectPath: opts.projectPath,
      createdAt: '2026-05-11T00:00:00.000Z',
    }),
    list: async () => [],
    remove: async () => {},
    removeIfClean: async () => true,
    status: async () => ({ hasChanges: false, staged: [], unstaged: [], untracked: [] }),
  } as unknown as WorktreeManager;
}

describe('Phase 3N.1 production scenario — token persistence end-to-end', () => {
  it('captures costUsd + sessionUsage from a result event and persists to all four SQL columns', async () => {
    const db = SymphonyDatabase.open({ filePath: ':memory:' });
    try {
      // Seed a project so `project_id` is a real FK target.
      db.db
        .prepare(
          `INSERT INTO projects (id, name, path, created_at) VALUES (?, ?, ?, datetime('now'))`,
        )
        .run('proj-symphony', 'symphony', '/proj/symphony');

      const store = new SqliteWorkerStore(db.db);
      const registry = new WorkerRegistry({ store });
      const events: StreamEvent[] = [
        {
          type: 'system_init',
          sessionId: 'sess-3n1-prod',
          model: 'claude-opus-4-7',
        } as StreamEvent,
        { type: 'assistant_text', text: 'working on it' } as StreamEvent,
        {
          type: 'result',
          sessionId: 'sess-3n1-prod',
          isError: false,
          resultText: 'done',
          durationMs: 4321,
          numTurns: 1,
          costUsd: 0.1234,
          usageByModel: {
            'claude-opus-4-7': {
              inputTokens: 100,
              outputTokens: 200,
              cacheReadTokens: 50,
              cacheWriteTokens: 25,
            },
          },
          sessionUsage: {
            inputTokens: 47_120,
            outputTokens: 8_240,
            cacheReadTokens: 31_500,
            cacheWriteTokens: 2_100,
          },
        } as StreamEvent,
      ];
      const worker = new ScriptedWorker('wk-prod', emit(events));
      const lc = createWorkerLifecycle({
        registry,
        workerManager: stubWorkerManager(worker),
        worktreeManager: stubWorktreeManager(),
        idGenerator: () => 'wk-prod',
      });

      const record = await lc.spawn({
        projectPath: '/proj/symphony',
        projectId: 'proj-symphony',
        taskDescription: 'Token tracking smoke test',
        role: 'implementer',
        autonomyTier: 2,
      });
      expect(record.id).toBe('wk-prod');

      // Drain the tap so all events flow through.
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));

      // The tap has run — registry holds the cumulative usage now.
      const live = registry.get('wk-prod');
      expect(live?.costUsd).toBeCloseTo(0.1234);
      expect(live?.sessionUsage).toEqual({
        inputTokens: 47_120,
        outputTokens: 8_240,
        cacheReadTokens: 31_500,
        cacheWriteTokens: 2_100,
      });

      // Complete the worker — markCompleted writes the patch to the
      // store with both costUsd and sessionUsage populated.
      worker.complete({ status: 'completed', exitCode: 0, signal: null, durationMs: 4321 });
      await worker.waitForExit();
      // Lifecycle's wireExit fires markCompleted in a microtask off the
      // exit promise; one more drain ensures it lands.
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));

      // Production assertion: SELECT the raw SQL row and confirm every
      // column the migration added is populated alongside cost_usd.
      const row = db.db
        .prepare(
          `SELECT status, cost_usd, input_tokens, output_tokens,
                  cache_read_tokens, cache_write_tokens
             FROM workers WHERE id = ?`,
        )
        .get('wk-prod') as {
        status: string;
        cost_usd: number | null;
        input_tokens: number | null;
        output_tokens: number | null;
        cache_read_tokens: number | null;
        cache_write_tokens: number | null;
      };
      expect(row.status).toBe('completed');
      expect(row.cost_usd).toBeCloseTo(0.1234);
      expect(row.input_tokens).toBe(47_120);
      expect(row.output_tokens).toBe(8_240);
      expect(row.cache_read_tokens).toBe(31_500);
      expect(row.cache_write_tokens).toBe(2_100);

      // Snapshot also surfaces sessionUsage (TUI / RPC consumers).
      const snap = registry.snapshot('wk-prod');
      expect(snap?.sessionUsage).toEqual({
        inputTokens: 47_120,
        outputTokens: 8_240,
        cacheReadTokens: 31_500,
        cacheWriteTokens: 2_100,
      });
    } finally {
      db.close();
    }
  });

  it('a worker that never emits a result leaves all four token columns NULL', async () => {
    const db = SymphonyDatabase.open({ filePath: ':memory:' });
    try {
      db.db
        .prepare(
          `INSERT INTO projects (id, name, path, created_at) VALUES (?, ?, ?, datetime('now'))`,
        )
        .run('proj-x', 'x', '/proj/x');
      const store = new SqliteWorkerStore(db.db);
      const registry = new WorkerRegistry({ store });
      // Only a system_init; no `result` event before death.
      const events: StreamEvent[] = [
        {
          type: 'system_init',
          sessionId: 'sess-early-crash',
          model: 'claude-opus-4-7',
        } as StreamEvent,
      ];
      const worker = new ScriptedWorker('wk-crash', emit(events));
      const lc = createWorkerLifecycle({
        registry,
        workerManager: stubWorkerManager(worker),
        worktreeManager: stubWorktreeManager(),
        idGenerator: () => 'wk-crash',
      });
      await lc.spawn({
        projectPath: '/proj/x',
        projectId: 'proj-x',
        taskDescription: 'crash before result',
        role: 'implementer',
        autonomyTier: 2,
      });
      await new Promise((r) => setImmediate(r));
      worker.complete({ status: 'crashed', exitCode: null, signal: 'SIGKILL', durationMs: 30 });
      await worker.waitForExit();
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));

      const row = db.db
        .prepare(
          `SELECT cost_usd, input_tokens, output_tokens,
                  cache_read_tokens, cache_write_tokens
             FROM workers WHERE id = ?`,
        )
        .get('wk-crash') as {
        cost_usd: number | null;
        input_tokens: number | null;
        output_tokens: number | null;
        cache_read_tokens: number | null;
        cache_write_tokens: number | null;
      };
      // Explicit-null write path — clearing on terminal-without-result
      // matches the costUsd contract.
      expect(row.cost_usd).toBeNull();
      expect(row.input_tokens).toBeNull();
      expect(row.output_tokens).toBeNull();
      expect(row.cache_read_tokens).toBeNull();
      expect(row.cache_write_tokens).toBeNull();
    } finally {
      db.close();
    }
  });
});
