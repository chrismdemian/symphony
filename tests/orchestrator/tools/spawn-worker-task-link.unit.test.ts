import { describe, expect, it } from 'vitest';
import type { ToolHandlerReturn } from '../../../src/orchestrator/registry.js';
import { DEFAULT_DISPATCH_CONTEXT } from '../../../src/orchestrator/capabilities.js';
import type { DispatchContext } from '../../../src/orchestrator/types.js';
import { makeSpawnWorkerTool } from '../../../src/orchestrator/tools/spawn-worker.js';
import {
  CircularBuffer,
  WorkerRegistry,
  type WorkerRecord,
} from '../../../src/orchestrator/worker-registry.js';
import type { WorkerLifecycleHandle } from '../../../src/orchestrator/worker-lifecycle.js';
import { TaskRegistry } from '../../../src/state/task-registry.js';
import type { StreamEvent, Worker } from '../../../src/workers/types.js';

/**
 * Phase 3P — spawn_worker task_id auto-link path.
 *
 * Three scenarios:
 *   1. task_id with all deps completed: spawn succeeds, task flips to
 *      in_progress, task.workerId stamped.
 *   2. task_id with unmet deps: rejects with TaskNotReadyError; lifecycle
 *      never called; task stays pending.
 *   3. task_id unknown: clean error, lifecycle never called.
 *
 * Plus edge cases: task already in_progress, task already completed,
 * missing taskStore (gate degrades gracefully).
 */

const ISO = '2026-05-13T00:00:00.000Z';

function ctx(): DispatchContext {
  return { ...DEFAULT_DISPATCH_CONTEXT, mode: 'act' };
}

function fakeWorker(id: string): Worker {
  return {
    id,
    sessionId: undefined,
    status: 'running',
    events: (async function* () {})(),
    sendFollowup: () => {},
    endInput: () => {},
    kill: () => {},
    waitForExit: async () => ({
      status: 'completed',
      exitCode: 0,
      signal: null,
      durationMs: 0,
    }),
  };
}

function makeRecord(reg: WorkerRegistry, id: string): WorkerRecord {
  const r: WorkerRecord = {
    id,
    projectPath: '/proj',
    projectId: null,
    taskId: null,
    worktreePath: `/proj/.symphony/worktrees/${id}`,
    role: 'implementer',
    featureIntent: 'do-it',
    taskDescription: 'do it',
    autonomyTier: 1,
    dependsOn: [],
    createdAt: ISO,
    status: 'running',
    worker: fakeWorker(id),
    buffer: new CircularBuffer<StreamEvent>(10),
    detach: () => {},
  };
  reg.register(r);
  return r;
}

function fakeLifecycle(spawnImpl: (input: unknown) => Promise<WorkerRecord>): WorkerLifecycleHandle & {
  spawnCalls: unknown[];
} {
  const calls: unknown[] = [];
  return {
    spawnCalls: calls,
    spawn: async (input) => {
      calls.push(input);
      return spawnImpl(input);
    },
    resume: async () => {
      throw new Error('not configured');
    },
    cleanup: () => {},
    shutdown: async () => {},
    recoverFromStore: () => ({ crashedIds: [] }),
    setOnEvent: () => {},
    getQueueSnapshot: () => ({ running: 0, capacity: Number.POSITIVE_INFINITY, pending: [] }),
    getTotalRunning: () => 0,
    listPendingGlobal: () => [],
    cancelQueued: () => ({ cancelled: false, reason: 'not in queue' }),
    reorderQueued: () => ({ moved: false, reason: 'not in queue' }),
  };
}

async function invoke(
  tool: ReturnType<typeof makeSpawnWorkerTool>,
  args: Record<string, unknown>,
): Promise<ToolHandlerReturn> {
  return Promise.resolve(tool.handler(args as never, ctx()));
}

