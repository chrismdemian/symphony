import { describe, expect, it } from 'vitest';
import { projectRegistryFromMap } from '../../../src/projects/registry.js';
import { makeGlobalStatusTool } from '../../../src/orchestrator/tools/global-status.js';
import type { WorktreeManager } from '../../../src/worktree/manager.js';
import {
  CircularBuffer,
  WorkerRegistry,
  type WorkerRecord,
} from '../../../src/orchestrator/worker-registry.js';
import type { DispatchContext } from '../../../src/orchestrator/types.js';
import type { WorktreeStatus } from '../../../src/worktree/types.js';
import type { StreamEvent, Worker, WorkerStatus } from '../../../src/workers/types.js';

function ctx(overrides: Partial<DispatchContext> = {}): DispatchContext {
  return {
    mode: 'plan',
    tier: 1,
    awayMode: false,
    automationContext: false,
    ...overrides,
  };
}

function stubWorker(id: string): Worker {
  return {
    id,
    sessionId: undefined,
    status: 'running',
    events: (async function* () {})(),
    sendFollowup: () => {},
    endInput: () => {},
    kill: () => {},
    waitForExit: async () =>
      ({ status: 'completed', exitCode: 0, signal: null, durationMs: 0 }),
  } as unknown as Worker;
}

function register(
  reg: WorkerRegistry,
  args: {
    id: string;
    projectPath: string;
    status: WorkerStatus;
    lastEventAt?: string;
  },
): void {
  const record: WorkerRecord = {
    id: args.id,
    projectPath: args.projectPath,
    projectId: null,
    taskId: null,
    worktreePath: `${args.projectPath}/.symphony/worktrees/${args.id}`,
    role: 'implementer',
    featureIntent: 'test',
    taskDescription: 'test',
    autonomyTier: 1,
    dependsOn: [],
    status: args.status,
    createdAt: new Date().toISOString(),
    worker: stubWorker(args.id),
    buffer: new CircularBuffer<StreamEvent>(10),
    detach: () => {},
    ...(args.lastEventAt !== undefined ? { lastEventAt: args.lastEventAt } : {}),
  };
  reg.register(record);
}

function fakeWorktreeManager(statuses: Map<string, WorktreeStatus>): {
  status: (worktreePath: string) => Promise<WorktreeStatus>;
} {
  return {
    status: async (worktreePath: string) => {
      const hit = statuses.get(worktreePath);
      if (!hit) throw new Error(`no stub for ${worktreePath}`);
      return hit;
    },
  };
}

