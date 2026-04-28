import { describe, expect, it } from 'vitest';
import type { ToolHandlerReturn } from '../../../src/orchestrator/registry.js';
import { DEFAULT_DISPATCH_CONTEXT } from '../../../src/orchestrator/capabilities.js';
import type { DispatchContext } from '../../../src/orchestrator/types.js';
import { makeSpawnWorkerTool } from '../../../src/orchestrator/tools/spawn-worker.js';
import { makeListWorkersTool } from '../../../src/orchestrator/tools/list-workers.js';
import { makeGetWorkerOutputTool } from '../../../src/orchestrator/tools/get-worker-output.js';
import { makeSendToWorkerTool } from '../../../src/orchestrator/tools/send-to-worker.js';
import { makeKillWorkerTool } from '../../../src/orchestrator/tools/kill-worker.js';
import { makeResumeWorkerTool } from '../../../src/orchestrator/tools/resume-worker.js';
import { makeFindWorkerTool } from '../../../src/orchestrator/tools/find-worker.js';
import {
  CircularBuffer,
  WorkerRegistry,
  type WorkerRecord,
} from '../../../src/orchestrator/worker-registry.js';
import type { WorkerLifecycleHandle } from '../../../src/orchestrator/worker-lifecycle.js';
import type { StreamEvent, Worker } from '../../../src/workers/types.js';

function ctx(): DispatchContext {
  return { ...DEFAULT_DISPATCH_CONTEXT, mode: 'act' };
}

interface FakeWorkerOpts {
  id?: string;
  onFollowup?: (msg: string) => void;
  onKill?: () => void;
  throwOnFollowup?: Error;
}

function fakeWorker(opts: FakeWorkerOpts = {}): Worker {
  return {
    id: opts.id ?? 'wk-fake',
    sessionId: undefined,
    status: 'running',
    events: (async function* () {
      /* none */
    })(),
    sendFollowup: (text: string) => {
      if (opts.throwOnFollowup) throw opts.throwOnFollowup;
      opts.onFollowup?.(text);
    },
    endInput: () => {},
    kill: () => opts.onKill?.(),
    waitForExit: async () => ({
      status: 'completed',
      exitCode: 0,
      signal: null,
      durationMs: 0,
    }),
  };
}

function makeRecord(reg: WorkerRegistry, overrides: Partial<WorkerRecord> = {}): WorkerRecord {
  const record: WorkerRecord = {
    id: overrides.id ?? 'wk-1',
    projectPath: overrides.projectPath ?? '/proj',
    projectId: overrides.projectId ?? null,
    taskId: overrides.taskId ?? null,
    worktreePath: overrides.worktreePath ?? '/proj/.symphony/worktrees/wk-1',
    role: overrides.role ?? 'implementer',
    featureIntent: overrides.featureIntent ?? 'do-a-thing',
    taskDescription: overrides.taskDescription ?? 'Do a thing',
    autonomyTier: overrides.autonomyTier ?? 1,
    dependsOn: overrides.dependsOn ?? [],
    createdAt: overrides.createdAt ?? '2026-04-23T00:00:00.000Z',
    status: overrides.status ?? 'running',
    worker: overrides.worker ?? fakeWorker({ id: overrides.id ?? 'wk-1' }),
    buffer: overrides.buffer ?? new CircularBuffer<StreamEvent>(100),
    detach: overrides.detach ?? (() => {}),
    ...(overrides.sessionId !== undefined ? { sessionId: overrides.sessionId } : {}),
  };
  reg.register(record);
  return record;
}

function fakeLifecycle(): WorkerLifecycleHandle & {
  calls: { spawn: unknown[]; resume: unknown[]; cleanup: string[] };
} {
  const calls = { spawn: [] as unknown[], resume: [] as unknown[], cleanup: [] as string[] };
  return {
    calls,
    spawn: async () => {
      throw new Error('fakeLifecycle.spawn not configured');
    },
    resume: async () => {
      throw new Error('fakeLifecycle.resume not configured');
    },
    cleanup: (id) => {
      calls.cleanup.push(id);
    },
    shutdown: async () => {},
    recoverFromStore: () => ({ crashedIds: [] }),
    setOnEvent: () => {},
  };
}

