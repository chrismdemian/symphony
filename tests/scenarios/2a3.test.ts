import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ProjectRegistry,
  startOrchestratorServer,
  TaskRegistry,
  type OrchestratorServerHandle,
} from '../../src/orchestrator/index.js';
import type { WorkerManager } from '../../src/workers/manager.js';
import { WorktreeManager } from '../../src/worktree/manager.js';

const execFileAsync = promisify(execFile);

function fakeWorkerManager(): WorkerManager {
  return {
    spawn: async () => {
      throw new Error('no worker spawn expected in 2A.3 scenario');
    },
    list: () => [],
    get: () => undefined,
    shutdown: async () => {},
  } as unknown as WorkerManager;
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout;
}

async function initRepo(repoPath: string): Promise<void> {
  await git(repoPath, 'init', '--initial-branch=main');
  await git(repoPath, 'config', 'user.email', 'test@example.com');
  await git(repoPath, 'config', 'user.name', 'Symphony Scenario 2A.3');
  writeFileSync(path.join(repoPath, 'README.md'), '# seed\n');
  await git(repoPath, 'add', 'README.md');
  await git(repoPath, 'commit', '-m', 'seed');
}

interface Harness {
  client: Client;
  server: OrchestratorServerHandle;
  repoPath: string;
  tmpRoot: string;
  taskStore: TaskRegistry;
  worktreeManager: WorktreeManager;
}

async function setup(): Promise<Harness> {
  const tmpRoot = mkdtempSync(path.join(tmpdir(), 'symphony-2a3-'));
  const repoPath = path.join(tmpRoot, 'main-repo');
  writeFileSync(path.join(tmpRoot, '.sentinel'), 'scenario');
  await execFileAsync('git', ['init', '-q', repoPath]);
  await initRepo(repoPath);

  const projectStore = new ProjectRegistry();
  projectStore.register({ id: 'main', name: 'main', path: repoPath, createdAt: '' });
  projectStore.register({
    id: 'scratch',
    name: 'scratch',
    path: path.join(tmpRoot, 'nonexistent'),
    createdAt: '',
  });

  const taskStore = new TaskRegistry();
  const worktreeManager = new WorktreeManager();

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = await startOrchestratorServer({
    transport: serverTransport,
    initialMode: 'plan',
    defaultProjectPath: repoPath,
    workerManager: fakeWorkerManager(),
    worktreeManager,
    projectStore,
    taskStore,
  });
  const client = new Client({ name: '2a3-scenario', version: '0.0.0' });
  await client.connect(clientTransport);
  return { client, server, repoPath, tmpRoot, taskStore, worktreeManager };
}

describe('Phase 2A.3 — production scenario (project/task/worktree tools, real git)', () => {
  let harness: Harness | null = null;

  beforeEach(async () => {
    harness = await setup();
  });

  afterEach(async () => {
    if (!harness) return;
    await harness.client.close().catch(() => {});
    await harness.server.close().catch(() => {});
    try {
      rmSync(harness.tmpRoot, { recursive: true, force: true, maxRetries: 5 });
    } catch {
      /* windows file-lock retry — best effort */
    }
    harness = null;
  });

  it('drives plan→act flow: enqueue tasks, create worktree, mark complete', async () => {
    const h = harness!;

    const listRes = await h.client.callTool({ name: 'list_projects', arguments: {} });
    const listSc = listRes.structuredContent as {
      projects: Array<{ name: string; path: string }>;
      total: number;
    };
    expect(listSc.total).toBe(2);
    expect(listSc.projects.map((p) => p.name).sort()).toEqual(['main', 'scratch']);

    const infoRes = await h.client.callTool({
      name: 'get_project_info',
      arguments: { project_name: 'main' },
    });
    const infoSc = infoRes.structuredContent as { project: { path: string } };
    expect(path.resolve(infoSc.project.path)).toBe(path.resolve(h.repoPath));

    const t1 = await h.client.callTool({
      name: 'create_task',
      arguments: { project: 'main', description: 'add readme section' },
    });
    const t2 = await h.client.callTool({
      name: 'create_task',
      arguments: { project: 'main', description: 'wire CI', priority: 2 },
    });
    const t1Id = (t1.structuredContent as { id: string }).id;
    const t2Id = (t2.structuredContent as { id: string }).id;
    expect((t1.structuredContent as { status: string }).status).toBe('pending');
    expect((t2.structuredContent as { priority: number }).priority).toBe(2);

    const pending = await h.client.callTool({
      name: 'list_tasks',
      arguments: { status: 'pending' },
    });
    const pendingSc = pending.structuredContent as { tasks: Array<{ id: string }> };
    expect(pendingSc.tasks.map((t) => t.id).sort()).toEqual([t1Id, t2Id].sort());

    // PLAN → ACT switch.
    h.server.mode.setMode('act', '2A.3 scenario');

    const wtRes = await h.client.callTool({
      name: 'create_worktree',
      arguments: { project_name: 'main', short_description: 'readme-work' },
    });
    expect(wtRes.isError).toBeFalsy();
    const wtSc = wtRes.structuredContent as { worktree: { id: string; path: string } };
    expect(wtSc.worktree.id.startsWith('wt-')).toBe(true);
    expect(existsSync(wtSc.worktree.path)).toBe(true);

    const porcelain = await git(h.repoPath, 'worktree', 'list', '--porcelain');
    expect(porcelain).toContain(wtSc.worktree.path.replace(/\\/g, '/'));

    await h.client.callTool({
      name: 'update_task',
      arguments: { task_id: t1Id, status: 'in_progress', notes: 'picked up' },
    });
    const doneRes = await h.client.callTool({
      name: 'update_task',
      arguments: { task_id: t1Id, status: 'completed', result: 'pushed' },
    });
    const doneSc = doneRes.structuredContent as {
      status: string;
      completedAt: string;
      result: string;
    };
    expect(doneSc.status).toBe('completed');
    expect(doneSc.completedAt).toBeDefined();
    expect(doneSc.result).toBe('pushed');

    await h.client.callTool({
      name: 'update_task',
      arguments: { task_id: t2Id, status: 'cancelled', notes: 'descoped' },
    });

    const invalid = await h.client.callTool({
      name: 'update_task',
      arguments: { task_id: t1Id, status: 'failed' },
    });
    expect(invalid.isError).toBe(true);

    const finalList = await h.client.callTool({
      name: 'list_tasks',
      arguments: {},
    });
    const finalSc = finalList.structuredContent as {
      tasks: Array<{ id: string; status: string }>;
    };
    const byId = new Map(finalSc.tasks.map((t) => [t.id, t.status]));
    expect(byId.get(t1Id)).toBe('completed');
    expect(byId.get(t2Id)).toBe('cancelled');

    await h.worktreeManager.remove(wtSc.worktree.path, { deleteBranch: true });
    expect(existsSync(wtSc.worktree.path)).toBe(false);
  });
});