describe('global_status tool', () => {
  it('returns empty-state message when no workers or projects are registered', async () => {
    const projectStore = projectRegistryFromMap({});
    const workerRegistry = new WorkerRegistry();
    const worktreeManager = fakeWorktreeManager(new Map());
    const tool = makeGlobalStatusTool({
      projectStore,
      workerRegistry,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      worktreeManager: worktreeManager as any,
    });
    const r = await tool.handler({ uncommitted: undefined }, ctx());
    expect(r.content[0]?.text).toMatch(/^0 worker\(s\) across 0 project\(s\); 0 active\./);
  });

  it('aggregates active/completed/failed per project', async () => {
    const projectStore = projectRegistryFromMap({
      alpha: 'C:/projects/alpha',
      beta: 'C:/projects/beta',
    });
    const workerRegistry = new WorkerRegistry();
    register(workerRegistry, { id: 'wk-a1', projectPath: 'C:/projects/alpha', status: 'running' });
    register(workerRegistry, {
      id: 'wk-a2',
      projectPath: 'C:/projects/alpha',
      status: 'completed',
    });
    register(workerRegistry, { id: 'wk-a3', projectPath: 'C:/projects/alpha', status: 'failed' });
    register(workerRegistry, { id: 'wk-b1', projectPath: 'C:/projects/beta', status: 'spawning' });
    const worktreeManager = fakeWorktreeManager(new Map());
    const tool = makeGlobalStatusTool({
      projectStore,
      workerRegistry,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      worktreeManager: worktreeManager as any,
    });
    const r = await tool.handler({ uncommitted: undefined }, ctx());
    const sc = r.structuredContent as {
      totals: { projects: number; workers: number; active: number };
      projects: Array<{ project: string; active: number; completed: number; failed: number }>;
    };
    expect(sc.totals).toEqual({ projects: 2, workers: 4, active: 2 });
    const alpha = sc.projects.find((p) => p.project === 'alpha')!;
    expect(alpha).toMatchObject({ active: 1, completed: 1, failed: 1 });
    const beta = sc.projects.find((p) => p.project === 'beta')!;
    expect(beta).toMatchObject({ active: 1, completed: 0, failed: 0 });
  });

  it('buckets killed / timeout / crashed under failed', async () => {
    const projectStore = projectRegistryFromMap({ alpha: 'C:/projects/alpha' });
    const workerRegistry = new WorkerRegistry();
    register(workerRegistry, { id: 'wk-k', projectPath: 'C:/projects/alpha', status: 'killed' });
    register(workerRegistry, { id: 'wk-t', projectPath: 'C:/projects/alpha', status: 'timeout' });
    register(workerRegistry, {
      id: 'wk-c',
      projectPath: 'C:/projects/alpha',
      status: 'crashed',
    });
    const tool = makeGlobalStatusTool({
      projectStore,
      workerRegistry,
      worktreeManager: fakeWorktreeManager(new Map()) as unknown as WorktreeManager,
    });
    const r = await tool.handler({ uncommitted: undefined }, ctx());
    const sc = r.structuredContent as {
      projects: Array<{ project: string; failed: number }>;
    };
    expect(sc.projects[0]!.failed).toBe(3);
  });

  it('surfaces unregistered project paths under (unregistered)', async () => {
    const projectStore = projectRegistryFromMap({});
    const workerRegistry = new WorkerRegistry();
    register(workerRegistry, { id: 'wk-1', projectPath: '/unknown', status: 'running' });
    const tool = makeGlobalStatusTool({
      projectStore,
      workerRegistry,
      worktreeManager: fakeWorktreeManager(new Map()) as unknown as WorktreeManager,
    });
    const r = await tool.handler({ uncommitted: undefined }, ctx());
    const sc = r.structuredContent as {
      projects: Array<{ project: string; active: number }>;
    };
    expect(sc.projects[0]!.project).toBe('(unregistered)');
  });

  it('omits last_event_at when no events have flowed', async () => {
    const projectStore = projectRegistryFromMap({ alpha: 'C:/projects/alpha' });
    const workerRegistry = new WorkerRegistry();
    register(workerRegistry, { id: 'wk-a1', projectPath: 'C:/projects/alpha', status: 'running' });
    const tool = makeGlobalStatusTool({
      projectStore,
      workerRegistry,
      worktreeManager: fakeWorktreeManager(new Map()) as unknown as WorktreeManager,
    });
    const r = await tool.handler({ uncommitted: undefined }, ctx());
    const sc = r.structuredContent as {
      projects: Array<{ last_event_at?: string }>;
    };
    expect('last_event_at' in sc.projects[0]!).toBe(false);
  });

  it('aggregates lastEventAt (max across workers)', async () => {
    const projectStore = projectRegistryFromMap({ alpha: 'C:/projects/alpha' });
    const workerRegistry = new WorkerRegistry();
    register(workerRegistry, {
      id: 'wk-a1',
      projectPath: 'C:/projects/alpha',
      status: 'running',
      lastEventAt: '2026-04-23T10:00:00.000Z',
    });
    register(workerRegistry, {
      id: 'wk-a2',
      projectPath: 'C:/projects/alpha',
      status: 'completed',
      lastEventAt: '2026-04-23T12:00:00.000Z',
    });
    const tool = makeGlobalStatusTool({
      projectStore,
      workerRegistry,
      worktreeManager: fakeWorktreeManager(new Map()) as unknown as WorktreeManager,
    });
    const r = await tool.handler({ uncommitted: undefined }, ctx());
    const sc = r.structuredContent as {
      projects: Array<{ last_event_at?: string }>;
    };
    expect(sc.projects[0]!.last_event_at).toBe('2026-04-23T12:00:00.000Z');
  });

  it('uncommitted=true invokes worktreeManager.status for each active/completed worker', async () => {
    const projectStore = projectRegistryFromMap({ alpha: 'C:/projects/alpha' });
    const workerRegistry = new WorkerRegistry();
    register(workerRegistry, { id: 'wk-a1', projectPath: 'C:/projects/alpha', status: 'running' });
    register(workerRegistry, {
      id: 'wk-a2',
      projectPath: 'C:/projects/alpha',
      status: 'completed',
    });
    const stubStatuses = new Map<string, WorktreeStatus>([
      [
        'C:/projects/alpha/.symphony/worktrees/wk-a1',
        { hasChanges: true, staged: ['a'], unstaged: ['b'], untracked: [] },
      ],
      [
        'C:/projects/alpha/.symphony/worktrees/wk-a2',
        { hasChanges: false, staged: [], unstaged: [], untracked: [] },
      ],
    ]);
    const tool = makeGlobalStatusTool({
      projectStore,
      workerRegistry,
      worktreeManager: fakeWorktreeManager(stubStatuses) as unknown as WorktreeManager,
    });
    const r = await tool.handler({ uncommitted: true }, ctx());
    const sc = r.structuredContent as {
      uncommitted: Array<{
        worker_id: string;
        has_changes: boolean;
        staged: number;
        unstaged: number;
        untracked: number;
      }>;
    };
    expect(sc.uncommitted.length).toBe(2);
    const a1 = sc.uncommitted.find((u) => u.worker_id === 'wk-a1')!;
    expect(a1).toMatchObject({ has_changes: true, staged: 1, unstaged: 1, untracked: 0 });
  });

  it('skips uncommitted collection when not requested', async () => {
    const projectStore = projectRegistryFromMap({ alpha: 'C:/projects/alpha' });
    const workerRegistry = new WorkerRegistry();
    register(workerRegistry, { id: 'wk-a1', projectPath: 'C:/projects/alpha', status: 'running' });
    let statusCalls = 0;
    const tool = makeGlobalStatusTool({
      projectStore,
      workerRegistry,
      worktreeManager: {
        status: async () => {
          statusCalls += 1;
          return { hasChanges: false, staged: [], unstaged: [], untracked: [] };
        },
      } as unknown as WorktreeManager,
    });
    await tool.handler({ uncommitted: undefined }, ctx());
    expect(statusCalls).toBe(0);
  });

  it('tolerates individual status failures under uncommitted=true (partial results)', async () => {
    const projectStore = projectRegistryFromMap({ alpha: 'C:/projects/alpha' });
    const workerRegistry = new WorkerRegistry();
    register(workerRegistry, { id: 'wk-a1', projectPath: 'C:/projects/alpha', status: 'running' });
    register(workerRegistry, {
      id: 'wk-a2',
      projectPath: 'C:/projects/alpha',
      status: 'completed',
    });
    const tool = makeGlobalStatusTool({
      projectStore,
      workerRegistry,
      worktreeManager: {
        status: async (p: string) => {
          if (p.endsWith('wk-a1')) throw new Error('simulated git fail');
          return { hasChanges: false, staged: [], unstaged: [], untracked: [] };
        },
      } as unknown as WorktreeManager,
    });
    const r = await tool.handler({ uncommitted: true }, ctx());
    const sc = r.structuredContent as {
      uncommitted: Array<{ worker_id: string }>;
    };
    expect(sc.uncommitted.length).toBe(1);
    expect(sc.uncommitted[0]!.worker_id).toBe('wk-a2');
  });

  it('scope is both', () => {
    const projectStore = projectRegistryFromMap({});
    const workerRegistry = new WorkerRegistry();
    const tool = makeGlobalStatusTool({
      projectStore,
      workerRegistry,
      worktreeManager: fakeWorktreeManager(new Map()) as unknown as WorktreeManager,
    });
    expect(tool.scope).toBe('both');
  });
});
