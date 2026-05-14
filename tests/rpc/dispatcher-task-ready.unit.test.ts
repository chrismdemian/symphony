import { describe, expect, it } from 'vitest';
import { Dispatcher } from '../../src/rpc/dispatcher.js';
import { WorkerEventBroker } from '../../src/rpc/event-broker.js';
import { TaskReadyBrokerImpl } from '../../src/orchestrator/task-ready-broker.js';
import { createRPCRouter } from '../../src/rpc/router.js';
import type { TaskReadyEvent } from '../../src/orchestrator/task-ready-types.js';

/**
 * Phase 3P — dispatcher recognition of `'task-ready.events'` topic.
 * Mirrors `dispatcher-completions.unit.test.ts` exactly.
 */

interface Harness {
  dispatcher: Dispatcher;
  broker: TaskReadyBrokerImpl;
  sent: string[];
}

function makeHarness(opts: { withBroker?: boolean } = {}): Harness {
  const eventBroker = new WorkerEventBroker();
  const broker = new TaskReadyBrokerImpl();
  const sent: string[] = [];
  const controller = new AbortController();
  const router = createRPCRouter({});
  const dispatcher = new Dispatcher({
    router,
    broker: eventBroker,
    send: (text) => sent.push(text),
    signal: controller.signal,
    ...(opts.withBroker !== false ? { taskReadyBroker: broker } : {}),
  });
  return { dispatcher, broker, sent };
}

const ISO = '2026-05-13T00:00:00.000Z';

function makeEvent(overrides: Partial<TaskReadyEvent> = {}): TaskReadyEvent {
  return {
    kind: 'task_ready',
    task: {
      id: 'tk-b',
      projectId: 'p1',
      description: 'B',
      status: 'pending',
      priority: 0,
      dependsOn: ['tk-a'],
      notes: [],
      createdAt: ISO,
      updatedAt: ISO,
    },
    projectName: 'p1',
    unblockedBy: {
      id: 'tk-a',
      projectId: 'p1',
      description: 'A',
      status: 'completed',
      priority: 0,
      dependsOn: [],
      notes: [],
      createdAt: ISO,
      updatedAt: ISO,
      completedAt: ISO,
    },
    unblockedByProjectName: 'p1',
    headline: 'Task ready: B (p1) — A completed',
    ts: ISO,
    ...overrides,
  };
}

function parseFrames(sent: readonly string[]): Array<Record<string, unknown>> {
  return sent.map((text) => JSON.parse(text) as Record<string, unknown>);
}

describe('dispatcher — task-ready.events subscribe', () => {
  it('accepts the subscribe and returns the topic in the success envelope', async () => {
    const h = makeHarness();
    await h.dispatcher.handle(
      JSON.stringify({
        kind: 'subscribe',
        id: 'sub-1',
        topic: 'task-ready.events',
        args: undefined,
      }),
    );
    expect(parseFrames(h.sent)[0]).toMatchObject({
      kind: 'rpc-result',
      id: 'sub-1',
      result: { success: true, data: { topic: 'task-ready.events' } },
    });
  });

  it('forwards published events as event frames', async () => {
    const h = makeHarness();
    await h.dispatcher.handle(
      JSON.stringify({
        kind: 'subscribe',
        id: 'sub-1',
        topic: 'task-ready.events',
        args: undefined,
      }),
    );
    h.broker.publish(makeEvent());
    const frames = parseFrames(h.sent);
    expect(frames.some((f) => f.kind === 'event')).toBe(true);
    const evt = frames.find((f) => f.kind === 'event') as Record<string, unknown>;
    expect(evt.topic).toBe('task-ready.events');
    expect(evt.payload).toMatchObject({ kind: 'task_ready' });
  });

  it('returns not_found when broker is not configured', async () => {
    const h = makeHarness({ withBroker: false });
    await h.dispatcher.handle(
      JSON.stringify({
        kind: 'subscribe',
        id: 'sub-1',
        topic: 'task-ready.events',
        args: undefined,
      }),
    );
    const env = parseFrames(h.sent)[0] as { result: { success: boolean; error?: { code: string } } };
    expect(env.result.success).toBe(false);
    expect(env.result.error?.code).toBe('not_found');
  });

  it('rejects duplicate subscription ids (defensive — mirrors completions)', async () => {
    const h = makeHarness();
    await h.dispatcher.handle(
      JSON.stringify({
        kind: 'subscribe',
        id: 'sub-1',
        topic: 'task-ready.events',
        args: undefined,
      }),
    );
    await h.dispatcher.handle(
      JSON.stringify({
        kind: 'subscribe',
        id: 'sub-1',
        topic: 'task-ready.events',
        args: undefined,
      }),
    );
    const frames = parseFrames(h.sent);
    // First subscribe succeeded; second returns bad_args dup.
    expect(frames[0]).toMatchObject({ result: { success: true } });
    const second = frames[1] as { result: { success: boolean; error?: { code: string } } };
    expect(second.result.success).toBe(false);
    expect(second.result.error?.code).toBe('bad_args');
  });

  it('unsubscribe stops further event delivery', async () => {
    const h = makeHarness();
    await h.dispatcher.handle(
      JSON.stringify({
        kind: 'subscribe',
        id: 'sub-1',
        topic: 'task-ready.events',
        args: undefined,
      }),
    );
    await h.dispatcher.handle(
      JSON.stringify({ kind: 'unsubscribe', id: 'sub-1', topic: 'task-ready.events' }),
    );
    h.broker.publish(makeEvent());
    const events = parseFrames(h.sent).filter((f) => f.kind === 'event');
    expect(events).toHaveLength(0);
  });
});