describe('spawn_worker — task_id auto-link gate', () => {
  it('rejects with TaskNotReadyError shape when a dep is not completed', async () => {
    const registry = new WorkerRegistry();
    const taskStore = new TaskRegistry({ now: () => Date.parse(ISO) });
    const a = taskStore.create({ projectId: 'p1', description: 'A' });
    const b = taskStore.create({ projectId: 'p1', description: 'B', dependsOn: [a.id] });
    const lc = fakeLifecycle(async () => makeRecord(registry, 'wk-1'));
    const tool = makeSpawnWorkerTool({
      registry,
      lifecycle: lc,
      resolveProjectPath: () => '/proj',
      taskStore,
    });
    const res = await invoke(tool, {
      task_description: 'do B',
      role: 'implementer',
      task_id: b.id,
    });
    expect(res.isError).toBe(true);
    // Lifecycle was NOT called.
    expect(lc.spawnCalls).toHaveLength(0);
    // task_id stays pending.
    expect(taskStore.get(b.id)?.status).toBe('pending');
    // Structured error includes the blockers.
    const sc = res.structuredContent as { code: string; taskId: string; blockedBy: { id: string }[] };
    expect(sc.code).toBe('task-not-ready');
    expect(sc.taskId).toBe(b.id);
    expect(sc.blockedBy.map((x) => x.id)).toEqual([a.id]);
  });

  it('spawns + atomically flips task to in_progress + stamps workerId when ready', async () => {
    const registry = new WorkerRegistry();
    const taskStore = new TaskRegistry({ now: () => Date.parse(ISO) });
    const a = taskStore.create({ projectId: 'p1', description: 'A' });
    const b = taskStore.create({ projectId: 'p1', description: 'B', dependsOn: [a.id] });
    // Complete A so B is ready.
    taskStore.update(a.id, { status: 'in_progress' });
    taskStore.update(a.id, { status: 'completed' });
    const lc = fakeLifecycle(async () => makeRecord(registry, 'wk-spawned'));
    const tool = makeSpawnWorkerTool({
      registry,
      lifecycle: lc,
      resolveProjectPath: () => '/proj',
      taskStore,
    });
    const res = await invoke(tool, {
      task_description: 'do B',
      role: 'implementer',
      task_id: b.id,
    });
    expect(res.isError).toBeFalsy();
    expect(lc.spawnCalls).toHaveLength(1);
    // Lifecycle saw taskId in the input (so SQL persistence reflects the link).
    expect(lc.spawnCalls[0]).toMatchObject({ taskId: b.id });
    // Task auto-linked.
    const bAfter = taskStore.get(b.id)!;
    expect(bAfter.status).toBe('in_progress');
    expect(bAfter.workerId).toBe('wk-spawned');
  });

  it('rejects on unknown task_id', async () => {
    const registry = new WorkerRegistry();
    const taskStore = new TaskRegistry();
    const lc = fakeLifecycle(async () => makeRecord(registry, 'wk-1'));
    const tool = makeSpawnWorkerTool({
      registry,
      lifecycle: lc,
      resolveProjectPath: () => '/proj',
      taskStore,
    });
    const res = await invoke(tool, {
      task_description: 'do',
      role: 'implementer',
      task_id: 'tk-ghost',
    });
    expect(res.isError).toBe(true);
    expect(lc.spawnCalls).toHaveLength(0);
  });

  it('rejects when task is already in_progress', async () => {
    const registry = new WorkerRegistry();
    const taskStore = new TaskRegistry();
    const a = taskStore.create({ projectId: 'p1', description: 'A' });
    taskStore.update(a.id, { status: 'in_progress' });
    const lc = fakeLifecycle(async () => makeRecord(registry, 'wk-1'));
    const tool = makeSpawnWorkerTool({
      registry,
      lifecycle: lc,
      resolveProjectPath: () => '/proj',
      taskStore,
    });
    const res = await invoke(tool, {
      task_description: 'do',
      role: 'implementer',
      task_id: a.id,
    });
    expect(res.isError).toBe(true);
    expect(lc.spawnCalls).toHaveLength(0);
  });

  it('rejects when task is already completed', async () => {
    const registry = new WorkerRegistry();
    const taskStore = new TaskRegistry();
    const a = taskStore.create({ projectId: 'p1', description: 'A' });
    taskStore.update(a.id, { status: 'in_progress' });
    taskStore.update(a.id, { status: 'completed' });
    const lc = fakeLifecycle(async () => makeRecord(registry, 'wk-1'));
    const tool = makeSpawnWorkerTool({
      registry,
      lifecycle: lc,
      resolveProjectPath: () => '/proj',
      taskStore,
    });
    const res = await invoke(tool, {
      task_description: 'do',
      role: 'implementer',
      task_id: a.id,
    });
    expect(res.isError).toBe(true);
  });

  it('ignores task_id when no taskStore is wired (degrades gracefully)', async () => {
    const registry = new WorkerRegistry();
    const lc = fakeLifecycle(async () => makeRecord(registry, 'wk-1'));
    const tool = makeSpawnWorkerTool({
      registry,
      lifecycle: lc,
      resolveProjectPath: () => '/proj',
      // No taskStore — task_id should pass through without gating.
    });
    const res = await invoke(tool, {
      task_description: 'do',
      role: 'implementer',
      task_id: 'tk-anything',
    });
    expect(res.isError).toBeFalsy();
    // taskId still plumbed to lifecycle.
    expect(lc.spawnCalls[0]).toMatchObject({ taskId: 'tk-anything' });
  });

  it('spawns with no task_id and skips the gate entirely', async () => {
    const registry = new WorkerRegistry();
    const taskStore = new TaskRegistry();
    // Even with a taskStore wired, omitting task_id skips the gate.
    const lc = fakeLifecycle(async () => makeRecord(registry, 'wk-1'));
    const tool = makeSpawnWorkerTool({
      registry,
      lifecycle: lc,
      resolveProjectPath: () => '/proj',
      taskStore,
    });
    const res = await invoke(tool, {
      task_description: 'do',
      role: 'implementer',
    });
    expect(res.isError).toBeFalsy();
    expect(lc.spawnCalls).toHaveLength(1);
    // No taskId in the lifecycle input.
    const input = lc.spawnCalls[0] as { taskId?: string };
    expect(input.taskId).toBeUndefined();
  });
});
