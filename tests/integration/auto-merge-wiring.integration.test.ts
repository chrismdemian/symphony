import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startOrchestratorServer } from '../../src/orchestrator/index.js';
import type { OrchestratorServerHandle } from '../../src/orchestrator/index.js';
import type {
  AutoMergeDispatcherHandle,
  AutoMergeEvent,
} from '../../src/orchestrator/auto-merge-types.js';
import type { FinalizeRunResult } from '../../src/orchestrator/finalize-runner.js';
import type { QuestionRecord } from '../../src/state/question-registry.js';

/**
 * Phase 3O.1 — server-wide auto-merge wiring integration test.
 *
 * Asserts that the dispatcher injected via OrchestratorServerOptions:
 *   - Is reachable from the finalize tool's onFinalize callback
 *   - Receives onQuestionAnswered callbacks when QuestionStore.answer fires
 *   - Is exposed on the OrchestratorServerHandle alongside the broker
 *   - shutdown() runs before notificationDispatcher.shutdown + lifecycle.shutdown
 */

interface StubDispatcher {
  readonly dispatcher: AutoMergeDispatcherHandle;
  readonly finalizes: Array<{ result: FinalizeRunResult; ctx: unknown }>;
  readonly answers: QuestionRecord[];
  shutdownCalled: boolean;
}

function makeStubDispatcher(): StubDispatcher {
  const finalizes: Array<{ result: FinalizeRunResult; ctx: unknown }> = [];
  const answers: QuestionRecord[] = [];
  const stub = {
    dispatcher: {
      onFinalize: vi.fn((result, ctx) => {
        finalizes.push({ result, ctx });
      }),
      onQuestionAnswered: vi.fn((record) => {
        answers.push(record);
      }),
      shutdown: vi.fn(async () => {
        stub.shutdownCalled = true;
      }),
    } as AutoMergeDispatcherHandle,
    finalizes,
    answers,
    shutdownCalled: false,
  };
  return stub;
}

describe('auto-merge wiring (integration)', () => {
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

  it('exposes autoMergeBroker + autoMergeDispatcher on the handle', async () => {
    const [, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = await startOrchestratorServer({
      transport: serverTransport,
      initialMode: 'act',
    });
    handles.push(server);
    expect(server.autoMergeBroker).toBeDefined();
    expect(server.autoMergeDispatcher).toBeDefined();
    expect(typeof server.autoMergeBroker.subscribe).toBe('function');
    expect(typeof server.autoMergeDispatcher.onFinalize).toBe('function');
    expect(typeof server.autoMergeDispatcher.onQuestionAnswered).toBe('function');
  });

  it('ask_user answer routes through QuestionStore → autoMergeDispatcher.onQuestionAnswered', async () => {
    const stub = makeStubDispatcher();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = await startOrchestratorServer({
      transport: serverTransport,
      autoMergeDispatcher: stub.dispatcher,
      initialMode: 'act',
    });
    const client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(clientTransport);
    handles.push(server);
    clients.push(client);

    // Enqueue via ask_user tool (server-side question flow).
    const result = await client.callTool({
      name: 'ask_user',
      arguments: { question: 'Merge to master?' },
    });
    // `structuredContent.id` is the enqueued question id.
    const structured = (result as { structuredContent?: { id: string } }).structuredContent;
    expect(structured?.id).toMatch(/^q-/);
    const qid = structured!.id;

    // Now answer it server-side. This must fire onQuestionAnswered on the
    // dispatcher via the questionStore's hook.
    server.questionStore.answer(qid, 'y');

    expect(stub.dispatcher.onQuestionAnswered).toHaveBeenCalledTimes(1);
    expect(stub.answers).toHaveLength(1);
    expect(stub.answers[0]!.id).toBe(qid);
    expect(stub.answers[0]!.answer).toBe('y');
  });

  it('close() invokes autoMergeDispatcher.shutdown before workerLifecycle.shutdown', async () => {
    const stub = makeStubDispatcher();
    const [, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = await startOrchestratorServer({
      transport: serverTransport,
      autoMergeDispatcher: stub.dispatcher,
    });
    handles.push(server);

    const lifecycleShutdownSpy = vi.spyOn(server.workerLifecycle, 'shutdown');
    const order: string[] = [];
    (stub.dispatcher.shutdown as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      order.push('auto-merge-dispatcher');
    });
    lifecycleShutdownSpy.mockImplementation(async () => {
      order.push('lifecycle');
    });

    await server.close();
    expect(order).toEqual(['auto-merge-dispatcher', 'lifecycle']);
  });

  it('close() invokes autoMergeDispatcher.shutdown before notificationDispatcher.shutdown', async () => {
    const stubAuto = makeStubDispatcher();
    // We also want a stub notification dispatcher to observe ordering.
    const order: string[] = [];
    (stubAuto.dispatcher.shutdown as ReturnType<typeof vi.fn>).mockImplementation(
      async () => {
        order.push('auto-merge');
      },
    );
    const notif = {
      onWorkerExit: vi.fn(),
      onQuestion: vi.fn(),
      flushAwayDigest: vi.fn(async () => ({ digest: null as string | null })),
      shutdown: vi.fn(async () => {
        order.push('notifications');
      }),
    };
    const [, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = await startOrchestratorServer({
      transport: serverTransport,
      autoMergeDispatcher: stubAuto.dispatcher,
      notificationDispatcher: notif,
    });
    handles.push(server);
    await server.close();
    expect(order).toEqual(['auto-merge', 'notifications']);
  });

  it('autoMergeBroker.clear() runs during close', async () => {
    const [, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = await startOrchestratorServer({
      transport: serverTransport,
      // Enable RPC so the broker.clear branch fires (it's gated on rpcHandle !== undefined).
      rpc: { enabled: true, port: 0, skipDescriptorFile: true },
    });
    handles.push(server);

    const events: AutoMergeEvent[] = [];
    const off = server.autoMergeBroker.subscribe((e) => events.push(e));
    server.autoMergeBroker.publish({
      kind: 'ready',
      workerId: 'w',
      branch: 'b',
      projectName: 'p',
      mergeTo: 'master',
      headline: 'pre-shutdown',
      ts: '2026-05-12T00:00:00.000Z',
    });
    expect(events).toHaveLength(1);

    await server.close();
    expect(server.autoMergeBroker.subscriberCount()).toBe(0);
    off(); // idempotent
  });
});
