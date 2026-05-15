import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  startOrchestratorServer,
  SymphonyDatabase,
  type OrchestratorServerHandle,
} from '../../src/orchestrator/index.js';
import type { WorktreeManager } from '../../src/worktree/manager.js';
import type { CreateWorktreeOptions, WorktreeInfo } from '../../src/worktree/types.js';
import type { WorkerManager } from '../../src/workers/manager.js';
import type { Worker, WorkerConfig, WorkerExitInfo, StreamEvent } from '../../src/workers/types.js';

class ScriptedWorker implements Worker {
  readonly id: string;
  sessionId: string | undefined;
  status: 'spawning' | 'running' | 'completed' | 'failed' | 'killed' | 'timeout' | 'crashed' | 'interrupted' =
    'running';
  private resolveExit: ((info: WorkerExitInfo) => void) | null = null;
  private readonly exitPromise: Promise<WorkerExitInfo>;
  private readonly events_: AsyncIterable<StreamEvent>;

  constructor(id: string, sessionId: string | undefined = `sess-${id}`) {
    this.id = id;
    this.sessionId = sessionId;
    const sid = sessionId ?? `sess-${id}`;
    this.events_ = (async function* () {
      yield { type: 'system_init', sessionId: sid } as StreamEvent;
    })();
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
    this.complete({
      status: 'killed',
      exitCode: null,
      signal: 'SIGTERM',
      sessionId: this.sessionId,
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

function fakeWorktreeManager(): WorktreeManager {
  return {
    create: async (opts: CreateWorktreeOptions): Promise<WorktreeInfo> => ({
      id: opts.workerId,
      path: `/wt/${opts.workerId}`,
      branch: `symphony/${opts.workerId}`,
      baseRef: opts.baseRef ?? 'refs/heads/main',
      projectPath: opts.projectPath,
      createdAt: '2026-04-25T00:00:00.000Z',
    }),
    list: async () => [],
    remove: async () => {},
    removeIfClean: async () => true,
    status: async () => ({ hasChanges: false, staged: [], unstaged: [], untracked: [] }),
  } as unknown as WorktreeManager;
}

function fakeWorkerManager(workers: ScriptedWorker[]): WorkerManager {
  let i = 0;
  return {
    spawn: async (cfg: WorkerConfig) => {
      void cfg;
      const w = workers[i];
      i += 1;
      if (!w) throw new Error('fakeWorkerManager: no queued worker');
      return w;
    },
    list: () => [],
    get: () => undefined,
    shutdown: async () => {},
  } as unknown as WorkerManager;
}

interface Harness {
  client: Client;
  server: OrchestratorServerHandle;
  database: SymphonyDatabase;
}

async function makeHarness(
  database: SymphonyDatabase,
  workers: ScriptedWorker[],
  initialMode: 'plan' | 'act' = 'act',
): Promise<Harness> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = await startOrchestratorServer({
    transport: serverTransport,
    initialMode,
    defaultProjectPath: '/repos/default',
    database,
    workerManager: fakeWorkerManager(workers),
    worktreeManager: fakeWorktreeManager(),
    projects: { symphony: '/repos/symphony' },
  });
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(clientTransport);
  return { client, server, database };
}

async function teardown(h: Harness): Promise<void> {
  await h.client.close().catch(() => {});
  await h.server.close().catch(() => {});
}

describe('Worker persistence (2B.1b) — write-through + recovery', () => {
  let database: SymphonyDatabase;

  beforeEach(() => {
    // Use a fresh in-memory DB per test, but reuse it across server
    // restarts within one test by handing the same handle to both
    // `makeHarness` calls (we don't close it between).
    database = SymphonyDatabase.open({ filePath: ':memory:' });
  });

  afterEach(() => {
    database.close();
  });

  it('spawn → kill → list_workers reflects "killed" via SQL after server close', async () => {
    const w = new ScriptedWorker('wk-A');
    const h = await makeHarness(database, [w]);
    try {
      const spawn = await h.client.callTool({
        name: 'spawn_worker',
        arguments: {
          project: 'symphony',
          task_description: 'do thing',
          role: 'implementer',
        },
      });
      const id = (spawn.structuredContent as { id: string }).id;

      // Now kill the worker — wireExit fires markCompleted with status='killed'
      await h.client.callTool({
        name: 'kill_worker',
        arguments: { worker_id: id },
      });
      // Flush microtasks for the wireExit chain.
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));

      const listRes = await h.client.callTool({
        name: 'list_workers',
        arguments: {},
      });
      const sc = listRes.structuredContent as {
        workers: Array<{ id: string; status: string }>;
      };
      const found = sc.workers.find((w) => w.id === id);
      expect(found?.status).toBe('killed');
    } finally {
      await teardown(h);
    }
  });

  it('crash recovery: workers in "running" status at restart are flipped to "crashed"', async () => {
    // Server #1: spawn a worker, then HARD-close (skip lifecycle.shutdown)
    // by closing only the client + transport. The DB row stays as 'running'.
    const w = new ScriptedWorker('wk-B', 'sess-keepme');
    const h1 = await makeHarness(database, [w]);
    const spawn = await h1.client.callTool({
      name: 'spawn_worker',
      arguments: {
        project: 'symphony',
        task_description: 'do thing',
        role: 'implementer',
      },
    });
    const id = (spawn.structuredContent as { id: string }).id;
    // Allow event tap to flip status to 'running' via system_init.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    // Simulate hard crash — close client only, skip server.close so
    // shutdown() doesn't run (markCompleted is bypassed).
    await h1.client.close().catch(() => {});

    // Server #2: bring up a fresh orchestrator on the same DB.
    const w2 = new ScriptedWorker('wk-resume');
    const h2 = await makeHarness(database, [w2]);
    try {
      const listRes = await h2.client.callTool({
        name: 'list_workers',
        arguments: {},
      });
      const sc = listRes.structuredContent as {
        workers: Array<{ id: string; status: string; sessionId?: string }>;
      };
      const recovered = sc.workers.find((w) => w.id === id);
      expect(recovered?.status).toBe('crashed');
      expect(recovered?.sessionId).toBe('sess-keepme'); // session preserved for resume
    } finally {
      await teardown(h2);
    }
  });

  it('list_workers honors include_terminal=false symmetrically (M2 fix)', async () => {
    const w = new ScriptedWorker('wk-C');
    const h = await makeHarness(database, [w]);
    try {
      const spawn = await h.client.callTool({
        name: 'spawn_worker',
        arguments: {
          project: 'symphony',
          task_description: 'do thing',
          role: 'implementer',
        },
      });
      const id = (spawn.structuredContent as { id: string }).id;

      // Kill → terminal status persisted.
      await h.client.callTool({
        name: 'kill_worker',
        arguments: { worker_id: id },
      });
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));

      // Default include_terminal=true → killed worker visible.
      const listAll = await h.client.callTool({
        name: 'list_workers',
        arguments: {},
      });
      const allWorkers = (listAll.structuredContent as { workers: Array<{ id: string }> }).workers;
      expect(allWorkers.some((w) => w.id === id)).toBe(true);

      // include_terminal=false → both live AND persisted terminal rows
      // are filtered. The killed worker should NOT appear (M2 fix: flag
      // applies symmetrically).
      const listLive = await h.client.callTool({
        name: 'list_workers',
        arguments: { include_terminal: false },
      });
      const liveWorkers = (listLive.structuredContent as { workers: Array<{ id: string; status: string }> }).workers;
      expect(liveWorkers.some((w) => w.id === id)).toBe(false);
      // Sanity: any worker shown must be in a non-terminal status.
      for (const w of liveWorkers) {
        expect(['spawning', 'running']).toContain(w.status);
      }
    } finally {
      await teardown(h);
    }
  });

