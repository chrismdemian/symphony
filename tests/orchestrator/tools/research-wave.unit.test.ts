import { describe, expect, it } from 'vitest';
import {
  RESEARCH_WAVE_MAX,
  RESEARCH_WAVE_MIN,
  makeResearchWaveTool,
} from '../../../src/orchestrator/tools/research-wave.js';
import { WaveRegistry } from '../../../src/orchestrator/research-wave-registry.js';
import { projectRegistryFromMap } from '../../../src/projects/registry.js';
import {
  CircularBuffer,
  WorkerRegistry,
  type WorkerRecord,
} from '../../../src/orchestrator/worker-registry.js';
import type { DispatchContext } from '../../../src/orchestrator/types.js';
import type {
  SpawnWorkerInput,
  WorkerLifecycleHandle,
} from '../../../src/orchestrator/worker-lifecycle.js';
import type { StreamEvent, Worker } from '../../../src/workers/types.js';

function ctx(overrides: Partial<DispatchContext> = {}): DispatchContext {
  return {
    mode: 'plan',
    tier: 1,
    awayMode: false,
    automationContext: false,
    ...overrides,
  };
}

interface TrackingWorker extends Worker {
  killed: boolean;
}

function stubWorker(id: string): TrackingWorker {
  const stub: TrackingWorker = {
    id,
    sessionId: undefined,
    status: 'spawning',
    events: (async function* () {})(),
    sendFollowup: () => {},
    endInput: () => {},
    kill: () => {
      stub.killed = true;
    },
    waitForExit: async () =>
      ({ status: 'completed', exitCode: 0, signal: null, durationMs: 0 }),
    killed: false,
  } as unknown as TrackingWorker;
  return stub;
}

function makeFakeLifecycle(registry: WorkerRegistry): {
  lifecycle: WorkerLifecycleHandle;
  spawnCalls: SpawnWorkerInput[];
  failNext: (msg: string) => void;
} {
  const spawnCalls: SpawnWorkerInput[] = [];
  let nextFail: string | null = null;
  const lifecycle: WorkerLifecycleHandle = {
    spawn: async (input) => {
      spawnCalls.push(input);
      if (nextFail !== null) {
        const msg = nextFail;
        nextFail = null;
        throw new Error(msg);
      }
      const id = `wk-${spawnCalls.length}`;
      const record: WorkerRecord = {
        id,
        projectPath: input.projectPath,
        projectId: input.projectId ?? null,
        taskId: input.taskId ?? null,
        worktreePath: `${input.projectPath}/.symphony/worktrees/${id}`,
        role: input.role,
        featureIntent: input.featureIntent ?? 'fake',
        taskDescription: input.taskDescription,
        autonomyTier: input.autonomyTier ?? 1,
        dependsOn: input.dependsOn ?? [],
        status: 'spawning',
        createdAt: new Date().toISOString(),
        worker: stubWorker(id),
        buffer: new CircularBuffer<StreamEvent>(10),
        detach: () => {},
      };
      registry.register(record);
      return record;
    },
    resume: async () => {
      throw new Error('not used in research_wave tests');
    },
    cleanup: (id: string) => {
      registry.remove(id);
    },
    shutdown: async () => {},
    recoverFromStore: () => ({ crashedIds: [] }),
  };
  return {
    lifecycle,
    spawnCalls,
    failNext: (msg: string) => {
      nextFail = msg;
    },
  };
}

function deps() {
  const registry = new WorkerRegistry();
  const fake = makeFakeLifecycle(registry);
  const waveStore = new WaveRegistry();
  const projectStore = projectRegistryFromMap({
    alpha: 'C:/projects/alpha',
  });
  const resolveProjectPath = (project?: string): string =>
    project !== undefined ? `/projects/${project}` : '/projects/default';
  const tool = makeResearchWaveTool({
    registry,
    lifecycle: fake.lifecycle,
    waveStore,
    projectStore,
    resolveProjectPath,
  });
  return { tool, fake, waveStore, registry, projectStore };
}

const BASE = {
  project: undefined as string | undefined,
  agenda: undefined as string[] | undefined,
  model: undefined as string | undefined,
};

