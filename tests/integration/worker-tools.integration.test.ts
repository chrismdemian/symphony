import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createWorkerLifecycle,
  startOrchestratorServer,
  WorkerRegistry,
  type OrchestratorServerHandle,
} from '../../src/orchestrator/index.js';
import type { WorkerManager } from '../../src/workers/manager.js';
import type {
  StreamEvent,
  Worker,
  WorkerConfig,
  WorkerExitInfo,
} from '../../src/workers/types.js';
import type { WorktreeManager } from '../../src/worktree/manager.js';
import type { CreateWorktreeOptions, WorktreeInfo } from '../../src/worktree/types.js';

class FakeWorker implements Worker {
  readonly id: string;
  sessionId: string | undefined = undefined;
  status: Worker['status'] = 'running';
  followups: string[] = [];
  killed = false;
  private readonly exitPromise: Promise<WorkerExitInfo>;
  private resolveExit!: (info: WorkerExitInfo) => void;
  readonly events: AsyncIterable<StreamEvent>;

  constructor(id: string) {
    this.id = id;
    this.exitPromise = new Promise<WorkerExitInfo>((resolve) => {
      this.resolveExit = resolve;
    });
    // Emit a single system_init so the real lifecycle's event tap flips
    // registry status from 'spawning' → 'running'. Matches the first event
    // `claude -p` emits on boot.
    const sessionId = `fake-session-${id}`;
    this.events = (async function* (): AsyncGenerator<StreamEvent> {
      yield {
        type: 'system_init',
        sessionId,
        model: 'fake',
      };
    })();
  }

  sendFollowup(text: string): void {
    this.followups.push(text);
  }

  endInput(): void {
    /* no-op */
  }

  kill(): void {
    if (this.killed) return;
    this.killed = true;
    this.status = 'killed';
    this.resolveExit({
      status: 'killed',
      exitCode: null,
      signal: 'SIGTERM',
      durationMs: 0,
    });
  }

  complete(info: WorkerExitInfo): void {
    this.status = info.status;
    this.resolveExit(info);
  }

  waitForExit(): Promise<WorkerExitInfo> {
    return this.exitPromise;
  }
}

interface FakePrimitives {
  workerManager: WorkerManager;
  worktreeManager: WorktreeManager;
  spawned: FakeWorker[];
  spawnCalls: WorkerConfig[];
  createCalls: CreateWorktreeOptions[];
}

