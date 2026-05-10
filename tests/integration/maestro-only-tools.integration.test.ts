import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ProjectRegistry,
  startOrchestratorServer,
  type OrchestratorServerHandle,
} from '../../src/orchestrator/index.js';
import {
  CircularBuffer,
  WorkerRegistry,
  type WorkerRecord,
} from '../../src/orchestrator/worker-registry.js';
import type {
  SpawnWorkerInput,
  WorkerLifecycleHandle,
} from '../../src/orchestrator/worker-lifecycle.js';
import type { WorktreeManager } from '../../src/worktree/manager.js';
import type { WorkerManager } from '../../src/workers/manager.js';
import type { StreamEvent, Worker } from '../../src/workers/types.js';
import type { OneShotRunner } from '../../src/orchestrator/one-shot.js';

/**
 * Integration harness for Phase 2A.4a Maestro-only tools. Covers
 * `ask_user`, `review_diff`, `research_wave`, and `global_status` end to
 * end through a real `InMemoryTransport` MCP client pair. Git and
 * subprocess concerns are stubbed; the point is to assert dispatch,
 * mode-gating, structured shapes, and error responses for the four new
 * tools.
 */

function fakeWorkerManager(): WorkerManager {
  return {
    spawn: async () => {
      throw new Error('no direct spawn expected in this suite');
    },
    list: () => [],
    get: () => undefined,
    shutdown: async () => {},
  } as unknown as WorkerManager;
}