describe('research_wave tool', () => {
  it('spawns N researchers and registers a wave', async () => {
    const { tool, fake, waveStore } = deps();
    const r = await tool.handler({ ...BASE, topic: 'pnpm workspaces', n: 3 }, ctx());
    expect(r.isError).toBeUndefined();
    expect(fake.spawnCalls.length).toBe(3);
    expect(fake.spawnCalls.every((call) => call.role === 'researcher')).toBe(true);
    expect(waveStore.size()).toBe(1);
    const waves = waveStore.list();
    expect(waves[0]!.workerIds).toEqual(['wk-1', 'wk-2', 'wk-3']);
  });

  it('uses shared topic when agenda is absent', async () => {
    const { tool, fake } = deps();
    await tool.handler({ ...BASE, topic: 'linting', n: 2 }, ctx());
    expect(fake.spawnCalls[0]!.taskDescription).toContain('linting');
    expect(fake.spawnCalls[1]!.taskDescription).toContain('linting');
  });

  it('assigns sub-topics from agenda to each worker', async () => {
    const { tool, fake } = deps();
    await tool.handler(
      {
        ...BASE,
        topic: 'linting',
        n: 3,
        agenda: ['eslint', 'biome', 'prettier'],
      },
      ctx(),
    );
    expect(fake.spawnCalls[0]!.taskDescription).toContain('Your sub-topic (1/3): eslint');
    expect(fake.spawnCalls[1]!.taskDescription).toContain('Your sub-topic (2/3): biome');
    expect(fake.spawnCalls[2]!.taskDescription).toContain('Your sub-topic (3/3): prettier');
    // shared wave topic still present
    expect(fake.spawnCalls[0]!.taskDescription).toContain('Shared wave topic: linting');
  });

  it('rejects when agenda length != n', async () => {
    const { tool, fake } = deps();
    const r = await tool.handler(
      {
        ...BASE,
        topic: 'linting',
        n: 3,
        agenda: ['eslint', 'biome'],
      },
      ctx(),
    );
    expect(r.isError).toBe(true);
    expect(r.content[0]?.text).toMatch(/agenda length.*must equal n/);
    expect(fake.spawnCalls.length).toBe(0);
  });

  it('partial success: one spawn fails, rest succeed, wave records survivors', async () => {
    const { tool, fake, waveStore } = deps();
    // fail the second spawn
    const spawnSpy = fake.lifecycle.spawn;
    let callIdx = 0;
    fake.lifecycle.spawn = async (input) => {
      callIdx += 1;
      if (callIdx === 2) throw new Error('simulated spawn failure');
      return spawnSpy(input);
    };
    const r = await tool.handler({ ...BASE, topic: 'x', n: 3 }, ctx());
    expect(r.isError).toBeUndefined();
    const snap = waveStore.list()[0]!;
    expect(snap.workerIds.length).toBe(2);
    expect(r.structuredContent?.failures).toBeDefined();
    expect(r.structuredContent?.spawned).toBe(2);
  });

  it('total failure: all spawns fail → isError', async () => {
    const { tool, fake } = deps();
    fake.lifecycle.spawn = async () => {
      throw new Error('always fail');
    };
    const r = await tool.handler({ ...BASE, topic: 'x', n: 2 }, ctx());
    expect(r.isError).toBe(true);
    expect(r.content[0]?.text).toMatch(/all 2 spawns failed/);
  });

  it('propagates the dispatch signal into every spawn', async () => {
    const { tool, fake } = deps();
    const controller = new AbortController();
    await tool.handler({ ...BASE, topic: 'x', n: 2 }, ctx({ signal: controller.signal }));
    expect(fake.spawnCalls[0]!.signal).toBe(controller.signal);
    expect(fake.spawnCalls[1]!.signal).toBe(controller.signal);
  });

  it('forwards an explicit model override to every worker', async () => {
    const { tool, fake } = deps();
    await tool.handler(
      { ...BASE, topic: 'x', n: 2, model: 'claude-haiku-4-5-20251001' },
      ctx(),
    );
    expect(fake.spawnCalls.every((c) => c.model === 'claude-haiku-4-5-20251001')).toBe(true);
  });

  it('scope is both (PLAN-mode decomposition can fan out research)', () => {
    const { tool } = deps();
    expect(tool.scope).toBe('both');
  });

  it('exposes RESEARCH_WAVE_MIN = 2 and RESEARCH_WAVE_MAX = 7', () => {
    expect(RESEARCH_WAVE_MIN).toBe(2);
    expect(RESEARCH_WAVE_MAX).toBe(7);
  });

  it('resolves project name to canonical projectId for WaveStore (audit M2)', async () => {
    const { tool, waveStore, projectStore } = deps();
    await tool.handler({ ...BASE, topic: 'x', n: 2, project: 'alpha' }, ctx());
    const wave = waveStore.list()[0]!;
    expect(wave.projectId).toBe(projectStore.get('alpha')!.id);
  });

  it('rejects unknown named projects with isError (audit M2, matches ask_user)', async () => {
    const { tool, fake } = deps();
    const r = await tool.handler({ ...BASE, topic: 'x', n: 2, project: 'ghost' }, ctx());
    expect(r.isError).toBe(true);
    expect(r.content[0]?.text).toMatch(/Unknown project 'ghost'/);
    expect(fake.spawnCalls.length).toBe(0);
  });

  it('accepts an absolute path for unregistered projects but does not persist as projectId (audit M2)', async () => {
    const { tool, waveStore } = deps();
    // Windows and POSIX absolute paths both qualify under path.isAbsolute.
    const absPath = process.platform === 'win32' ? 'C:/other/proj' : '/other/proj';
    const r = await tool.handler({ ...BASE, topic: 'x', n: 2, project: absPath }, ctx());
    expect(r.isError).toBeUndefined();
    const wave = waveStore.list()[0]!;
    expect(wave.projectId).toBeUndefined();
  });

  it('rolls back successful spawns when dispatch signal aborts mid-fan-out (audit M3)', async () => {
    const { tool, fake, waveStore, registry } = deps();
    const controller = new AbortController();
    const origSpawn = fake.lifecycle.spawn;
    let callIdx = 0;
    fake.lifecycle.spawn = async (input) => {
      callIdx += 1;
      if (callIdx === 2) {
        controller.abort();
        throw new Error('AbortError');
      }
      return origSpawn(input);
    };
    const r = await tool.handler(
      { ...BASE, topic: 'x', n: 3 },
      ctx({ signal: controller.signal }),
    );
    expect(r.isError).toBe(true);
    expect(r.content[0]?.text).toMatch(/rolled back/);
    // No orphans in the registry.
    expect(registry.list().length).toBe(0);
    // No wave record was persisted.
    expect(waveStore.size()).toBe(0);
  });
});