async function invoke(
  tool: {
    handler: (args: never, ctx: DispatchContext) => Promise<ToolHandlerReturn> | ToolHandlerReturn;
  },
  args: Record<string, unknown>,
): Promise<ToolHandlerReturn> {
  return Promise.resolve(tool.handler(args as never, ctx()));
}

describe('spawn_worker tool', () => {
  it('delegates to lifecycle.spawn and resolves the default project path', async () => {
    const registry = new WorkerRegistry();
    const lc = fakeLifecycle();
    const resolved: string[] = [];
    lc.spawn = async (input) => {
      lc.calls.spawn.push(input);
      const record = makeRecord(registry, {
        id: 'wk-from-lc',
        projectPath: '/resolved',
        role: 'researcher',
        featureIntent: 'research-x',
        taskDescription: 'Research X',
      });
      return record;
    };
    const tool = makeSpawnWorkerTool({
      registry,
      lifecycle: lc,
      resolveProjectPath: (p) => {
        resolved.push(p ?? '<default>');
        return '/resolved';
      },
    });
    const result = await invoke(tool, {
      task_description: 'Research X',
      role: 'researcher',
    });
    expect(resolved).toEqual(['<default>']);
    expect(result.isError).toBeFalsy();
    const snap = result.structuredContent as { id: string; projectPath: string };
    expect(snap.id).toBe('wk-from-lc');
    expect(snap.projectPath).toBe('/resolved');
    expect(lc.calls.spawn[0]).toMatchObject({
      projectPath: '/resolved',
      taskDescription: 'Research X',
      role: 'researcher',
    });
  });

  it('passes model + autonomy_tier + depends_on through to the lifecycle', async () => {
    const registry = new WorkerRegistry();
    const lc = fakeLifecycle();
    lc.spawn = async (input) => {
      lc.calls.spawn.push(input);
      return makeRecord(registry, {
        id: 'wk-full',
        role: 'implementer',
        featureIntent: 'feat-x',
        taskDescription: 'do',
      });
    };
    const tool = makeSpawnWorkerTool({
      registry,
      lifecycle: lc,
      resolveProjectPath: () => '/proj',
    });
    await invoke(tool, {
      task_description: 'do',
      role: 'implementer',
      model: 'opus',
      depends_on: ['wk-a'],
      autonomy_tier: 2,
    });
    expect(lc.calls.spawn[0]).toMatchObject({
      model: 'opus',
      dependsOn: ['wk-a'],
      autonomyTier: 2,
    });
  });
});

describe('list_workers tool', () => {
  it('returns an empty summary when no workers are registered', async () => {
    const registry = new WorkerRegistry();
    const tool = makeListWorkersTool({ registry, resolveProjectPath: () => undefined });
    const res = await invoke(tool, {});
    expect(res.isError).toBeFalsy();
    expect(res.content[0]?.text).toMatch(/no workers/i);
    const sc = res.structuredContent as { workers: unknown[] };
    expect(sc.workers).toEqual([]);
  });

  it('lists all workers and filters by resolved project path', async () => {
    const registry = new WorkerRegistry();
    makeRecord(registry, { id: 'wk-a', projectPath: '/a', featureIntent: 'a-thing' });
    makeRecord(registry, { id: 'wk-b', projectPath: '/b', featureIntent: 'b-thing' });
    const tool = makeListWorkersTool({
      registry,
      resolveProjectPath: (p) => (p === 'alias-a' ? '/a' : p),
    });
    const all = await invoke(tool, {});
    const scAll = all.structuredContent as { workers: Array<{ id: string }> };
    expect(scAll.workers.map((w) => w.id).sort()).toEqual(['wk-a', 'wk-b']);

    const filtered = await invoke(tool, { project: 'alias-a' });
    const scFiltered = filtered.structuredContent as { workers: Array<{ id: string }> };
    expect(scFiltered.workers.map((w) => w.id)).toEqual(['wk-a']);
  });
});

