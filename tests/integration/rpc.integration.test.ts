import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  startOrchestratorServer,
  type OrchestratorServerHandle,
} from '../../src/orchestrator/index.js';
import { RpcClient } from '../../src/rpc/client.js';
import type { SymphonyRouter } from '../../src/rpc/router-impl.js';
import type { WorktreeManager } from '../../src/worktree/manager.js';
import type { CreateWorktreeOptions, WorktreeInfo } from '../../src/worktree/types.js';
import type { WorkerManager } from '../../src/workers/manager.js';
import type { Worker, WorkerConfig, WorkerExitInfo, StreamEvent } from '../../src/workers/types.js';

class ScriptedWorker implements Worker {
  readonly id: string;
  sessionId: string | undefined;
  status: 'spawning' | 'running' | 'completed' | 'failed' | 'killed' | 'timeout' | 'crashed' | 'interrupted' =
    'running';
  private resolveExit: ((info: WorkerExitInfo) => void) | null = null;
  private readonly exitPromise: Promise<WorkerExitInfo>;
  private pushEvent!: (e: StreamEvent) => void;
  private endEvents!: () => void;
  private readonly events_: AsyncIterable<StreamEvent>;

  constructor(id: string, sessionId: string | undefined = `sess-${id}`) {
    this.id = id;
    this.sessionId = sessionId;
    const sid = sessionId ?? `sess-${id}`;
    const queue: StreamEvent[] = [{ type: 'system_init', sessionId: sid } as StreamEvent];
    let resolveNext: ((v: IteratorResult<StreamEvent>) => void) | undefined;
    let done = false;
    this.pushEvent = (e: StreamEvent) => {
      if (done) return;
      if (resolveNext !== undefined) {
        const r = resolveNext;
        resolveNext = undefined;
        r({ value: e, done: false });
      } else {
        queue.push(e);
      }
    };
    this.endEvents = () => {
      done = true;
      if (resolveNext !== undefined) {
        const r = resolveNext;
        resolveNext = undefined;
        r({ value: undefined, done: true });
      }
    };
    this.events_ = {
      [Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
        return {
          next(): Promise<IteratorResult<StreamEvent>> {
            const head = queue.shift();
            if (head !== undefined) return Promise.resolve({ value: head, done: false });
            if (done) return Promise.resolve({ value: undefined as never, done: true });
            return new Promise<IteratorResult<StreamEvent>>((resolve) => {
              resolveNext = resolve;
            });
          },
        };
      },
    };
    this.exitPromise = new Promise<WorkerExitInfo>((resolve) => {
      this.resolveExit = resolve;
    });
  }

  get events(): AsyncIterable<StreamEvent> {
    return this.events_;
  }
  sendFollowup(): void {}
  endInput(): void {}
  kill(): void {
    this.complete({
      status: 'killed',
      exitCode: null,
      signal: 'SIGTERM',
      sessionId: this.sessionId,
      durationMs: 0,
    });
  }
  waitForExit(): Promise<WorkerExitInfo> {
    return this.exitPromise;
  }
  push(event: StreamEvent): void {
    this.pushEvent(event);
  }
  end(): void {
    this.endEvents();
  }
  complete(info: WorkerExitInfo): void {
    this.status = info.status;
    this.endEvents();
    this.resolveExit?.(info);
  }
}

function fakeWorktreeManager(): WorktreeManager {
  return {
    create: async (opts: CreateWorktreeOptions): Promise<WorktreeInfo> => ({
      id: opts.workerId,
      path: `/wt/${opts.workerId}`,
      branch: `symphony/${opts.workerId}`,
      baseRef: opts.baseRef ?? 'refs/heads/main',
      projectPath: opts.projectPath,
      createdAt: '2026-04-28T00:00:00.000Z',
    }),
    list: async () => [],
    remove: async () => {},
    removeIfClean: async () => true,
    status: async () => ({ hasChanges: false, staged: [], unstaged: [], untracked: [] }),
  } as unknown as WorktreeManager;
}

function fakeWorkerManager(workers: ScriptedWorker[]): WorkerManager {
  let i = 0;
  return {
    spawn: async (cfg: WorkerConfig) => {
      void cfg;
      const w = workers[i];
      i += 1;
      if (!w) throw new Error('fakeWorkerManager: no queued worker');
      return w;
    },
    list: () => [],
    get: () => undefined,
    shutdown: async () => {},
  } as unknown as WorkerManager;
}

interface Harness {
  mcpClient: Client;
  rpcClient: RpcClient<SymphonyRouter>;
  server: OrchestratorServerHandle;
  rpcUrl: string;
  rpcToken: string;
}

