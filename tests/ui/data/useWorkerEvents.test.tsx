import React, { useEffect } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { Text } from 'ink';
import { useWorkerEvents } from '../../../src/ui/data/useWorkerEvents.js';
import type { TuiRpc } from '../../../src/ui/runtime/rpc.js';
import type { StreamEvent } from '../../../src/workers/types.js';

/**
 * Subscribe + backfill machinery is the load-bearing piece of 3D.1.
 *
 * Strategy: build a fake TuiRpc whose `subscribe` returns a controllable
 * subscription handle and whose `workers.tail` returns a controllable
 * promise. Then a `<Probe>` component reads `useWorkerEvents` and
 * stringifies state into the rendered frame.
 */

interface FakeSubscription {
  emit(event: StreamEvent): void;
  unsubscribed: boolean;
}

interface FakeRpcHandle {
  rpc: TuiRpc;
  /** Resolve `workers.tail` with the given backfill payload. */
  resolveTail(events: StreamEvent[], total?: number): void;
  /** Reject `workers.tail`. */
  rejectTail(error: unknown): void;
  /** Get the controller for the active subscription (asserts there is one). */
  subscription(): FakeSubscription;
  /** Get the most recent workerId passed to subscribe. */
  lastSubscribeWorkerId(): string;
  /** Total subscribe calls observed (one per workerId mount/change). */
  subscribeCallCount(): number;
}

function makeFakeRpc(): FakeRpcHandle {
  const subs: Array<{
    workerId: string;
    listener: (event: unknown) => void;
    unsubscribed: boolean;
    handle: FakeSubscription;
  }> = [];

  let pendingTail: { resolve: (v: unknown) => void; reject: (e: unknown) => void } | null = null;

  const rpc: TuiRpc = {
    call: {
      projects: {
        list: vi.fn(),
        get: vi.fn(),
        register: vi.fn(),
      },
      tasks: {
        list: vi.fn(),
        get: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
      },
      workers: {
        list: vi.fn(),
        get: vi.fn(),
        kill: vi.fn(),
        tail: vi.fn().mockImplementation(() => {
          return new Promise((resolve, reject) => {
            pendingTail = { resolve, reject };
          });
        }),
      },
      questions: {
        list: vi.fn(),
        get: vi.fn(),
        answer: vi.fn(),
      },
      waves: {
        list: vi.fn(),
        get: vi.fn(),
      },
      mode: {
        get: vi.fn(),
      },
    },
    subscribe: vi.fn(async (_topic: string, args: unknown, listener: (e: unknown) => void) => {
      const workerId = (args as { workerId: string }).workerId;
      const entry = {
        workerId,
        listener,
        unsubscribed: false,
        handle: {
          emit(event: StreamEvent): void {
            entry.listener(event);
          },
          get unsubscribed(): boolean {
            return entry.unsubscribed;
          },
        } as FakeSubscription,
      };
      subs.push(entry);
      return {
        topic: 'workers.events',
        unsubscribe: async (): Promise<void> => {
          entry.unsubscribed = true;
        },
      };
    }) as unknown as TuiRpc['subscribe'],
    close: vi.fn(),
  } as unknown as TuiRpc;

  return {
    rpc,
    resolveTail(events: StreamEvent[], total = events.length): void {
      if (pendingTail === null) throw new Error('no pending workers.tail call');
      pendingTail.resolve({ events, total });
      pendingTail = null;
    },
    rejectTail(error: unknown): void {
      if (pendingTail === null) throw new Error('no pending workers.tail call');
      pendingTail.reject(error);
      pendingTail = null;
    },
    subscription(): FakeSubscription {
      const last = subs[subs.length - 1];
      if (last === undefined) throw new Error('no subscription yet');
      return last.handle;
    },
    lastSubscribeWorkerId(): string {
      const last = subs[subs.length - 1];
      if (last === undefined) throw new Error('no subscription yet');
      return last.workerId;
    },
    subscribeCallCount(): number {
      return subs.length;
    },
  };
}

interface ProbeProps {
  readonly rpc: TuiRpc;
  readonly workerId: string;
  readonly onState?: (state: unknown) => void;
}