  it('resume_worker works on a recovered crashed worker (C1 fix)', async () => {
    // Server #1: spawn a real-ish worker, abandon (no shutdown).
    const w1 = new ScriptedWorker('wk-resumer-A', 'sess-resumable');
    const h1 = await makeHarness(database, [w1]);
    const spawn = await h1.client.callTool({
      name: 'spawn_worker',
      arguments: {
        project: 'symphony',
        task_description: 'first attempt',
        role: 'implementer',
      },
    });
    const id = (spawn.structuredContent as { id: string }).id;
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    await h1.client.close();

    // Server #2: fresh boot. recoverFromStore flips the worker to
    // crashed AND rehydrates the in-memory registry.
    const w2 = new ScriptedWorker('wk-resumer-A', 'sess-resumable'); // re-used id; resumed handle
    const h2 = await makeHarness(database, [w2]);
    try {
      // The crashed worker must be addressable by id (C1: it's in the
      // in-memory registry now, not just SQL).
      const find = await h2.client.callTool({
        name: 'find_worker',
        arguments: { description: id },
      });
      const findSc = find.structuredContent as { matches: Array<{ id: string }> };
      expect(findSc.matches.some((m) => m.id === id)).toBe(true);

      // resume_worker must find the worker and replace its stub with a
      // real handle. Status flips to 'spawning' → 'running' via tap.
      const resume = await h2.client.callTool({
        name: 'resume_worker',
        arguments: { worker_id: id, message: 'continue please' },
      });
      expect(resume.isError).toBeFalsy();

      // Persisted row now reflects the resume — no stale completedAt /
      // exitCode from the prior crash (M1 fix).
      const row = database.db
        .prepare(
          `SELECT status, session_id, completed_at, exit_code, exit_signal FROM workers WHERE id = ?`,
        )
        .get(id) as {
        status: string;
        session_id: string;
        completed_at: string | null;
        exit_code: number | null;
        exit_signal: string | null;
      };
      expect(['spawning', 'running']).toContain(row.status);
      expect(row.session_id).toBe('sess-resumable');
      expect(row.completed_at).toBeNull();
      expect(row.exit_code).toBeNull();
      expect(row.exit_signal).toBeNull();
    } finally {
      await teardown(h2);
    }
  });

