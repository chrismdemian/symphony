import { describe, expect, it } from 'vitest';
import { DEFAULT_DISPATCH_CONTEXT } from '../../../src/orchestrator/capabilities.js';
import type { ToolHandlerReturn } from '../../../src/orchestrator/registry.js';
import { makeCreateTaskTool } from '../../../src/orchestrator/tools/create-task.js';
import { makeCreateWorktreeTool } from '../../../src/orchestrator/tools/create-worktree.js';
import { makeGetProjectInfoTool } from '../../../src/orchestrator/tools/get-project-info.js';
import { makeListProjectsTool } from '../../../src/orchestrator/tools/list-projects.js';
import { makeListTasksTool } from '../../../src/orchestrator/tools/list-tasks.js';
import { makeUpdateTaskTool } from '../../../src/orchestrator/tools/update-task.js';
import type { DispatchContext } from '../../../src/orchestrator/types.js';
import { WorkerRegistry } from '../../../src/orchestrator/worker-registry.js';
import { ProjectRegistry } from '../../../src/projects/registry.js';
import { TaskRegistry } from '../../../src/state/task-registry.js';
import type { WorktreeManager } from '../../../src/worktree/manager.js';
import type { CreateWorktreeOptions, WorktreeInfo } from '../../../src/worktree/types.js';

function ctx(overrides: Partial<DispatchContext> = {}): DispatchContext {
  return { ...DEFAULT_DISPATCH_CONTEXT, mode: 'act', ...overrides };
}

function seedProjects(): ProjectRegistry {
  const store = new ProjectRegistry();
  store.register({ id: 'frontend', name: 'frontend', path: '/repos/frontend', createdAt: '' });
  store.register({ id: 'backend', name: 'backend', path: '/repos/backend', createdAt: '' });
  return store;
}

function fakeWorktreeManager(overrides: Partial<WorktreeManager> = {}): WorktreeManager {
  const created: Array<WorktreeInfo> = [];
  const manager = {
    async create(opts: CreateWorktreeOptions): Promise<WorktreeInfo> {
      const info: WorktreeInfo = {
        id: opts.workerId,
        path: `/tmp/${opts.workerId}`,
        branch: `symphony/${opts.workerId}`,
        baseRef: opts.baseRef ?? 'HEAD',
        projectPath: opts.projectPath,
        createdAt: '2026-04-23T00:00:00.000Z',
      };
      created.push(info);
      return info;
    },
    ...overrides,
  } as unknown as WorktreeManager;
  (manager as unknown as { createdList: WorktreeInfo[] }).createdList = created;
  return manager;
}

function asText(res: ToolHandlerReturn): string {
  return res.content.map((c) => c.text).join('\n');
}

describe('list_projects', () => {
  it('returns all projects with text + structuredContent', async () => {
    const store = seedProjects();
    const tool = makeListProjectsTool({ store });
    const res = await tool.handler({ name_contains: undefined, limit: undefined }, ctx());
    expect(res.isError).toBeFalsy();
    expect(asText(res)).toContain('frontend');
    expect(asText(res)).toContain('backend');
    expect((res.structuredContent as { total: number }).total).toBe(2);
    expect((res.structuredContent as { truncated: boolean }).truncated).toBe(false);
  });

  it('filters by name_contains', async () => {
    const store = seedProjects();
    const tool = makeListProjectsTool({ store });
    const res = await tool.handler({ name_contains: 'front', limit: undefined }, ctx());
    expect((res.structuredContent as { total: number }).total).toBe(1);
  });

  it('respects limit and sets truncated', async () => {
    const store = seedProjects();
    const tool = makeListProjectsTool({ store });
    const res = await tool.handler({ name_contains: undefined, limit: 1 }, ctx());
    expect((res.structuredContent as { total: number }).total).toBe(2);
    expect((res.structuredContent as { truncated: boolean }).truncated).toBe(true);
    expect(
      (res.structuredContent as { projects: unknown[] }).projects.length,
    ).toBe(1);
  });

  it('reports empty registry', async () => {
    const store = new ProjectRegistry();
    const tool = makeListProjectsTool({ store });
    const res = await tool.handler({ name_contains: undefined, limit: undefined }, ctx());
    expect(asText(res)).toBe('No projects registered.');
  });
});

