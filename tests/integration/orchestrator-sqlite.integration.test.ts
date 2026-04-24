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

function fakeWorkerManager(): WorkerManager {
  return {
    spawn: async () => {
      throw new Error('spawn not expected in this suite');
    },
    list: () => [],
    get: () => undefined,
    shutdown: async () => {},
  } as unknown as WorkerManager;
}

function fakeWorktreeManager(): WorktreeManager {
  return {
    create: async (opts: CreateWorktreeOptions): Promise<WorktreeInfo> => ({
      id: opts.workerId,
      path: `/fake/${opts.workerId}`,
      branch: `symphony/${opts.workerId}`,
      baseRef: opts.baseRef ?? 'refs/heads/main',
      projectPath: opts.projectPath,
      createdAt: '2026-04-23T00:00:00.000Z',
    }),
    list: async () => [],
    remove: async () => {},
    removeIfClean: async () => true,
    status: async () => ({ hasChanges: false, staged: [], unstaged: [], untracked: [] }),
  } as unknown as WorktreeManager;
}

interface Harness {
  client: Client;
  server: OrchestratorServerHandle;
  database: SymphonyDatabase;
}

async function makeHarness(): Promise<Harness> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const database = SymphonyDatabase.open({ filePath: ':memory:' });
  const server = await startOrchestratorServer({
    transport: serverTransport,
    initialMode: 'plan',
    defaultProjectPath: '/repos/default',
    database,
    workerManager: fakeWorkerManager(),
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
  h.database.close();
}

describe('OrchestratorServer + SQLite (2B.1)', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
  });
  afterEach(async () => {
    await teardown(h);
  });

  it('projects from OrchestratorServerOptions.projects are seeded into SQLite', async () => {
    const res = await h.client.callTool({ name: 'list_projects', arguments: {} });
    const sc = res.structuredContent as { projects: Array<{ name: string; path: string }> };
    const names = sc.projects.map((p) => p.name).sort();
    expect(names).toEqual(['default', 'symphony']);
  });

  it('create_task + list_tasks round-trips through SQLite', async () => {
    const createRes = await h.client.callTool({
      name: 'create_task',
      arguments: { project: 'symphony', description: 'persist a task', priority: 2 },
    });
    const created = createRes.structuredContent as { id: string; priority: number };
    expect(created.priority).toBe(2);

    const listRes = await h.client.callTool({
      name: 'list_tasks',
      arguments: { project: 'symphony' },
    });
    const listSc = listRes.structuredContent as {
      tasks: Array<{ id: string }>;
      total: number;
    };
    expect(listSc.tasks).toHaveLength(1);
    expect(listSc.tasks[0]!.id).toBe(created.id);
  });

  it('update_task persists status and notes', async () => {
    const createRes = await h.client.callTool({
      name: 'create_task',
      arguments: { project: 'symphony', description: 'to run' },
    });
    const id = (createRes.structuredContent as { id: string }).id;

    const updateRes = await h.client.callTool({
      name: 'update_task',
      arguments: { task_id: id, status: 'in_progress', notes: 'kicked off' },
    });
    const updated = updateRes.structuredContent as {
      status: string;
      notes: Array<{ text: string }>;
    };
    expect(updated.status).toBe('in_progress');
    expect(updated.notes.map((n) => n.text)).toEqual(['kicked off']);
  });

  it('ask_user enqueues through SQLite-backed QuestionStore', async () => {
    const res = await h.client.callTool({
      name: 'ask_user',
      arguments: { question: 'which model?', urgency: 'blocking' },
    });
    const sc = res.structuredContent as { id: string; question: string; urgency: string };
    expect(sc.id).toMatch(/^q-/);
    expect(sc.question).toBe('which model?');
    expect(sc.urgency).toBe('blocking');
    const fromStore = h.server.questionStore.get(sc.id);
    expect(fromStore?.question).toBe('which model?');
  });

  it('get_project_info returns per-project metadata from SQLite', async () => {
    const res = await h.client.callTool({
      name: 'get_project_info',
      arguments: { project_name: 'symphony' },
    });
    const sc = res.structuredContent as {
      project: { name: string; path: string };
      workers: { total: number; active: number };
    };
    expect(sc.project.name).toBe('symphony');
    expect(sc.project.path.toLowerCase()).toContain('symphony');
    expect(sc.workers.total).toBe(0);
  });

  it('persistence across server restart with the same DB file', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const pathMod = await import('node:path');
    const dir = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'symphony-int-'));
    const file = pathMod.join(dir, 'symphony.db');
    try {
      // --- first server run ---
      const db1 = SymphonyDatabase.open({ filePath: file });
      const pair1 = InMemoryTransport.createLinkedPair();
      const server1 = await startOrchestratorServer({
        transport: pair1[1],
        initialMode: 'plan',
        defaultProjectPath: '/repos/default',
        database: db1,
        workerManager: fakeWorkerManager(),
        worktreeManager: fakeWorktreeManager(),
        projects: { symphony: '/repos/symphony' },
      });
      const client1 = new Client({ name: 'c1', version: '0.0.0' });
      await client1.connect(pair1[0]);
      const createRes = await client1.callTool({
        name: 'create_task',
        arguments: { project: 'symphony', description: 'survives restart', priority: 9 },
      });
      const createdId = (createRes.structuredContent as { id: string }).id;
      await client1.close();
      await server1.close();
      db1.close();

      // --- second server run ---
      const db2 = SymphonyDatabase.open({ filePath: file });
      const pair2 = InMemoryTransport.createLinkedPair();
      const server2 = await startOrchestratorServer({
        transport: pair2[1],
        initialMode: 'plan',
        defaultProjectPath: '/repos/default',
        database: db2,
        workerManager: fakeWorkerManager(),
        worktreeManager: fakeWorktreeManager(),
        projects: { symphony: '/repos/symphony' },
      });
      const client2 = new Client({ name: 'c2', version: '0.0.0' });
      await client2.connect(pair2[0]);
      const listRes = await client2.callTool({
        name: 'list_tasks',
        arguments: { project: 'symphony' },
      });
      const sc = listRes.structuredContent as {
        tasks: Array<{ id: string; description: string; priority: number }>;
      };
      expect(sc.tasks).toHaveLength(1);
      expect(sc.tasks[0]!.id).toBe(createdId);
      expect(sc.tasks[0]!.description).toBe('survives restart');
      expect(sc.tasks[0]!.priority).toBe(9);

      await client2.close();
      await server2.close();
      db2.close();
    } finally {
      // Win32 holds file handles briefly after SQLite close — ignore rm errors.
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});