  it('global_status includes persisted-only crashed workers across restart', async () => {
    const w = new ScriptedWorker('wk-D');
    const h1 = await makeHarness(database, [w]);
    await h1.client.callTool({
      name: 'spawn_worker',
      arguments: {
        project: 'symphony',
        task_description: 'do thing',
        role: 'implementer',
      },
    });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    // Hard close.
    await h1.client.close().catch(() => {});

    // Restart fresh.
    const h2 = await makeHarness(database, [], 'plan');
    try {
      const status = await h2.client.callTool({
        name: 'global_status',
        arguments: {},
      });
      const sc = status.structuredContent as {
        totals: { workers: number; active: number };
        projects: Array<{ project: string; total: number; failed: number }>;
      };
      // The crashed worker must show in totals.workers and bucket.failed.
      expect(sc.totals.workers).toBe(1);
      expect(sc.totals.active).toBe(0);
      const symphony = sc.projects.find((p) => p.project === 'symphony');
      expect(symphony?.failed).toBe(1);
    } finally {
      await teardown(h2);
    }
  });

  it('cross-project filter does not leak persisted workers from other projects', async () => {
    const w = new ScriptedWorker('wk-cross');
    const h = await makeHarness(database, [w]);
    try {
      const spawn = await h.client.callTool({
        name: 'spawn_worker',
        arguments: {
          project: 'symphony',
          task_description: 'do thing',
          role: 'implementer',
        },
      });
      void spawn;
      await new Promise((r) => setImmediate(r));

      const otherList = await h.client.callTool({
        name: 'list_workers',
        arguments: { project: 'default' },
      });
      const otherCount = (otherList.structuredContent as { workers: unknown[] }).workers.length;
      expect(otherCount).toBe(0);

      const ownList = await h.client.callTool({
        name: 'list_workers',
        arguments: { project: 'symphony' },
      });
      const ownCount = (ownList.structuredContent as { workers: unknown[] }).workers.length;
      expect(ownCount).toBe(1);
    } finally {
      await teardown(h);
    }
  });

  it('corrupt depends_on row in workers table is skipped by list_workers, not crashed', async () => {
    const w = new ScriptedWorker('wk-good');
    const h = await makeHarness(database, [w]);
    try {
      const spawn = await h.client.callTool({
        name: 'spawn_worker',
        arguments: {
          project: 'symphony',
          task_description: 'good worker',
          role: 'implementer',
        },
      });
      const id = (spawn.structuredContent as { id: string }).id;
      await new Promise((r) => setImmediate(r));

      // Inject a corrupt row into the workers table directly.
      database.db
        .prepare(
          `INSERT INTO workers (id, project_id, worktree_path, status, role, feature_intent, task_description, autonomy_tier, depends_on, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          'wk-bad',
          null,
          '/wt/wk-bad',
          'crashed',
          'implementer',
          'bad',
          'bad row',
          1,
          'NOT-JSON',
          '2026-04-25T00:00:00.000Z',
        );

      const list = await h.client.callTool({
        name: 'list_workers',
        arguments: {},
      });
      const sc = list.structuredContent as { workers: Array<{ id: string }> };
      const ids = sc.workers.map((w) => w.id);
      expect(ids).toContain(id);
      expect(ids).not.toContain('wk-bad');
    } finally {
      await teardown(h);
    }
  });
});
