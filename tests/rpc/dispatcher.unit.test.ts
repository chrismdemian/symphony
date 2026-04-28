import { describe, expect, it } from 'vitest';
import { Dispatcher, getCurrentSignal } from '../../src/rpc/dispatcher.js';
import { WorkerEventBroker } from '../../src/rpc/event-broker.js';
import { createRPCController, createRPCRouter } from '../../src/rpc/router.js';

function makeDispatcher() {
  const broker = new WorkerEventBroker();
  const sent: string[] = [];
  const closeCalls: Array<{ code: number; reason: string }> = [];
  const controller = new AbortController();
  const router = createRPCRouter({
    sync: createRPCController({
      ping: () => 'pong',
      explode: () => {
        throw new Error('boom');
      },
    }),
    asyncNs: createRPCController({
      readSignal: async () => {
        // Yield once, then read the signal AFTER the await — this is
        // the path that the broken module-local `let CURRENT_SIGNAL`
        // failed (Audit C1). AsyncLocalStorage must preserve it.
        await new Promise((r) => setImmediate(r));
        return getCurrentSignal()?.aborted ?? null;
      },
      slowEcho: async (delay: number, value: unknown) => {
        await new Promise((r) => setTimeout(r, delay));
        const sig = getCurrentSignal();
        // Cooperative cancellation — handler observes its own signal
        // and surfaces an error on abort. Realistic shape for future
        // async procedures.
        if (sig?.aborted === true) {
          throw new Error('cancelled');
        }
        return { value, sigSeen: sig?.aborted };
      },
    }),
  });
  const d = new Dispatcher({
    router,
    broker,
    send: (text) => sent.push(text),
    signal: controller.signal,
    closeOnProtocolError: (code, reason) => closeCalls.push({ code, reason }),
  });
  return { dispatcher: d, sent, closeCalls, controller };
}

function lastResult(sent: string[]): { id: string; success: boolean; data?: unknown; error?: { code: string; message: string } } {
  const text = sent[sent.length - 1] ?? '';
  const f = JSON.parse(text);
  return { id: f.id, ...f.result };
}

describe('rpc/dispatcher — round-trip', () => {
  it('dispatches a sync handler and replies with success envelope', async () => {
    const { dispatcher, sent } = makeDispatcher();
    await dispatcher.handle(
      JSON.stringify({ kind: 'rpc-call', id: '1', namespace: 'sync', procedure: 'ping', args: [] }),
    );
    expect(lastResult(sent)).toEqual({ id: '1', success: true, data: 'pong' });
  });

  it('returns not_found envelope for unknown namespace', async () => {
    const { dispatcher, sent } = makeDispatcher();
    await dispatcher.handle(
      JSON.stringify({ kind: 'rpc-call', id: '2', namespace: 'ghost', procedure: 'go', args: [] }),
    );
    const result = lastResult(sent);
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('not_found');
  });

  it('returns internal envelope when handler throws', async () => {
    const { dispatcher, sent } = makeDispatcher();
    await dispatcher.handle(
      JSON.stringify({
        kind: 'rpc-call',
        id: '3',
        namespace: 'sync',
        procedure: 'explode',
        args: [],
      }),
    );
    const result = lastResult(sent);
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('internal');
    expect(result.error?.message).toBe('boom');
  });

  it('returns aborted envelope when controller.abort fires before reply', async () => {
    const { dispatcher, sent, controller } = makeDispatcher();
    const promise = dispatcher.handle(
      JSON.stringify({
        kind: 'rpc-call',
        id: '4',
        namespace: 'asyncNs',
        procedure: 'slowEcho',
        args: [50, 'x'],
      }),
    );
    controller.abort();
    await promise;
    const result = lastResult(sent);
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('aborted');
  });

  it('closes connection on illegal-direction frames (Audit m11)', async () => {
    const { dispatcher, closeCalls } = makeDispatcher();
    await dispatcher.handle(
      JSON.stringify({
        kind: 'event',
        topic: 'workers.events',
        payload: {},
      }),
    );
    expect(closeCalls).toHaveLength(1);
    expect(closeCalls[0]!.code).toBe(1002);
  });

  it('rejects oversized frames at decode (Audit M2)', async () => {
    const { dispatcher, sent } = makeDispatcher();
    const huge = JSON.stringify({
      kind: 'rpc-call',
      id: 'big',
      namespace: 'sync',
      procedure: 'ping',
      args: ['x'.repeat(2 * 1024 * 1024)],
    });
    await dispatcher.handle(huge);
    const result = lastResult(sent);
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('bad_args');
    expect(result.error?.message).toMatch(/exceeds/);
  });
});

describe('rpc/dispatcher — async signal threading (Audit C1 regression)', () => {
  it('preserves the signal across await boundaries via AsyncLocalStorage', async () => {
    const { dispatcher, sent } = makeDispatcher();
    await dispatcher.handle(
      JSON.stringify({
        kind: 'rpc-call',
        id: 'a',
        namespace: 'asyncNs',
        procedure: 'readSignal',
        args: [],
      }),
    );
    const result = lastResult(sent);
    expect(result.success).toBe(true);
    // signal exists, hasn't aborted, so .aborted === false (NOT null/undefined).
    expect(result.data).toBe(false);
  });

  it('two concurrent invocations see their OWN signal, not each other (interleaving safe)', async () => {
    const { dispatcher, sent } = makeDispatcher();
    // Fire two slow-echo calls concurrently. Each should resolve to its
    // own value with `sigSeen=false` (signal is still live). The
    // pre-fix module-local `CURRENT_SIGNAL` would corrupt state under
    // this interleaving.
    const a = dispatcher.handle(
      JSON.stringify({
        kind: 'rpc-call',
        id: 'p1',
        namespace: 'asyncNs',
        procedure: 'slowEcho',
        args: [10, 'A'],
      }),
    );
    const b = dispatcher.handle(
      JSON.stringify({
        kind: 'rpc-call',
        id: 'p2',
        namespace: 'asyncNs',
        procedure: 'slowEcho',
        args: [5, 'B'],
      }),
    );
    await Promise.all([a, b]);
    const replies = sent
      .map((t) => JSON.parse(t))
      .filter((f) => f.kind === 'rpc-result');
    const byId = new Map(replies.map((f) => [f.id, f.result]));
    expect(byId.get('p1')).toEqual({ success: true, data: { value: 'A', sigSeen: false } });
    expect(byId.get('p2')).toEqual({ success: true, data: { value: 'B', sigSeen: false } });
  });
});