describe('get_worker_output tool', () => {
  it('returns isError on unknown worker', async () => {
    const registry = new WorkerRegistry();
    const tool = makeGetWorkerOutputTool({ registry });
    const res = await invoke(tool, { worker_id: 'nope' });
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toMatch(/unknown worker/i);
  });

  it('tails the most recent N events with default of 50', async () => {
    const registry = new WorkerRegistry();
    const buffer = new CircularBuffer<StreamEvent>(100);
    for (let i = 0; i < 80; i++) {
      buffer.push({ type: 'assistant_text', text: `line ${i}` } as StreamEvent);
    }
    makeRecord(registry, { id: 'wk-o', buffer });
    const tool = makeGetWorkerOutputTool({ registry });
    const resDefault = await invoke(tool, { worker_id: 'wk-o' });
    const scDefault = resDefault.structuredContent as { returned: number; total: number };
    expect(scDefault.returned).toBe(50);
    expect(scDefault.total).toBe(80);
    const res3 = await invoke(tool, { worker_id: 'wk-o', lines: 3 });
    const sc3 = res3.structuredContent as { returned: number };
    expect(sc3.returned).toBe(3);
  });
});

describe('send_to_worker tool', () => {
  it('rejects unknown worker', async () => {
    const registry = new WorkerRegistry();
    const tool = makeSendToWorkerTool({ registry });
    const res = await invoke(tool, { worker_id: 'nope', message: 'hi' });
    expect(res.isError).toBe(true);
  });

  it('rejects non-running worker', async () => {
    const registry = new WorkerRegistry();
    makeRecord(registry, { id: 'wk-done', status: 'completed' });
    const tool = makeSendToWorkerTool({ registry });
    const res = await invoke(tool, { worker_id: 'wk-done', message: 'hi' });
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toMatch(/completed.*resume/);
  });

  it('forwards the message to a running worker', async () => {
    const registry = new WorkerRegistry();
    let received = '';
    const w = fakeWorker({
      id: 'wk-live',
      onFollowup: (t) => {
        received = t;
      },
    });
    makeRecord(registry, { id: 'wk-live', status: 'running', worker: w });
    const tool = makeSendToWorkerTool({ registry });
    const res = await invoke(tool, { worker_id: 'wk-live', message: 'hello' });
    expect(res.isError).toBeFalsy();
    expect(received).toBe('hello');
    const sc = res.structuredContent as { bytes: number };
    expect(sc.bytes).toBe(5);
  });

  it('reports worker.sendFollowup thrown errors as isError', async () => {
    const registry = new WorkerRegistry();
    const w = fakeWorker({
      id: 'wk-err',
      throwOnFollowup: new Error('stdin closed'),
    });
    makeRecord(registry, { id: 'wk-err', status: 'running', worker: w });
    const tool = makeSendToWorkerTool({ registry });
    const res = await invoke(tool, { worker_id: 'wk-err', message: 'hi' });
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toMatch(/stdin closed/);
  });
});