async function makeHarness(workers: ScriptedWorker[] = []): Promise<Harness> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = await startOrchestratorServer({
    transport: serverTransport,
    initialMode: 'act',
    defaultProjectPath: '/repos/default',
    workerManager: fakeWorkerManager(workers),
    worktreeManager: fakeWorktreeManager(),
    projects: { symphony: '/repos/symphony' },
    rpc: { enabled: true, port: 0, skipDescriptorFile: true },
  });
  const mcpClient = new Client({ name: 'test-client', version: '0.0.0' });
  await mcpClient.connect(clientTransport);
  if (server.rpc === undefined) throw new Error('rpc server missing on handle');
  const rpcUrl = `ws://${server.rpc.host}:${server.rpc.port}`;
  const rpcClient = await RpcClient.connect<SymphonyRouter>({
    url: rpcUrl,
    token: server.rpc.token,
  });
  return { mcpClient, rpcClient, server, rpcUrl, rpcToken: server.rpc.token };
}

async function teardown(h: Harness): Promise<void> {
  await h.rpcClient.close().catch(() => {});
  await h.mcpClient.close().catch(() => {});
  await h.server.close().catch(() => {});
}

describe('rpc integration — round-trip over WebSocket', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await makeHarness();
  });

  afterEach(async () => {
    await teardown(h);
  });

  it('projects.list returns the seeded projects', async () => {
    const projects = await h.rpcClient.call.projects.list();
    const names = projects.map((p) => p.name).sort();
    expect(names).toContain('symphony');
  });

  it('projects.register adds a new project', async () => {
    const before = await h.rpcClient.call.projects.list();
    await h.rpcClient.call.projects.register({ name: 'newproj', path: '/repos/newproj' });
    const after = await h.rpcClient.call.projects.list();
    expect(after.length).toBe(before.length + 1);
    expect(after.map((p) => p.name)).toContain('newproj');
  });

  it('projects.register rejects duplicate names', async () => {
    await expect(
      h.rpcClient.call.projects.register({ name: 'symphony', path: '/somewhere/else' }),
    ).rejects.toThrowError(/already registered/);
  });

  it('projects.get returns null for unknown ids', async () => {
    expect(await h.rpcClient.call.projects.get('does-not-exist')).toBeNull();
  });

  it('tasks lifecycle: create → list → get → update', async () => {
    const created = await h.rpcClient.call.tasks.create({
      projectId: 'symphony',
      description: 'wire up the RPC',
    });
    expect(created.status).toBe('pending');
    const list = await h.rpcClient.call.tasks.list({ projectId: created.projectId });
    expect(list.map((t) => t.id)).toContain(created.id);
    expect(await h.rpcClient.call.tasks.get(created.id)).toMatchObject({ id: created.id });
    const updated = await h.rpcClient.call.tasks.update({
      id: created.id,
      patch: { status: 'in_progress' },
    });
    expect(updated.status).toBe('in_progress');
  });

  it('tasks.create rejects unknown projectId', async () => {
    await expect(
      h.rpcClient.call.tasks.create({ projectId: 'no-such-project', description: 'x' }),
    ).rejects.toThrowError(/not registered/);
  });

  it('workers.list returns the empty list when no workers have been spawned', async () => {
    const list = await h.rpcClient.call.workers.list();
    expect(Array.isArray(list)).toBe(true);
    expect(list.length).toBe(0);
  });

  it('single-engine invariant: MCP spawn shows up in workers.list over RPC (Audit m8)', async () => {
    await teardown(h);
    const w = new ScriptedWorker('wk-shared');
    h = await makeHarness([w]);
    const spawnRes = await h.mcpClient.callTool({
      name: 'spawn_worker',
      arguments: {
        project: 'symphony',
        task_description: 'shared via RPC',
        role: 'implementer',
      },
    });
    const id = (spawnRes.structuredContent as { id: string }).id;
    const list = await h.rpcClient.call.workers.list();
    const ids = list.map((s) => s.id);
    expect(ids).toContain(id);
  });

  it('mode.get returns the current orchestrator mode', async () => {
    expect(await h.rpcClient.call.mode.get()).toEqual({ mode: 'act' });
  });

  it('workers.tail returns the buffered events of a spawned worker', async () => {
    await teardown(h);
    const w = new ScriptedWorker('wk-tail');
    h = await makeHarness([w]);
    const spawnRes = await h.mcpClient.callTool({
      name: 'spawn_worker',
      arguments: {
        project: 'symphony',
        task_description: 'tail probe',
        role: 'implementer',
      },
    });
    const id = (spawnRes.structuredContent as { id: string }).id;
    // Push a couple of stream events through the scripted worker so they
    // land in the registry's CircularBuffer via the lifecycle's event tap.
    w.push({ type: 'assistant_text', text: 'hello' });
    w.push({ type: 'assistant_text', text: 'world' });
    // One microtask is enough for the lifecycle's tap to drain the queue
    // into the buffer; pump a couple just to be safe under different
    // schedulers.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    const tail = await h.rpcClient.call.workers.tail({ workerId: id, n: 50 });
    expect(tail.events.length).toBeGreaterThanOrEqual(2);
    const texts = tail.events
      .filter((e) => e.type === 'assistant_text')
      .map((e) => (e as { text: string }).text);
    expect(texts).toContain('hello');
    expect(texts).toContain('world');
    expect(tail.total).toBeGreaterThanOrEqual(2);
  });

  it('workers.tail rejects unknown workerId with not_found', async () => {
    await expect(
      h.rpcClient.call.workers.tail({ workerId: 'no-such-worker' }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('workers.tail rejects out-of-range n with bad_args', async () => {
    await expect(
      h.rpcClient.call.workers.tail({ workerId: 'whatever', n: 0 }),
    ).rejects.toMatchObject({ code: 'bad_args' });
    await expect(
      h.rpcClient.call.workers.tail({ workerId: 'whatever', n: 501 }),
    ).rejects.toMatchObject({ code: 'bad_args' });
    await expect(
      h.rpcClient.call.workers.tail({ workerId: 'whatever', n: 1.5 }),
    ).rejects.toMatchObject({ code: 'bad_args' });
  });

  it('questions surface from the store', async () => {
    h.server.questionStore.enqueue({
      question: 'pick a name',
      projectId: 'symphony',
    });
    const list = await h.rpcClient.call.questions.list();
    expect(list.length).toBe(1);
    const id = list[0]!.id;
    const answered = await h.rpcClient.call.questions.answer({ id, answer: 'Maestro' });
    expect(answered.answered).toBe(true);
    expect(answered.answer).toBe('Maestro');
  });
});

describe('rpc integration — auth + transport hardening', () => {
  it('rejects connections with a bad token at upgrade (HTTP 401)', async () => {
    const server = await startOrchestratorServer({
      transport: InMemoryTransport.createLinkedPair()[1],
      initialMode: 'act',
      defaultProjectPath: '/repos/default',
      workerManager: fakeWorkerManager([]),
      worktreeManager: fakeWorktreeManager(),
      projects: { symphony: '/repos/symphony' },
      rpc: { enabled: true, port: 0, skipDescriptorFile: true },
    });
    try {
      if (server.rpc === undefined) throw new Error('rpc missing');
      const url = `ws://${server.rpc.host}:${server.rpc.port}`;
      await expect(
        RpcClient.connect<SymphonyRouter>({ url, token: 'wrong-token', openTimeoutMs: 2_000 }),
      ).rejects.toThrowError();
    } finally {
      await server.close();
    }
  });

  it('rejects connections with no Authorization header (no token query param)', async () => {
    const server = await startOrchestratorServer({
      transport: InMemoryTransport.createLinkedPair()[1],
      initialMode: 'act',
      defaultProjectPath: '/repos/default',
      workerManager: fakeWorkerManager([]),
      worktreeManager: fakeWorktreeManager(),
      projects: { symphony: '/repos/symphony' },
      rpc: { enabled: true, port: 0, skipDescriptorFile: true, token: 'fixed' },
    });
    try {
      if (server.rpc === undefined) throw new Error('rpc missing');
      // Use raw ws to skip the Authorization header injection in our client.
      const { WebSocket } = await import('ws');
      const url = `ws://${server.rpc.host}:${server.rpc.port}`;
      await expect(
        new Promise<void>((resolve, reject) => {
          const ws = new WebSocket(url);
          ws.on('open', () => {
            ws.close();
            resolve();
          });
          ws.on('error', reject);
        }),
      ).rejects.toThrowError();
    } finally {
      await server.close();
    }
  });
});

describe('rpc integration — error envelopes', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await makeHarness();
  });

  afterEach(async () => {
    await teardown(h);
  });

  it('unknown namespace returns not_found', async () => {
    type Bogus = { ghost: { read: () => Promise<unknown> } };
    const bogus = h.rpcClient.call as unknown as Bogus;
    await expect(bogus.ghost.read()).rejects.toMatchObject({ code: 'not_found' });
  });

  it('unknown procedure returns not_found', async () => {
    type Extended = { projects: { read: () => Promise<unknown> } };
    const ext = h.rpcClient.call as unknown as Extended;
    await expect(ext.projects.read()).rejects.toMatchObject({ code: 'not_found' });
  });

  it('bad_args envelope on missing required field', async () => {
    await expect(
      h.rpcClient.call.projects.register({ name: '', path: '/whatever' }),
    ).rejects.toMatchObject({ code: 'bad_args' });
  });
});