describe('get_project_info', () => {
  it('returns detail and worker counts', async () => {
    const store = seedProjects();
    store.register({
      id: 'deep',
      name: 'deep',
      path: '/repos/deep',
      gitBranch: 'main',
      baseRef: 'main',
      gitRemote: 'git@github.com:me/deep.git',
      defaultModel: 'opus',
      createdAt: '',
    });
    const workerRegistry = new WorkerRegistry();
    const tool = makeGetProjectInfoTool({ store, workerRegistry });
    const res = await tool.handler({ project_name: 'deep' }, ctx());
    expect(res.isError).toBeFalsy();
    expect(asText(res)).toContain('branch: main');
    expect(asText(res)).toContain('defaultModel: opus');
    expect(
      (res.structuredContent as { workers: { total: number; active: number } }).workers,
    ).toEqual({ total: 0, active: 0 });
  });

  it('errors on unknown project', async () => {
    const store = seedProjects();
    const workerRegistry = new WorkerRegistry();
    const tool = makeGetProjectInfoTool({ store, workerRegistry });
    const res = await tool.handler({ project_name: 'unknown' }, ctx());
    expect(res.isError).toBe(true);
    expect(asText(res)).toContain("Unknown project 'unknown'");
  });
});

describe('create_worktree', () => {
  it('creates a worktree when project exists', async () => {
    const store = seedProjects();
    const worktreeManager = fakeWorktreeManager();
    const tool = makeCreateWorktreeTool({
      store,
      worktreeManager,
      idGenerator: () => 'wt-abc',
    });
    const res = await tool.handler(
      { project_name: 'frontend', branch: undefined, short_description: undefined },
      ctx(),
    );
    expect(res.isError).toBeFalsy();
    const sc = res.structuredContent as {
      worktree: { id: string; path: string };
      project: { name: string };
    };
    expect(sc.worktree.id).toBe('wt-abc');
    expect(sc.project.name).toBe('frontend');
  });

  it('passes branch and description through', async () => {
    const store = seedProjects();
    const worktreeManager = fakeWorktreeManager();
    const tool = makeCreateWorktreeTool({
      store,
      worktreeManager,
      idGenerator: () => 'wt-xyz',
    });
    const res = await tool.handler(
      { project_name: 'frontend', branch: 'feature/x', short_description: 'try a thing' },
      ctx(),
    );
    const sc = res.structuredContent as { worktree: { baseRef: string } };
    expect(sc.worktree.baseRef).toBe('feature/x');
  });

  it('errors on unknown project', async () => {
    const store = seedProjects();
    const worktreeManager = fakeWorktreeManager();
    const tool = makeCreateWorktreeTool({ store, worktreeManager });
    const res = await tool.handler(
      { project_name: 'ghost', branch: undefined, short_description: undefined },
      ctx(),
    );
    expect(res.isError).toBe(true);
  });

  it('fast-fails on aborted signal', async () => {
    const store = seedProjects();
    const worktreeManager = fakeWorktreeManager();
    const tool = makeCreateWorktreeTool({ store, worktreeManager });
    const controller = new AbortController();
    controller.abort();
    const res = await tool.handler(
      { project_name: 'frontend', branch: undefined, short_description: undefined },
      ctx({ signal: controller.signal }),
    );
    expect(res.isError).toBe(true);
    expect(asText(res)).toContain('aborted');
  });

  it('forwards ctx.signal into CreateWorktreeOptions (audit M2)', async () => {
    const store = seedProjects();
    let capturedSignal: AbortSignal | undefined;
    const worktreeManager = {
      async create(opts: CreateWorktreeOptions): Promise<WorktreeInfo> {
        capturedSignal = opts.signal;
        return {
          id: opts.workerId,
          path: `/tmp/${opts.workerId}`,
          branch: `symphony/${opts.workerId}`,
          baseRef: 'HEAD',
          projectPath: opts.projectPath,
          createdAt: '2026-04-23T00:00:00.000Z',
        };
      },
    } as unknown as WorktreeManager;
    const tool = makeCreateWorktreeTool({ store, worktreeManager });
    const controller = new AbortController();
    await tool.handler(
      { project_name: 'frontend', branch: undefined, short_description: undefined },
      ctx({ signal: controller.signal }),
    );
    expect(capturedSignal).toBe(controller.signal);
  });

  it('reports worktree manager errors', async () => {
    const store = seedProjects();
    const worktreeManager = {
      async create(): Promise<WorktreeInfo> {
        throw new Error('boom');
      },
    } as unknown as WorktreeManager;
    const tool = makeCreateWorktreeTool({ store, worktreeManager });
    const res = await tool.handler(
      { project_name: 'frontend', branch: undefined, short_description: undefined },
      ctx(),
    );
    expect(res.isError).toBe(true);
    expect(asText(res)).toContain('boom');
  });
});