function makeFakePrimitives(): FakePrimitives {
  const spawned: FakeWorker[] = [];
  const spawnCalls: WorkerConfig[] = [];
  const createCalls: CreateWorktreeOptions[] = [];
  const workerManager = {
    spawn: async (cfg: WorkerConfig): Promise<Worker> => {
      spawnCalls.push(cfg);
      const w = new FakeWorker(cfg.id);
      spawned.push(w);
      return w;
    },
    list: () => [],
    get: () => undefined,
    shutdown: async () => {
      for (const w of spawned) if (!w.killed) w.kill();
    },
  } as unknown as WorkerManager;
  const worktreeManager = {
    create: async (opts: CreateWorktreeOptions): Promise<WorktreeInfo> => {
      createCalls.push(opts);
      return {
        id: opts.workerId,
        path: `/fake/${opts.workerId}`,
        branch: `symphony/${opts.workerId}`,
        baseRef: 'refs/heads/main',
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
  return { workerManager, worktreeManager, spawned, spawnCalls, createCalls };
}

async function makePair(opts: { mode?: 'plan' | 'act' } = {}): Promise<{
  client: Client;
  server: OrchestratorServerHandle;
  prims: FakePrimitives;
}> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const prims = makeFakePrimitives();
  const registry = new WorkerRegistry();
  const lifecycle = createWorkerLifecycle({
    registry,
    workerManager: prims.workerManager,
    worktreeManager: prims.worktreeManager,
    idGenerator: (() => {
      let i = 0;
      return () => `wk-fake-${++i}`;
    })(),
  });
  const server = await startOrchestratorServer({
    transport: serverTransport,
    initialMode: opts.mode ?? 'act',
    defaultProjectPath: '/proj',
    workerManager: prims.workerManager,
    worktreeManager: prims.worktreeManager,
    workerRegistry: registry,
    workerLifecycle: lifecycle,
  });
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(clientTransport);
  return { client, server, prims };
}

describe('worker-lifecycle tools (integration)', () => {
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
    const pair = await makePair(opts);
    handles.push(pair.server);
    clients.push(pair.client);
    return pair;
  }

  it('hides worker-lifecycle tools in plan mode and exposes them in act', async () => {
    const planPair = await connect({ mode: 'plan' });
    const planList = await planPair.client.listTools();
    const planNames = planList.tools.map((t) => t.name);
    expect(planNames).not.toContain('spawn_worker');
    expect(planNames).toContain('think');
    expect(planNames).toContain('propose_plan');

    const actPair = await connect({ mode: 'act' });
    const actList = await actPair.client.listTools();
    const actNames = actList.tools.map((t) => t.name);
    for (const n of [
      'spawn_worker',
      'list_workers',
      'get_worker_output',
      'send_to_worker',
      'kill_worker',
      'resume_worker',
      'find_worker',
    ]) {
      expect(actNames).toContain(n);
    }
  });

  it('spawn_worker → list_workers → kill_worker round-trip (real lifecycle, fake primitives)', async () => {
    const { client, prims } = await connect();
    const spawnRes = await client.callTool({
      name: 'spawn_worker',
      arguments: {
        task_description: 'Do integration test thing',
        role: 'implementer',
      },
    });
    expect(spawnRes.isError).toBeFalsy();
    const spawned = spawnRes.structuredContent as { id: string; worktreePath: string };
    expect(spawned.id).toBe('wk-fake-1');
    expect(spawned.worktreePath).toBe('/fake/wk-fake-1');
    expect(prims.spawnCalls[0]?.keepStdinOpen).toBe(true);

    const listRes = await client.callTool({ name: 'list_workers', arguments: {} });
    const list = listRes.structuredContent as { workers: Array<{ id: string }> };
    expect(list.workers.map((w) => w.id)).toContain(spawned.id);

    const killRes = await client.callTool({
      name: 'kill_worker',
      arguments: { worker_id: spawned.id, reason: 'test-over' },
    });
    expect(killRes.isError).toBeFalsy();

    // Waiting for the real lifecycle's wireExit → markCompleted microtask
    await new Promise((r) => setImmediate(r));

    const listAfter = await client.callTool({ name: 'list_workers', arguments: {} });
    const listAfterContent = listAfter.structuredContent as {
      workers: Array<{ id: string; status: string }>;
    };
    const entry = listAfterContent.workers.find((w) => w.id === spawned.id);
    expect(['killed', 'completed', 'failed', 'timeout']).toContain(entry?.status ?? '');
  });

  it('get_worker_output returns isError for unknown id', async () => {
    const { client } = await connect();
    const res = await client.callTool({
      name: 'get_worker_output',
      arguments: { worker_id: 'nope' },
    });
    expect(res.isError).toBe(true);
  });

  it('send_to_worker forwards the message to the real lifecycle-attached worker', async () => {
    const { client, prims } = await connect();
    const spawn = await client.callTool({
      name: 'spawn_worker',
      arguments: { task_description: 'integration send', role: 'implementer' },
    });
    const s = spawn.structuredContent as { id: string };
    const send = await client.callTool({
      name: 'send_to_worker',
      arguments: { worker_id: s.id, message: 'follow up please' },
    });
    expect(send.isError).toBeFalsy();
    const w = prims.spawned.find((x) => x.id === s.id);
    expect(w?.followups).toEqual(['follow up please']);
  });

  it('find_worker resolves feature intent substring via real registry', async () => {
    const { client } = await connect();
    const spawn = await client.callTool({
      name: 'spawn_worker',
      arguments: { task_description: 'the liquid glass hero', role: 'implementer' },
    });
    const s = spawn.structuredContent as { id: string; featureIntent: string };
    expect(s.featureIntent).toBe('the-liquid-glass-hero');
    const find = await client.callTool({
      name: 'find_worker',
      arguments: { description: 'liquid glass' },
    });
    const m = find.structuredContent as { matches: Array<{ id: string }> };
    expect(m.matches.map((r) => r.id)).toContain(s.id);
  });

  it('resume_worker rejects a running worker and accepts a terminal one', async () => {
    const { client, server } = await connect();
    const spawn = await client.callTool({
      name: 'spawn_worker',
      arguments: { task_description: 'integration resume', role: 'implementer' },
    });
    const s = spawn.structuredContent as { id: string };
    const res1 = await client.callTool({
      name: 'resume_worker',
      arguments: { worker_id: s.id, message: 'go again' },
    });
    expect(res1.isError).toBe(true);

    // Force terminal state by completing the fake worker, then resume.
    const rec = server.workerRegistry.get(s.id);
    (rec?.worker as FakeWorker).complete({
      status: 'completed',
      exitCode: 0,
      signal: null,
      durationMs: 1,
    });
    await new Promise((r) => setImmediate(r));

    const res2 = await client.callTool({
      name: 'resume_worker',
      arguments: { worker_id: s.id, message: 'continue' },
    });
    expect(res2.isError).toBeFalsy();
  });

  it('spawn_worker validates zod schema and returns isError on malformed input', async () => {
    const { client } = await connect();
    const res = await client.callTool({
      name: 'spawn_worker',
      arguments: { role: 'not-a-role', task_description: '' },
    });
    expect(res.isError).toBe(true);
  });

  it('spawn_worker fast-fails when dispatch signal is already aborted (M1 fix)', async () => {
    // Abort via server.close mid-flight: the SDK aborts the request controller,
    // which the signal-observing lifecycle now honours. We can't easily race
    // an abort into an in-flight handler from the client side, so instead we
    // exercise the direct lifecycle path with a pre-aborted signal to prove
    // the cooperative cancellation wire works.
    const prims = makeFakePrimitives();
    const registry = new WorkerRegistry();
    const lifecycle = createWorkerLifecycle({
      registry,
      workerManager: prims.workerManager,
      worktreeManager: prims.worktreeManager,
    });
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      lifecycle.spawn({
        projectPath: '/proj',
        taskDescription: 'x',
        role: 'implementer',
        signal: ctrl.signal,
      }),
    ).rejects.toThrow(/aborted/);
    // No worktree should have been created
    expect(prims.createCalls.length).toBe(0);
  });
});
