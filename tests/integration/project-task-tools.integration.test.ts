import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ProjectRegistry,
  startOrchestratorServer,
  TaskRegistry,
  type OrchestratorServerHandle,
} from '../../src/orchestrator/index.js';
import type { WorktreeManager } from '../../src/worktree/manager.js';
import type { CreateWorktreeOptions, WorktreeInfo } from '../../src/worktree/types.js';
import type { WorkerManager } from '../../src/workers/manager.js';

function fakeWorkerManager(): WorkerManager {
  return {
    spawn: async () => {
      throw new Error('no spawn expected in this suite');
    },
    list: () => [],
    get: () => undefined,
    shutdown: async () => {},
  } as unknown as WorkerManager;
}

function fakeWorktreeManager(): {
  manager: WorktreeManager;
  created: CreateWorktreeOptions[];
} {
  const created: CreateWorktreeOptions[] = [];
  const manager = {
    create: async (opts: CreateWorktreeOptions): Promise<WorktreeInfo> => {
      created.push(opts);
      return {
        id: opts.workerId,
        path: `/fake/${opts.workerId}`,
        branch: `symphony/${opts.workerId}`,
        baseRef: opts.baseRef ?? 'refs/heads/main',
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
  return { manager, created };
}

interface Harness {
  client: Client;
  server: OrchestratorServerHandle;
  projectStore: ProjectRegistry;
  taskStore: TaskRegistry;
  worktreeCalls: CreateWorktreeOptions[];
}

async function makeHarness(opts: { mode?: 'plan' | 'act' } = {}): Promise<Harness> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const projectStore = new ProjectRegistry();
  projectStore.register({
    id: 'frontend',
    name: 'frontend',
    path: '/repos/frontend',
    gitBranch: 'main',
    baseRef: 'main',
    createdAt: '',
  });
  projectStore.register({
    id: 'backend',
    name: 'backend',
    path: '/repos/backend',
    createdAt: '',
  });
  const taskStore = new TaskRegistry();
  const { manager: worktreeManager, created } = fakeWorktreeManager();

  const server = await startOrchestratorServer({
    transport: serverTransport,
    initialMode: opts.mode ?? 'act',
    defaultProjectPath: '/repos/frontend',
    workerManager: fakeWorkerManager(),
    worktreeManager,
    projectStore,
    taskStore,
  });
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(clientTransport);
  return { client, server, projectStore, taskStore, worktreeCalls: created };
}

describe('project/task/worktree tools (integration)', () => {
  let handles: OrchestratorServerHandle[] = [];
  let clients: Client[] = [];

  beforeEach(() => {
    handles = [];
    clients = [];
  });

  afterEach(async () => {
    for (const c of clients) await c.close().catch(() => {});
    for (const h of handles) await h.close().catch(() => {});
  });

  async function connect(opts: { mode?: 'plan' | 'act' } = {}) {
    const pair = await makeHarness(opts);
    handles.push(pair.server);
    clients.push(pair.client);
    return pair;
  }

  it('exposes all 6 tools in both plan and act mode', async () => {
    for (const mode of ['plan', 'act'] as const) {
      const { client } = await connect({ mode });
      const list = await client.listTools();
      const names = list.tools.map((t) => t.name);
      for (const n of [
        'list_projects',
        'get_project_info',
        'list_tasks',
        'create_task',
        'update_task',
      ]) {
        expect(names).toContain(n);
      }
      if (mode === 'act') {
        expect(names).toContain('create_worktree');
      } else {
        expect(names).not.toContain('create_worktree');
      }
    }
  });

  it('list_projects returns registered projects', async () => {
    const { client } = await connect();
    const res = await client.callTool({ name: 'list_projects', arguments: {} });
    const sc = res.structuredContent as {
      projects: Array<{ name: string }>;
      total: number;
    };
    expect(sc.total).toBe(2);
    expect(sc.projects.map((p) => p.name).sort()).toEqual(['backend', 'frontend']);
  });

  it('get_project_info resolves by name', async () => {
    const { client } = await connect();
    const res = await client.callTool({
      name: 'get_project_info',
      arguments: { project_name: 'frontend' },
    });
    const sc = res.structuredContent as {
      project: { name: string; gitBranch: string };
      workers: { total: number; active: number };
    };
    expect(sc.project.name).toBe('frontend');
    expect(sc.project.gitBranch).toBe('main');
    expect(sc.workers.total).toBe(0);
  });

  it('get_project_info errors on unknown project', async () => {
    const { client } = await connect();
    const res = await client.callTool({
      name: 'get_project_info',
      arguments: { project_name: 'ghost' },
    });
    expect(res.isError).toBe(true);
  });

  it('create_task + list_tasks + update_task flow', async () => {
    const { client, taskStore } = await connect();
    const createRes = await client.callTool({
      name: 'create_task',
      arguments: { project: 'frontend', description: 'ship the thing' },
    });
    const created = createRes.structuredContent as { id: string; status: string };
    expect(created.status).toBe('pending');

    const listRes = await client.callTool({
      name: 'list_tasks',
      arguments: { project: 'frontend', status: 'pending' },
    });
    expect((listRes.structuredContent as { total: number }).total).toBe(1);

    const start = await client.callTool({
      name: 'update_task',
      arguments: { task_id: created.id, status: 'in_progress', notes: 'kicked off' },
    });
    expect((start.structuredContent as { status: string }).status).toBe('in_progress');

    const done = await client.callTool({
      name: 'update_task',
      arguments: {
        task_id: created.id,
        status: 'completed',
        result: 'shipped',
      },
    });
    const doneSc = done.structuredContent as { status: string; completedAt: string };
    expect(doneSc.status).toBe('completed');
    expect(doneSc.completedAt).toBeDefined();

    const storeSnap = taskStore.snapshot(created.id)!;
    expect(storeSnap.notes.map((n) => n.text)).toContain('kicked off');
    expect(storeSnap.result).toBe('shipped');
  });

  it('update_task reports invalid transitions via isError', async () => {
    const { client } = await connect();
    const createRes = await client.callTool({
      name: 'create_task',
      arguments: { project: 'frontend', description: 'x' },
    });
    const id = (createRes.structuredContent as { id: string }).id;
    await client.callTool({
      name: 'update_task',
      arguments: { task_id: id, status: 'in_progress' },
    });
    await client.callTool({
      name: 'update_task',
      arguments: { task_id: id, status: 'completed' },
    });
    const res = await client.callTool({
      name: 'update_task',
      arguments: { task_id: id, status: 'failed' },
    });
    expect(res.isError).toBe(true);
    const text = (res.content as Array<{ type: string; text: string }>).map((c) => c.text).join('\n');
    expect(text).toContain('Invalid transition');
  });

  it('create_task errors on unknown project', async () => {
    const { client } = await connect();
    const res = await client.callTool({
      name: 'create_task',
      arguments: { project: 'ghost', description: 'x' },
    });
    expect(res.isError).toBe(true);
  });

  it('create_worktree dispatches through WorktreeManager', async () => {
    const { client, worktreeCalls } = await connect();
    const res = await client.callTool({
      name: 'create_worktree',
      arguments: {
        project_name: 'frontend',
        branch: 'main',
        short_description: 'scratch',
      },
    });
    expect(res.isError).toBeFalsy();
    expect(worktreeCalls.length).toBe(1);
    expect(worktreeCalls[0]?.projectPath).toBe(path.resolve('/repos/frontend'));
    expect(worktreeCalls[0]?.baseRef).toBe('main');
    const sc = res.structuredContent as {
      worktree: { id: string; path: string };
      project: { name: string };
    };
    expect(sc.worktree.id.startsWith('wt-')).toBe(true);
    expect(sc.project.name).toBe('frontend');
  });

  it('create_worktree rejects unknown project', async () => {
    const { client } = await connect();
    const res = await client.callTool({
      name: 'create_worktree',
      arguments: { project_name: 'ghost' },
    });
    expect(res.isError).toBe(true);
  });
});