describe('kill_worker tool', () => {
  it('rejects unknown worker', async () => {
    const registry = new WorkerRegistry();
    const tool = makeKillWorkerTool({ registry });
    const res = await invoke(tool, { worker_id: 'nope' });
    expect(res.isError).toBe(true);
  });

  it('skips terminal workers without error', async () => {
    const registry = new WorkerRegistry();
    makeRecord(registry, { id: 'wk-dead', status: 'failed' });
    const tool = makeKillWorkerTool({ registry });
    const res = await invoke(tool, { worker_id: 'wk-dead' });
    expect(res.isError).toBeFalsy();
    const sc = res.structuredContent as { skipped?: boolean };
    expect(sc.skipped).toBe(true);
  });

  it('sends SIGTERM to a live worker and includes reason', async () => {
    const registry = new WorkerRegistry();
    let killed = 0;
    const w = fakeWorker({
      id: 'wk-go',
      onKill: () => {
        killed += 1;
      },
    });
    makeRecord(registry, { id: 'wk-go', status: 'running', worker: w });
    const tool = makeKillWorkerTool({ registry });
    const res = await invoke(tool, { worker_id: 'wk-go', reason: 'user-cancel' });
    expect(res.isError).toBeFalsy();
    expect(killed).toBe(1);
    const sc = res.structuredContent as { reason: string };
    expect(sc.reason).toBe('user-cancel');
  });
});

describe('resume_worker tool', () => {
  it('rejects unknown worker', async () => {
    const registry = new WorkerRegistry();
    const lc = fakeLifecycle();
    const tool = makeResumeWorkerTool({ registry, lifecycle: lc });
    const res = await invoke(tool, { worker_id: 'nope', message: 'continue' });
    expect(res.isError).toBe(true);
  });

  it('rejects running worker and suggests send_to_worker', async () => {
    const registry = new WorkerRegistry();
    makeRecord(registry, { id: 'wk-live', status: 'running' });
    const lc = fakeLifecycle();
    const tool = makeResumeWorkerTool({ registry, lifecycle: lc });
    const res = await invoke(tool, { worker_id: 'wk-live', message: 'more' });
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toMatch(/send_to_worker/);
  });

  it('delegates terminal resume to lifecycle.resume', async () => {
    const registry = new WorkerRegistry();
    const record = makeRecord(registry, {
      id: 'wk-done',
      status: 'completed',
      sessionId: 'sess-abc',
    });
    const lc = fakeLifecycle();
    lc.resume = async (input) => {
      lc.calls.resume.push(input);
      record.status = 'spawning';
      return record;
    };
    const tool = makeResumeWorkerTool({ registry, lifecycle: lc });
    const res = await invoke(tool, { worker_id: 'wk-done', message: 'continue' });
    expect(res.isError).toBeFalsy();
    expect(lc.calls.resume[0]).toMatchObject({ recordId: 'wk-done', message: 'continue' });
  });

  it('wraps lifecycle.resume errors as isError', async () => {
    const registry = new WorkerRegistry();
    makeRecord(registry, { id: 'wk-done', status: 'completed' });
    const lc = fakeLifecycle();
    lc.resume = async () => {
      throw new Error('boom');
    };
    const tool = makeResumeWorkerTool({ registry, lifecycle: lc });
    const res = await invoke(tool, { worker_id: 'wk-done', message: 'continue' });
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toMatch(/boom/);
  });
});

describe('find_worker tool', () => {
  it('returns empty matches list on no hit', async () => {
    const registry = new WorkerRegistry();
    makeRecord(registry, { id: 'wk-1', featureIntent: 'unrelated' });
    const tool = makeFindWorkerTool({ registry });
    const res = await invoke(tool, { description: 'xylophone' });
    expect(res.isError).toBeFalsy();
    const sc = res.structuredContent as { matches: unknown[] };
    expect(sc.matches).toEqual([]);
  });

  it('returns matches ordered by featureIntent substring', async () => {
    const registry = new WorkerRegistry();
    makeRecord(registry, { id: 'wk-a', featureIntent: 'liquid-glass-hero' });
    makeRecord(registry, { id: 'wk-b', featureIntent: 'auth-refactor' });
    const tool = makeFindWorkerTool({ registry });
    const res = await invoke(tool, { description: 'liquid' });
    const sc = res.structuredContent as { matches: Array<{ id: string; matchedBy: string }> };
    expect(sc.matches.length).toBe(1);
    expect(sc.matches[0]?.id).toBe('wk-a');
    expect(sc.matches[0]?.matchedBy).toBe('featureIntent');
  });
});