describe('list_tasks', () => {
  it('lists empty on fresh registry', async () => {
    const tool = makeListTasksTool({
      taskStore: new TaskRegistry(),
      projectStore: seedProjects(),
    });
    const res = await tool.handler(
      { project: undefined, status: undefined, limit: undefined },
      ctx(),
    );
    expect(asText(res)).toBe('No tasks match.');
    expect((res.structuredContent as { total: number }).total).toBe(0);
  });

  it('filters by project name (resolves to id)', async () => {
    const taskStore = new TaskRegistry();
    const projectStore = seedProjects();
    taskStore.create({ projectId: 'frontend', description: 'fix header' });
    taskStore.create({ projectId: 'backend', description: 'fix query' });
    const tool = makeListTasksTool({ taskStore, projectStore });
    const res = await tool.handler(
      { project: 'frontend', status: undefined, limit: undefined },
      ctx(),
    );
    const sc = res.structuredContent as { tasks: Array<{ projectId: string }> };
    expect(sc.tasks.length).toBe(1);
    expect(sc.tasks[0]?.projectId).toBe('frontend');
  });

  it('filters by status scalar', async () => {
    const taskStore = new TaskRegistry();
    const projectStore = seedProjects();
    const t1 = taskStore.create({ projectId: 'frontend', description: 'a' });
    taskStore.update(t1.id, { status: 'in_progress' });
    taskStore.create({ projectId: 'frontend', description: 'b' });
    const tool = makeListTasksTool({ taskStore, projectStore });
    const res = await tool.handler(
      { project: undefined, status: 'pending', limit: undefined },
      ctx(),
    );
    const sc = res.structuredContent as { tasks: unknown[] };
    expect(sc.tasks.length).toBe(1);
  });

  it('filters by status array', async () => {
    const taskStore = new TaskRegistry();
    const projectStore = seedProjects();
    const a = taskStore.create({ projectId: 'frontend', description: 'a' });
    const b = taskStore.create({ projectId: 'frontend', description: 'b' });
    taskStore.update(a.id, { status: 'in_progress' });
    taskStore.update(a.id, { status: 'completed' });
    taskStore.update(b.id, { status: 'cancelled' });
    const tool = makeListTasksTool({ taskStore, projectStore });
    const res = await tool.handler(
      { project: undefined, status: ['completed', 'cancelled'], limit: undefined },
      ctx(),
    );
    expect((res.structuredContent as { tasks: unknown[] }).tasks.length).toBe(2);
  });

  it('errors on unknown project filter', async () => {
    const tool = makeListTasksTool({
      taskStore: new TaskRegistry(),
      projectStore: seedProjects(),
    });
    const res = await tool.handler(
      { project: 'ghost', status: undefined, limit: undefined },
      ctx(),
    );
    expect(res.isError).toBe(true);
  });

  it('applies limit with truncated flag', async () => {
    const taskStore = new TaskRegistry();
    const projectStore = seedProjects();
    for (let i = 0; i < 3; i += 1) {
      taskStore.create({ projectId: 'frontend', description: `t${i}` });
    }
    const tool = makeListTasksTool({ taskStore, projectStore });
    const res = await tool.handler(
      { project: undefined, status: undefined, limit: 2 },
      ctx(),
    );
    const sc = res.structuredContent as { tasks: unknown[]; total: number; truncated: boolean };
    expect(sc.tasks.length).toBe(2);
    expect(sc.total).toBe(3);
    expect(sc.truncated).toBe(true);
  });
});

describe('create_task', () => {
  it('creates in pending state', async () => {
    const taskStore = new TaskRegistry();
    const projectStore = seedProjects();
    const tool = makeCreateTaskTool({ taskStore, projectStore });
    const res = await tool.handler(
      {
        project: 'frontend',
        description: 'ship it',
        priority: undefined,
        depends_on: undefined,
      },
      ctx(),
    );
    expect(res.isError).toBeFalsy();
    expect(taskStore.size()).toBe(1);
    const snap = res.structuredContent as { status: string; projectId: string };
    expect(snap.status).toBe('pending');
    expect(snap.projectId).toBe('frontend');
  });

  it('errors on unknown project', async () => {
    const tool = makeCreateTaskTool({
      taskStore: new TaskRegistry(),
      projectStore: seedProjects(),
    });
    const res = await tool.handler(
      { project: 'ghost', description: 'x', priority: undefined, depends_on: undefined },
      ctx(),
    );
    expect(res.isError).toBe(true);
  });

  it('errors on unknown dependency id', async () => {
    const taskStore = new TaskRegistry();
    const projectStore = seedProjects();
    const tool = makeCreateTaskTool({ taskStore, projectStore });
    const res = await tool.handler(
      {
        project: 'frontend',
        description: 'x',
        priority: undefined,
        depends_on: ['tk-nope'],
      },
      ctx(),
    );
    expect(res.isError).toBe(true);
    expect(asText(res)).toContain('Unknown dependency');
  });

  it('records priority and valid dependsOn', async () => {
    const taskStore = new TaskRegistry();
    const projectStore = seedProjects();
    const parent = taskStore.create({ projectId: 'frontend', description: 'parent' });
    const tool = makeCreateTaskTool({ taskStore, projectStore });
    const res = await tool.handler(
      {
        project: 'frontend',
        description: 'child',
        priority: 5,
        depends_on: [parent.id],
      },
      ctx(),
    );
    expect(res.isError).toBeFalsy();
    const snap = res.structuredContent as { priority: number; dependsOn: string[] };
    expect(snap.priority).toBe(5);
    expect(snap.dependsOn).toEqual([parent.id]);
  });
});

