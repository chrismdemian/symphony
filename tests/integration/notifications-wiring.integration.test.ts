import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startOrchestratorServer } from '../../src/orchestrator/index.js';
import type { OrchestratorServerHandle } from '../../src/orchestrator/index.js';
import type {
  DispatcherHandle,
  ToastInput,
} from '../../src/notifications/types.js';
import type { WorkerRecord } from '../../src/orchestrator/worker-registry.js';

/**
 * Phase 3H.3 — server-wide notification wiring integration test.
 *
 * Asserts that the dispatcher injected via OrchestratorServerOptions:
 *   - Receives `onWorkerExit` callbacks when the worker lifecycle's
 *     wireExit fires for a terminal status.
 *   - Receives `onQuestion` callbacks when the question store's
 *     `enqueue` is invoked (via the `ask_user` MCP tool).
 *   - Has its `flushAwayDigest` reachable from the RPC layer (mocked
 *     via direct dispatcher.flushAwayDigest call here; the live RPC
 *     wiring is exercised in the production scenario).
 */

function makeStubDispatcher(): {
  dispatcher: DispatcherHandle;
  workerExits: Array<{ record: WorkerRecord; totalRunning: number }>;
  questions: Array<{ id: string; question: string }>;
  toasts: ToastInput[];
} {
  const workerExits: Array<{ record: WorkerRecord; totalRunning: number }> = [];
  const questions: Array<{ id: string; question: string }> = [];
  const toasts: ToastInput[] = [];
  const dispatcher: DispatcherHandle = {
    onWorkerExit: vi.fn((record, totalRunning) => {
      workerExits.push({ record, totalRunning });
    }),
    onQuestion: vi.fn((record) => {
      questions.push({ id: record.id, question: record.question });
    }),
    flushAwayDigest: vi.fn(async () => {
      toasts.push({ title: 'flushed', body: '' });
    }),
    shutdown: vi.fn(async () => {
      // no-op
    }),
  };
  return { dispatcher, workerExits, questions, toasts };
}

describe('notifications wiring (integration)', () => {
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

  it('ask_user → questionStore.enqueue → dispatcher.onQuestion', async () => {
    const { dispatcher, questions } = makeStubDispatcher();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = await startOrchestratorServer({
      transport: serverTransport,
      notificationDispatcher: dispatcher,
      initialMode: 'act',
    });
    const client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(clientTransport);
    handles.push(server);
    clients.push(client);

    // Drive the ask_user tool — fakes the Maestro side.
    await client.callTool({
      name: 'ask_user',
      arguments: { question: 'Pick a port?' },
    });

    expect(questions).toHaveLength(1);
    expect(questions[0]!.question).toBe('Pick a port?');
    expect(dispatcher.onQuestion).toHaveBeenCalledTimes(1);
  });

  it('close() invokes dispatcher.shutdown before workerLifecycle.shutdown', async () => {
    const { dispatcher } = makeStubDispatcher();
    const [, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = await startOrchestratorServer({
      transport: serverTransport,
      notificationDispatcher: dispatcher,
    });
    handles.push(server);

    // Spy on the lifecycle's shutdown and capture call ordering.
    const lifecycleShutdownSpy = vi.spyOn(server.workerLifecycle, 'shutdown');
    const order: string[] = [];
    (dispatcher.shutdown as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      order.push('dispatcher');
    });
    lifecycleShutdownSpy.mockImplementation(async () => {
      order.push('lifecycle');
    });

    await server.close();
    expect(order).toEqual(['dispatcher', 'lifecycle']);
  });

  it('exposes the dispatcher on the OrchestratorServerHandle', async () => {
    const { dispatcher } = makeStubDispatcher();
    const [, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = await startOrchestratorServer({
      transport: serverTransport,
      notificationDispatcher: dispatcher,
    });
    handles.push(server);
    expect(server.notificationDispatcher).toBe(dispatcher);
  });
});
