import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  startOrchestratorServer,
  type OrchestratorServerHandle,
} from '../../src/orchestrator/index.js';
import { RpcClient } from '../../src/rpc/client.js';
import type { CompletionSummary } from '../../src/orchestrator/completion-summarizer-types.js';
import type { OneShotRunner } from '../../src/orchestrator/one-shot.js';
import type { WorktreeManager } from '../../src/worktree/manager.js';
import type { CreateWorktreeOptions, WorktreeInfo } from '../../src/worktree/types.js';
import type { WorkerManager } from '../../src/workers/manager.js';
import type {
  Worker,
  WorkerConfig,
  WorkerExitInfo,
  StreamEvent,
} from '../../src/workers/types.js';

/**
 * Phase 3K — end-to-end pipeline test.
 *
 * Real WorkerLifecycle + real CompletionSummarizer + real
 * CompletionsBroker + real WS RPC server + real RpcClient. Stubs only:
 *   - WorkerManager spawn (returns a `ScriptedWorker`).
 *   - WorktreeManager (in-memory paths, no real git).
 *   - oneShotRunner (returns canned JSON instead of calling real claude).
 *
 * Asserts: a worker exit fired through `markCompleted` triggers the
 * lifecycle's `onWorkerStatusChange`, which fires the summarizer,
 * which calls the stubbed one-shot, which produces a parsed summary,
 * which gets published to the broker, which the WS dispatcher
 * forwards to the subscribed RPC client. The full pipe.
 */

class ScriptedWorker implements Worker {
  readonly id: string;
  sessionId: string | undefined;
  status: 'spawning' | 'running' | 'completed' | 'failed' | 'killed' | 'timeout' | 'crashed' =
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
  rpcClient: RpcClient<Record<string, never>>;
  server: OrchestratorServerHandle;
  oneShot: ReturnType<typeof vi.fn>;
}