describe('update_task', () => {
  it('requires at least one updatable field', async () => {
    const tool = makeUpdateTaskTool({ taskStore: new TaskRegistry() });
    const res = await tool.handler(
      { task_id: 'tk-x', status: undefined, notes: undefined, worker_id: undefined, result: undefined },
      ctx(),
    );
    expect(res.isError).toBe(true);
  });

  it('rejects invalid transition', async () => {
    const taskStore = new TaskRegistry();
    const t = taskStore.create({ projectId: 'frontend', description: 'x' });
    taskStore.update(t.id, { status: 'in_progress' });
    taskStore.update(t.id, { status: 'completed' });
    const tool = makeUpdateTaskTool({ taskStore });
    const res = await tool.handler(
      { task_id: t.id, status: 'failed', notes: undefined, worker_id: undefined, result: undefined },
      ctx(),
    );
    expect(res.isError).toBe(true);
    expect(asText(res)).toContain('Invalid transition');
  });

  it('reports unknown task cleanly', async () => {
    const tool = makeUpdateTaskTool({ taskStore: new TaskRegistry() });
    const res = await tool.handler(
      { task_id: 'tk-missing', status: 'cancelled', notes: undefined, worker_id: undefined, result: undefined },
      ctx(),
    );
    expect(res.isError).toBe(true);
    expect(asText(res)).toContain("Unknown task 'tk-missing'");
  });

  it('writes worker_id and result without status change', async () => {
    const taskStore = new TaskRegistry();
    const t = taskStore.create({ projectId: 'frontend', description: 'x' });
    const tool = makeUpdateTaskTool({ taskStore });
    const res = await tool.handler(
      {
        task_id: t.id,
        status: undefined,
        notes: 'hooking up worker',
        worker_id: 'wk-77',
        result: undefined,
      },
      ctx(),
    );
    expect(res.isError).toBeFalsy();
    const sc = res.structuredContent as {
      workerId: string;
      notes: Array<{ text: string }>;
      status: string;
    };
    expect(sc.workerId).toBe('wk-77');
    expect(sc.notes).toHaveLength(1);
    expect(sc.status).toBe('pending');
  });

  it('succeeds on full progression with completedAt', async () => {
    const taskStore = new TaskRegistry();
    const t = taskStore.create({ projectId: 'frontend', description: 'x' });
    const tool = makeUpdateTaskTool({ taskStore });
    await tool.handler(
      { task_id: t.id, status: 'in_progress', notes: undefined, worker_id: undefined, result: undefined },
      ctx(),
    );
    const res = await tool.handler(
      {
        task_id: t.id,
        status: 'completed',
        notes: 'ship',
        worker_id: undefined,
        result: 'merged',
      },
      ctx(),
    );
    const sc = res.structuredContent as {
      status: string;
      completedAt: string;
      result: string;
    };
    expect(sc.status).toBe('completed');
    expect(sc.completedAt).toBeDefined();
    expect(sc.result).toBe('merged');
  });
});

describe('Tool scopes and capabilities', () => {
  it('planning tools are scope=both, create_worktree is act-only', () => {
    const store = seedProjects();
    const tools = [
      makeListProjectsTool({ store }),
      makeGetProjectInfoTool({ store, workerRegistry: new WorkerRegistry() }),
      makeListTasksTool({ taskStore: new TaskRegistry(), projectStore: store }),
      makeCreateTaskTool({ taskStore: new TaskRegistry(), projectStore: store }),
      makeUpdateTaskTool({ taskStore: new TaskRegistry() }),
    ];
    for (const t of tools) {
      expect(t.scope).toBe('both');
      expect(t.capabilities ?? []).toEqual([]);
    }
    const wt = makeCreateWorktreeTool({ store, worktreeManager: fakeWorktreeManager() });
    expect(wt.scope).toBe('act');
    expect(wt.capabilities ?? []).toEqual([]);
  });
});