function Probe({ rpc, workerId, onState }: ProbeProps): React.JSX.Element {
  const state = useWorkerEvents(rpc, workerId);
  useEffect(() => {
    onState?.(state);
  }, [state, onState]);
  const summary =
    `events=${state.events.length}` +
    ` ready=${state.backfillReady ? 'y' : 'n'}` +
    ` retry=${state.lastRetryEvent === null ? 'no' : `attempt-${state.lastRetryEvent.attempt}`}` +
    ` err=${state.subscribeError === null ? 'no' : state.subscribeError.message}`;
  return <Text>{summary}</Text>;
}

function flushMicrotasks(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}

const text = (t: string): StreamEvent => ({ type: 'assistant_text', text: t });
const retry = (attempt: number, delayMs = 5000): StreamEvent => ({
  type: 'system_api_retry',
  attempt,
  delayMs,
  raw: { attempt, delayMs },
});

describe('useWorkerEvents', () => {
  it('subscribes once on mount with the requested workerId', async () => {
    const handle = makeFakeRpc();
    const tree = render(<Probe rpc={handle.rpc} workerId="w-1" />);
    await flushMicrotasks();
    await flushMicrotasks();
    expect(handle.subscribeCallCount()).toBe(1);
    expect(handle.lastSubscribeWorkerId()).toBe('w-1');
    tree.unmount();
  });

  it('resubscribes when workerId changes', async () => {
    const handle = makeFakeRpc();
    const tree = render(<Probe rpc={handle.rpc} workerId="w-1" />);
    await flushMicrotasks();
    await flushMicrotasks();
    const firstSub = handle.subscription();
    expect(handle.subscribeCallCount()).toBe(1);

    tree.rerender(<Probe rpc={handle.rpc} workerId="w-2" />);
    await flushMicrotasks();
    await flushMicrotasks();
    expect(handle.subscribeCallCount()).toBe(2);
    expect(handle.lastSubscribeWorkerId()).toBe('w-2');
    expect(firstSub.unsubscribed).toBe(true);
    tree.unmount();
  });

  it('unsubscribes on unmount', async () => {
    const handle = makeFakeRpc();
    const tree = render(<Probe rpc={handle.rpc} workerId="w-1" />);
    await flushMicrotasks();
    await flushMicrotasks();
    const sub = handle.subscription();
    tree.unmount();
    await flushMicrotasks();
    expect(sub.unsubscribed).toBe(true);
  });

  it('queues live events into pending until backfill resolves, then merges', async () => {
    const handle = makeFakeRpc();
    const tree = render(<Probe rpc={handle.rpc} workerId="w-1" />);
    await flushMicrotasks();
    await flushMicrotasks();

    // Live event arrives BEFORE backfill resolves — must NOT be in events yet.
    handle.subscription().emit(text('live-during-wait'));
    await flushMicrotasks();
    expect(tree.lastFrame()).toContain('events=0');
    expect(tree.lastFrame()).toContain('ready=n');

    // Now backfill resolves with one event.
    handle.resolveTail([text('past-1')]);
    await flushMicrotasks();
    await flushMicrotasks();
    expect(tree.lastFrame()).toContain('events=2');
    expect(tree.lastFrame()).toContain('ready=y');

    // Subsequent live event flows straight through.
    handle.subscription().emit(text('after-merge'));
    await flushMicrotasks();
    expect(tree.lastFrame()).toContain('events=3');
    tree.unmount();
  });

  it('surfaces tail RPC failure via subscribeError without dropping live events', async () => {
    const handle = makeFakeRpc();
    const tree = render(<Probe rpc={handle.rpc} workerId="w-1" />);
    await flushMicrotasks();
    await flushMicrotasks();
    handle.rejectTail(new Error('tail failed'));
    await flushMicrotasks();
    await flushMicrotasks();
    expect(tree.lastFrame()).toContain('err=tail failed');
    expect(tree.lastFrame()).toContain('ready=n');
    tree.unmount();
  });

  it('rate-limit retry events flip the lastRetryEvent banner', async () => {
    const handle = makeFakeRpc();
    const tree = render(<Probe rpc={handle.rpc} workerId="w-1" />);
    await flushMicrotasks();
    await flushMicrotasks();
    handle.resolveTail([]);
    await flushMicrotasks();
    await flushMicrotasks();

    handle.subscription().emit(retry(2));
    await flushMicrotasks();
    expect(tree.lastFrame()).toContain('retry=attempt-2');

    handle.subscription().emit(text('back online'));
    await flushMicrotasks();
    expect(tree.lastFrame()).toContain('retry=no');
    tree.unmount();
  });
});