async function makeHarness(opts: {
  workers?: ScriptedWorker[];
  oneShotImpl?: OneShotRunner;
} = {}): Promise<Harness> {
  const oneShot = vi.fn().mockImplementation(
    opts.oneShotImpl ??
      (async () => ({
        rawStdout: '',
        text: JSON.stringify({ headline: 'integration headline', metrics: '0 tests' }),
        exitCode: 0,
        signaled: false,
        durationMs: 0,
        stderrTail: '',
      })),
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = await startOrchestratorServer({
    transport: serverTransport,
    initialMode: 'act',
    defaultProjectPath: '/repos/default',
    workerManager: fakeWorkerManager(opts.workers ?? []),
    worktreeManager: fakeWorktreeManager(),
    projects: { symphony: '/repos/symphony' },
    rpc: { enabled: true, port: 0, skipDescriptorFile: true },
    oneShotRunner: oneShot as unknown as OneShotRunner,
  });
  const mcpClient = new Client({ name: 'test-client', version: '0.0.0' });
  await mcpClient.connect(clientTransport);
  if (server.rpc === undefined) throw new Error('rpc server missing on handle');
  const rpcUrl = `ws://${server.rpc.host}:${server.rpc.port}`;
  const rpcClient = await RpcClient.connect<Record<string, never>>({
    url: rpcUrl,
    token: server.rpc.token,
  });
  return { mcpClient, rpcClient, server, oneShot };
}

async function teardown(h: Harness): Promise<void> {
  await h.rpcClient.close().catch(() => {});
  await h.mcpClient.close().catch(() => {});
  await h.server.close().catch(() => {});
}

async function flush(): Promise<void> {
  for (let i = 0; i < 16; i += 1) {

    await Promise.resolve();
  }
  await new Promise((resolve) => setImmediate(resolve));
}

describe('completion summary pipeline (integration)', () => {
  let h: Harness;

  afterEach(async () => {
    await teardown(h);
  });

  it('worker exit → summarizer → broker → RPC subscriber receives summary', async () => {
    const w = new ScriptedWorker('wk-summ-1');
    h = await makeHarness({ workers: [w] });

    const received: CompletionSummary[] = [];
    await h.rpcClient.subscribe('completions.events', undefined, (payload) => {
      received.push(payload as CompletionSummary);
    });

    const spawnRes = await h.mcpClient.callTool({
      name: 'spawn_worker',
      arguments: {
        project: 'symphony',
        task_description: 'integration test',
        role: 'implementer',
      },
    });
    const id = (spawnRes.structuredContent as { id: string }).id;
    expect(id).toBeTruthy();

    // Drive a final assistant_text into the worker so the prompt has
    // useful self-report material.
    w.push({ type: 'assistant_text', text: 'wired endpoints' });
    await flush();

    // Trigger completion.
    w.complete({
      status: 'completed',
      exitCode: 0,
      signal: null,
      sessionId: w.sessionId,
      durationMs: 30_000,
    });

    // Wait for the lifecycle's wireExit chain → summarizer's await
    // oneShot() → broker.publish → WS frame → client onEvent.
    await vi.waitFor(() => {
      expect(received.length).toBeGreaterThanOrEqual(1);
    });

    expect(received[0]?.workerId).toBe(id);
    expect(received[0]?.statusKind).toBe('completed');
    expect(received[0]?.headline).toBe('integration headline');
    expect(received[0]?.metrics).toBe('0 tests');
    expect(received[0]?.fallback).toBe(false);
    // Server-side default name (TUI overrides at receipt; here we
    // assert the wire payload defaults).
    expect(received[0]?.workerName).toMatch(/^worker-/);
    expect(received[0]?.projectName).toBe('symphony');
    expect(h.oneShot).toHaveBeenCalledTimes(1);
  });

  it('one-shot failure falls through to heuristic summary, still publishes', async () => {
    const w = new ScriptedWorker('wk-summ-2');
    h = await makeHarness({
      workers: [w],
      oneShotImpl: async () => {
        throw new Error('claude unreachable');
      },
    });

    const received: CompletionSummary[] = [];
    await h.rpcClient.subscribe('completions.events', undefined, (payload) => {
      received.push(payload as CompletionSummary);
    });

    await h.mcpClient.callTool({
      name: 'spawn_worker',
      arguments: {
        project: 'symphony',
        task_description: 'fallback test',
        role: 'implementer',
      },
    });
    w.complete({
      status: 'failed',
      exitCode: 1,
      signal: null,
      sessionId: w.sessionId,
      durationMs: 1_500,
    });

    await vi.waitFor(() => {
      expect(received.length).toBeGreaterThanOrEqual(1);
    });
    expect(received[0]?.fallback).toBe(true);
    expect(received[0]?.statusKind).toBe('failed');
    expect(received[0]?.headline).toContain('failure');
  });

  it('killed workers do not produce a summary (silent on user-initiated)', async () => {
    const w = new ScriptedWorker('wk-summ-3');
    h = await makeHarness({ workers: [w] });

    const received: CompletionSummary[] = [];
    await h.rpcClient.subscribe('completions.events', undefined, (payload) => {
      received.push(payload as CompletionSummary);
    });

    await h.mcpClient.callTool({
      name: 'spawn_worker',
      arguments: {
        project: 'symphony',
        task_description: 'kill test',
        role: 'implementer',
      },
    });

    // ScriptedWorker.kill() completes with status 'killed'.
    w.kill();
    await flush();
    // Give it more time to be sure no summary lands.
    await new Promise((r) => setTimeout(r, 50));
    expect(received).toHaveLength(0);
    expect(h.oneShot).not.toHaveBeenCalled();
  });

  it('exposes completionsBroker + completionSummarizer on the handle', async () => {
    h = await makeHarness();
    expect(h.server.completionsBroker).toBeDefined();
    expect(h.server.completionSummarizer).toBeDefined();
    expect(typeof h.server.completionSummarizer.shutdown).toBe('function');
  });

  it('close() drains summarizer BEFORE workerLifecycle.shutdown', async () => {
    h = await makeHarness();
    const order: string[] = [];
    const summShutdown = h.server.completionSummarizer.shutdown.bind(h.server.completionSummarizer);
    h.server.completionSummarizer.shutdown = vi.fn(async () => {
      order.push('summarizer');
      await summShutdown();
    });
    const lifecycleShutdown = h.server.workerLifecycle.shutdown.bind(h.server.workerLifecycle);
    h.server.workerLifecycle.shutdown = vi.fn(async () => {
      order.push('lifecycle');
      await lifecycleShutdown();
    });
    await h.server.close();
    expect(order).toEqual(['summarizer', 'lifecycle']);
  });
});