function fakeWorktreeManager(): WorktreeManager {
  return {
    create: async () => {
      throw new Error('no direct create expected in this suite');
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

function makeFakeLifecycle(workerRegistry: WorkerRegistry): WorkerLifecycleHandle {
  let counter = 0;
  return {
    spawn: async (input: SpawnWorkerInput) => {
      counter += 1;
      const id = `wk-fake-${counter}`;
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
      workerRegistry.register(record);
      return record;
    },
    resume: async () => {
      throw new Error('not used in 2A.4a integration');
    },
    cleanup: (id: string) => {
      workerRegistry.remove(id);
    },
    shutdown: async () => {
      workerRegistry.clear();
    },
    recoverFromStore: () => ({ crashedIds: [] }),
    setOnEvent: () => {},
    getQueueSnapshot: () => ({ running: 0, capacity: Number.POSITIVE_INFINITY, pending: [] }),
    getTotalRunning: () => 0,
    listPendingGlobal: () => [],
    cancelQueued: () => ({ cancelled: false, reason: 'not in queue' }),
    reorderQueued: () => ({ moved: false, reason: 'not in queue' }),
  };
}

interface Harness {
  client: Client;
  server: OrchestratorServerHandle;
}

function fakeOneShot(text: string): OneShotRunner {
  return async () => ({
    rawStdout: JSON.stringify({ result: text, session_id: 'sess' }),
    text,
    sessionId: 'sess',
    exitCode: 0,
    signaled: false,
    durationMs: 1,
    stderrTail: '',
  });
}

async function makeHarness(opts: {
  mode?: 'plan' | 'act';
  tier?: 1 | 2 | 3;
  oneShotRunner?: OneShotRunner;
} = {}): Promise<Harness> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const projectStore = new ProjectRegistry();
  projectStore.register({
    id: 'alpha',
    name: 'alpha',
    path: '/repos/alpha',
    createdAt: '',
  });
  const workerRegistry = new WorkerRegistry();
  const server = await startOrchestratorServer({
    transport: serverTransport,
    initialMode: opts.mode ?? 'act',
    initialTier: opts.tier,
    defaultProjectPath: '/repos/alpha',
    workerManager: fakeWorkerManager(),
    worktreeManager: fakeWorktreeManager(),
    workerRegistry,
    workerLifecycle: makeFakeLifecycle(workerRegistry),
    projectStore,
    ...(opts.oneShotRunner !== undefined
      ? { oneShotRunner: opts.oneShotRunner }
      : { oneShotRunner: fakeOneShot('{}') }),
  });
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(clientTransport);
  return { client, server };
}

describe('Maestro-only MCP tools (2A.4a integration)', () => {
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

  async function connect(opts: {
    mode?: 'plan' | 'act';
    tier?: 1 | 2 | 3;
    oneShotRunner?: OneShotRunner;
  } = {}) {
    const pair = await makeHarness(opts);
    handles.push(pair.server);
    clients.push(pair.client);
    return pair;
  }

  it('exposes the 4 new tools per mode', async () => {
    for (const mode of ['plan', 'act'] as const) {
      const { client } = await connect({ mode });
      const list = await client.listTools();
      const names = list.tools.map((t) => t.name);
      expect(names).toContain('ask_user');
      expect(names).toContain('research_wave');
      expect(names).toContain('global_status');
      if (mode === 'act') {
        expect(names).toContain('review_diff');
        expect(names).toContain('audit_changes');
        expect(names).toContain('finalize');
      } else {
        expect(names).not.toContain('review_diff');
        expect(names).not.toContain('audit_changes');
        expect(names).not.toContain('finalize');
      }
    }
  });

  it('ask_user: enqueues a question', async () => {
    const { client, server } = await connect();
    const res = await client.callTool({
      name: 'ask_user',
      arguments: { question: 'ship it?' },
    });
    expect(res.isError).toBeUndefined();
    const sc = res.structuredContent as { id: string; urgency: string; answered: boolean };
    expect(sc).toMatchObject({ urgency: 'blocking', answered: false });
    expect(sc.id).toMatch(/^q-/);
    expect(server.questionStore.size()).toBe(1);
  });

  it('ask_user: records advisory urgency + context + project + worker_id', async () => {
    const { client, server } = await connect();
    const res = await client.callTool({
      name: 'ask_user',
      arguments: {
        question: 'naming?',
        context: 'see README:5',
        project: 'alpha',
        worker_id: 'wk-1',
        urgency: 'advisory',
      },
    });
    expect(res.isError).toBeUndefined();
    const record = server.questionStore.list()[0]!;
    expect(record.urgency).toBe('advisory');
    expect(record.context).toBe('see README:5');
    expect(record.projectId).toBe('alpha');
    expect(record.workerId).toBe('wk-1');
  });

  it('ask_user: isError on unknown project', async () => {
    const { client } = await connect();
    const res = await client.callTool({
      name: 'ask_user',
      arguments: { question: 'x', project: 'ghost' },
    });
    expect(res.isError).toBe(true);
  });

  it('review_diff: unknown worker → isError', async () => {
    const { client } = await connect({ mode: 'act' });
    const res = await client.callTool({
      name: 'review_diff',
      arguments: { worker_id: 'wk-ghost' },
    });
    expect(res.isError).toBe(true);
  });

  it('review_diff: rejected in plan mode (scope=act)', async () => {
    const { client } = await connect({ mode: 'plan' });
    const res = await client.callTool({
      name: 'review_diff',
      arguments: { worker_id: 'wk-anything' },
    });
    // SDK rejects disabled-in-mode tools before the dispatch shim fires.
    expect(res.isError).toBe(true);
  });

  it('research_wave: spawns N researchers and records a wave', async () => {
    const { client, server } = await connect();
    const res = await client.callTool({
      name: 'research_wave',
      arguments: { topic: 'pnpm workspaces vs turborepo', n: 3 },
    });
    expect(res.isError).toBeUndefined();
    const sc = res.structuredContent as {
      wave: { id: string; size: number };
      spawned: number;
      requested: number;
    };
    expect(sc.spawned).toBe(3);
    expect(sc.requested).toBe(3);
    expect(sc.wave.size).toBe(3);
    expect(server.waveStore.size()).toBe(1);
  });

  it('research_wave: rejects n outside [2, 7]', async () => {
    const { client } = await connect();
    const tooSmall = await client.callTool({
      name: 'research_wave',
      arguments: { topic: 'x', n: 1 },
    });
    expect(tooSmall.isError).toBe(true);
    const tooBig = await client.callTool({
      name: 'research_wave',
      arguments: { topic: 'x', n: 8 },
    });
    expect(tooBig.isError).toBe(true);
  });

  it('research_wave: agenda length must equal n', async () => {
    const { client } = await connect();
    const res = await client.callTool({
      name: 'research_wave',
      arguments: { topic: 'x', n: 3, agenda: ['a', 'b'] },
    });
    expect(res.isError).toBe(true);
  });

  it('global_status: empty-state reports zero counts', async () => {
    const { client } = await connect();
    const res = await client.callTool({
      name: 'global_status',
      arguments: {},
    });
    const sc = res.structuredContent as {
      totals: { projects: number; workers: number; active: number };
    };
    expect(sc.totals).toEqual({ projects: 1, workers: 0, active: 0 });
  });

  it('global_status: counts a spawned worker via research_wave', async () => {
    const { client } = await connect();
    await client.callTool({
      name: 'research_wave',
      arguments: { topic: 'x', n: 2 },
    });
    const res = await client.callTool({
      name: 'global_status',
      arguments: {},
    });
    const sc = res.structuredContent as {
      totals: { workers: number; active: number };
      projects: Array<{ project: string; active: number; total: number }>;
    };
    expect(sc.totals.workers).toBe(2);
    expect(sc.totals.active).toBe(2);
    const alpha = sc.projects.find((p) => p.project === 'alpha')!;
    expect(alpha.total).toBe(2);
    expect(alpha.active).toBe(2);
  });

  it('ask_user, research_wave, global_status all work in plan mode', async () => {
    const { client } = await connect({ mode: 'plan' });
    const ask = await client.callTool({
      name: 'ask_user',
      arguments: { question: 'plan-mode ask' },
    });
    expect(ask.isError).toBeUndefined();
    const wave = await client.callTool({
      name: 'research_wave',
      arguments: { topic: 'plan-mode', n: 2 },
    });
    expect(wave.isError).toBeUndefined();
    const status = await client.callTool({
      name: 'global_status',
      arguments: {},
    });
    expect(status.isError).toBeUndefined();
  });

  it('audit_changes + finalize are refused in plan mode', async () => {
    const { client } = await connect({ mode: 'plan' });
    const audit = await client.callTool({
      name: 'audit_changes',
      arguments: { worker_id: 'wk' },
    });
    expect(audit.isError).toBe(true);
    const finalize = await client.callTool({
      name: 'finalize',
      arguments: { worker_id: 'wk' },
    });
    expect(finalize.isError).toBe(true);
  });

  it('audit_changes: unknown worker id → isError', async () => {
    const { client } = await connect({ mode: 'act' });
    const res = await client.callTool({
      name: 'audit_changes',
      arguments: { worker_id: 'wk-nope' },
    });
    expect(res.isError).toBe(true);
  });

  it('finalize: tier 1 → denied by external-visible capability', async () => {
    const { client } = await connect({ mode: 'act', tier: 1 });
    const res = await client.callTool({
      name: 'finalize',
      arguments: { worker_id: 'wk-any' },
    });
    expect(res.isError).toBe(true);
    const txt = (res.content as Array<{ text: string }>)[0]?.text ?? '';
    expect(txt).toMatch(/external-visible|capability/i);
  });

  it('finalize: tier 2 allows push but tier 3 required for merge_to', async () => {
    const { client, server } = await connect({ mode: 'act', tier: 2 });
    // Spawn a real worker so we pass the unknown-worker gate and hit the tier gate.
    await client.callTool({
      name: 'spawn_worker',
      arguments: {
        role: 'implementer',
        feature_intent: 'merge-test',
        task_description: 'merge-test',
      },
    });
    const wid = server.workerRegistry.list()[0]?.id ?? 'missing';
    const res = await client.callTool({
      name: 'finalize',
      arguments: { worker_id: wid, merge_to: 'master' },
    });
    expect(res.isError).toBe(true);
    const txt = (res.content as Array<{ text: string }>)[0]?.text ?? '';
    expect(txt).toMatch(/tier 3/);
  });

  it('finalize: unknown worker id → isError regardless of tier', async () => {
    const { client } = await connect({ mode: 'act', tier: 3 });
    const res = await client.callTool({
      name: 'finalize',
      arguments: { worker_id: 'wk-nope' },
    });
    expect(res.isError).toBe(true);
    const txt = (res.content as Array<{ text: string }>)[0]?.text ?? '';
    expect(txt).toMatch(/Unknown worker/);
  });
});
