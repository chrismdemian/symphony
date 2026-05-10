import { describe, expect, it } from 'vitest';
import { Dispatcher } from '../../src/rpc/dispatcher.js';
import { WorkerEventBroker } from '../../src/rpc/event-broker.js';
import { WorkerCompletionsBroker } from '../../src/orchestrator/completions-broker.js';
import { createRPCRouter } from '../../src/rpc/router.js';
import type { CompletionSummary } from '../../src/orchestrator/completion-summarizer-types.js';

/**
 * Phase 3K — dispatcher recognition of `'completions.events'` topic.
 *
 * Mirrors the existing `tests/rpc/dispatcher.unit.test.ts` shape:
 * synthetic frames in, synthetic sent[] out, parse the JSON wire
 * format. No real WebSocket — the dispatcher is transport-agnostic.
 */

interface Harness {
  dispatcher: Dispatcher;
  completionsBroker: WorkerCompletionsBroker;
  sent: string[];
}

function makeHarness(opts: { withCompletionsBroker?: boolean } = {}): Harness {
  const eventBroker = new WorkerEventBroker();
  const completionsBroker = new WorkerCompletionsBroker();
  const sent: string[] = [];
  const controller = new AbortController();
  const router = createRPCRouter({});
  const dispatcher = new Dispatcher({
    router,
    broker: eventBroker,
    send: (text) => sent.push(text),
    signal: controller.signal,
    ...(opts.withCompletionsBroker !== false ? { completionsBroker } : {}),
  });
  return { dispatcher, completionsBroker, sent };
}

function makeSummary(overrides: Partial<CompletionSummary> = {}): CompletionSummary {
  return {
    workerId: 'wk-1',
    workerName: 'Violin',
    projectName: 'MathScrabble',
    statusKind: 'completed',
    durationMs: 1000,
    headline: 'h',
    ts: new Date(0).toISOString(),
    fallback: false,
    ...overrides,
  };
}

function parseFrames(sent: readonly string[]): Array<Record<string, unknown>> {
  return sent.map((text) => JSON.parse(text) as Record<string, unknown>);
}

describe('dispatcher — completions.events subscribe', () => {
  it('returns success envelope and topic when subscribe accepted', async () => {
    const h = makeHarness();
    await h.dispatcher.handle(
      JSON.stringify({
        kind: 'subscribe',
        id: 'sub-1',
        topic: 'completions.events',
        args: undefined,
      }),
    );
    const frames = parseFrames(h.sent);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      kind: 'rpc-result',
      id: 'sub-1',
      result: { success: true, data: { topic: 'completions.events' } },
    });
  });

  it('forwards published summaries as event frames', async () => {
    const h = makeHarness();
    await h.dispatcher.handle(
      JSON.stringify({
        kind: 'subscribe',
        id: 'sub-1',
        topic: 'completions.events',
        args: undefined,
      }),
    );
    h.completionsBroker.publish(makeSummary({ workerId: 'wk-A', headline: 'first' }));
    h.completionsBroker.publish(makeSummary({ workerId: 'wk-B', headline: 'second' }));
    const events = parseFrames(h.sent).filter((f) => f.kind === 'event');
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      kind: 'event',
      topic: 'completions.events',
      payload: { workerId: 'wk-A', headline: 'first' },
    });
    expect(events[1]).toMatchObject({
      payload: { workerId: 'wk-B', headline: 'second' },
    });
  });

  it('returns not_found when no completionsBroker was wired', async () => {
    const h = makeHarness({ withCompletionsBroker: false });
    await h.dispatcher.handle(
      JSON.stringify({
        kind: 'subscribe',
        id: 'sub-1',
        topic: 'completions.events',
        args: undefined,
      }),
    );
    const frames = parseFrames(h.sent);
    expect(frames[0]).toMatchObject({
      kind: 'rpc-result',
      id: 'sub-1',
      result: { success: false, error: { code: 'not_found' } },
    });
  });

  it('rejects subscribe with a duplicate id (per-connection)', async () => {
    const h = makeHarness();
    await h.dispatcher.handle(
      JSON.stringify({
        kind: 'subscribe',
        id: 'sub-1',
        topic: 'completions.events',
        args: undefined,
      }),
    );
    await h.dispatcher.handle(
      JSON.stringify({
        kind: 'subscribe',
        id: 'sub-1',
        topic: 'completions.events',
        args: undefined,
      }),
    );
    const last = parseFrames(h.sent).pop();
    expect(last).toMatchObject({
      kind: 'rpc-result',
      id: 'sub-1',
      result: { success: false, error: { code: 'bad_args' } },
    });
  });

  it('unsubscribe stops further events from arriving', async () => {
    const h = makeHarness();
    await h.dispatcher.handle(
      JSON.stringify({
        kind: 'subscribe',
        id: 'sub-1',
        topic: 'completions.events',
        args: undefined,
      }),
    );
    h.completionsBroker.publish(makeSummary({ headline: 'one' }));
    await h.dispatcher.handle(
      JSON.stringify({
        kind: 'unsubscribe',
        id: 'sub-1',
        topic: 'completions.events',
      }),
    );
    h.completionsBroker.publish(makeSummary({ headline: 'two' }));
    const eventPayloads = parseFrames(h.sent)
      .filter((f) => f.kind === 'event')
      .map((f) => (f.payload as { headline: string }).headline);
    expect(eventPayloads).toEqual(['one']);
  });

  it('close() drops the subscription so further publishes are no-ops', () => {
    const h = makeHarness();
    void h.dispatcher.handle(
      JSON.stringify({
        kind: 'subscribe',
        id: 'sub-1',
        topic: 'completions.events',
        args: undefined,
      }),
    );
    h.dispatcher.close();
    h.completionsBroker.publish(makeSummary({ headline: 'after-close' }));
    const events = parseFrames(h.sent).filter((f) => f.kind === 'event');
    expect(events).toHaveLength(0);
  });

  it('does not interfere with workers.events subscriptions', async () => {
    const h = makeHarness();
    await h.dispatcher.handle(
      JSON.stringify({
        kind: 'subscribe',
        id: 'sub-w',
        topic: 'workers.events',
        args: { workerId: 'wk-1' },
      }),
    );
    await h.dispatcher.handle(
      JSON.stringify({
        kind: 'subscribe',
        id: 'sub-c',
        topic: 'completions.events',
        args: undefined,
      }),
    );
    const frames = parseFrames(h.sent);
    // Both subscribes acked successfully.
    expect(frames.filter((f) => (f as { result?: { success?: boolean } }).result?.success === true)).toHaveLength(2);
  });
});