describe('rpc integration — workers.events subscription', () => {
  it('client receives events the broker publishes for the subscribed worker', async () => {
    const w = new ScriptedWorker('wk-S');
    const h = await makeHarness([w]);
    try {
      const spawnRes = await h.mcpClient.callTool({
        name: 'spawn_worker',
        arguments: {
          project: 'symphony',
          task_description: 'subscribe me',
          role: 'implementer',
        },
      });
      const id = (spawnRes.structuredContent as { id: string }).id;
      const received: unknown[] = [];
      const sub = await h.rpcClient.subscribe(
        'workers.events',
        { workerId: id },
        (payload) => received.push(payload),
      );
      // Push an event after subscription is acked — drives the broker.
      w.push({ type: 'assistant_text', text: 'first' } as StreamEvent);
      // Allow microtask drain + WS round-trip.
      await new Promise((r) => setTimeout(r, 50));
      expect(received).toContainEqual({ type: 'assistant_text', text: 'first' });
      await sub.unsubscribe();
      // After unsubscribe, further events should not arrive.
      const before = received.length;
      w.push({ type: 'assistant_text', text: 'second' } as StreamEvent);
      await new Promise((r) => setTimeout(r, 50));
      expect(received.length).toBe(before);
    } finally {
      await teardown(h);
    }
  });

  it('two RPC clients can both subscribe to the same workerId concurrently', async () => {
    const w = new ScriptedWorker('wk-T');
    const h = await makeHarness([w]);
    let h2Client: RpcClient<SymphonyRouter> | undefined;
    try {
      const spawnRes = await h.mcpClient.callTool({
        name: 'spawn_worker',
        arguments: {
          project: 'symphony',
          task_description: 'fan out',
          role: 'implementer',
        },
      });
      const id = (spawnRes.structuredContent as { id: string }).id;
      h2Client = await RpcClient.connect<SymphonyRouter>({
        url: h.rpcUrl,
        token: h.rpcToken,
      });
      const recvA: unknown[] = [];
      const recvB: unknown[] = [];
      await h.rpcClient.subscribe('workers.events', { workerId: id }, (p) => recvA.push(p));
      await h2Client.subscribe('workers.events', { workerId: id }, (p) => recvB.push(p));
      w.push({ type: 'assistant_text', text: 'shared' } as StreamEvent);
      await new Promise((r) => setTimeout(r, 50));
      expect(recvA.length).toBeGreaterThanOrEqual(1);
      expect(recvB.length).toBeGreaterThanOrEqual(1);
    } finally {
      await h2Client?.close().catch(() => {});
      await teardown(h);
    }
  });

  it('subscribe with bad args returns bad_args envelope', async () => {
    const h = await makeHarness();
    try {
      await expect(
        h.rpcClient.subscribe('workers.events', {}, () => {}),
      ).rejects.toMatchObject({ code: 'bad_args' });
    } finally {
      await teardown(h);
    }
  });

  it('subscribe to unknown topic returns not_found envelope', async () => {
    const h = await makeHarness();
    try {
      await expect(
        h.rpcClient.subscribe('bogus.topic', { workerId: 'x' }, () => {}),
      ).rejects.toMatchObject({ code: 'not_found' });
    } finally {
      await teardown(h);
    }
  });
});

describe('rpc integration — connection lifecycle', () => {
  it('pending calls reject with `aborted` when the client closes', async () => {
    const h = await makeHarness();
    // Issue a slow-ish call but tear down the client immediately. We only
    // assert that the client surfaces an `aborted`-shaped error rather
    // than hanging forever.
    const resultsPromise = h.rpcClient.call.projects.list();
    await h.rpcClient.close();
    await expect(resultsPromise).rejects.toMatchObject({ code: 'aborted' });
    await h.server.close();
  });

  it('server close tears down active subscriptions', async () => {
    const w = new ScriptedWorker('wk-X');
    const h = await makeHarness([w]);
    const spawnRes = await h.mcpClient.callTool({
      name: 'spawn_worker',
      arguments: {
        project: 'symphony',
        task_description: 'close me',
        role: 'implementer',
      },
    });
    const id = (spawnRes.structuredContent as { id: string }).id;
    await h.rpcClient.subscribe('workers.events', { workerId: id }, () => {});
    await h.server.close();
    // Wait for the WS close event to propagate to the client.
    for (let i = 0; i < 50 && !h.rpcClient.closed; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(h.rpcClient.closed).toBe(true);
    await h.mcpClient.close().catch(() => {});
  });
});
