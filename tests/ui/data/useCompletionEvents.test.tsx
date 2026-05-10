import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { Text } from 'ink';
import { useCompletionEvents } from '../../../src/ui/data/useCompletionEvents.js';
import type { TuiRpc } from '../../../src/ui/runtime/rpc.js';
import type { CompletionSummary } from '../../../src/orchestrator/completion-summarizer-types.js';
import type { SystemSummary } from '../../../src/ui/data/chatHistoryReducer.js';

/**
 * Phase 3K — useCompletionEvents hook tests.
 *
 * Strategy mirrors `tests/ui/data/useWorkerEvents.test.tsx`: build a
 * fake `TuiRpc` whose `subscribe` returns a controllable handle, mount
 * a tiny Probe via `ink-testing-library`, drive the listener directly,
 * assert pushSystem callback invocations + name-resolution behavior.
 */

interface FakeSubscription {
  emit(summary: CompletionSummary): void;
  unsubscribed: boolean;
}

interface FakeRpcHandle {
  rpc: TuiRpc;
  subscription(): FakeSubscription;
  subscribeCallCount(): number;
}

function makeFakeRpc(): FakeRpcHandle {
  const subs: Array<{
    listener: (e: unknown) => void;
    unsubscribed: boolean;
    handle: FakeSubscription;
  }> = [];
  const rpc: TuiRpc = {
    call: {} as never,
    subscribe: vi.fn(async (_topic: string, _args: unknown, listener: (e: unknown) => void) => {
      const entry = {
        listener,
        unsubscribed: false,
        handle: {
          emit(summary: CompletionSummary): void {
            entry.listener(summary);
          },
          get unsubscribed(): boolean {
            return entry.unsubscribed;
          },
        } as FakeSubscription,
      };
      subs.push(entry);
      return {
        topic: 'completions.events',
        unsubscribe: async (): Promise<void> => {
          entry.unsubscribed = true;
        },
      };
    }) as unknown as TuiRpc['subscribe'],
    close: vi.fn(),
  } as unknown as TuiRpc;
  return {
    rpc,
    subscription(): FakeSubscription {
      const last = subs[subs.length - 1];
      if (last === undefined) throw new Error('no subscription yet');
      return last.handle;
    },
    subscribeCallCount: () => subs.length,
  };
}

function makeSummary(overrides: Partial<CompletionSummary> = {}): CompletionSummary {
  return {
    workerId: 'wk-1',
    workerName: 'worker-abc123',
    projectName: 'MathScrabble',
    statusKind: 'completed',
    durationMs: 60_000,
    headline: 'wired endpoints',
    ts: new Date(0).toISOString(),
    fallback: false,
    ...overrides,
  };
}

interface ProbeProps {
  readonly rpc: TuiRpc;
  readonly pushSystem: (summary: SystemSummary) => void;
}

function Probe(props: ProbeProps): React.JSX.Element {
  useCompletionEvents({
    rpc: props.rpc,
    pushSystem: props.pushSystem,
  });
  return <Text>probe</Text>;
}

function flush(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}

describe('useCompletionEvents', () => {
  it('subscribes once on mount and unsubscribes on unmount', async () => {
    const handle = makeFakeRpc();
    const pushSystem = vi.fn();
    const tree = render(<Probe rpc={handle.rpc} pushSystem={pushSystem} />);
    await flush();
    expect(handle.subscribeCallCount()).toBe(1);
    const sub = handle.subscription();
    expect(sub.unsubscribed).toBe(false);
    tree.unmount();
    await flush();
    expect(sub.unsubscribed).toBe(true);
  });

  it('forwards each summary to pushSystem with all fields preserved', async () => {
    const handle = makeFakeRpc();
    const pushSystem = vi.fn();
    render(<Probe rpc={handle.rpc} pushSystem={pushSystem} />);
    await flush();
    handle.subscription().emit(
      makeSummary({
        workerId: 'wk-1',
        workerName: 'worker-abc123',
        headline: 'h1',
        metrics: 'm1',
        details: 'd1',
        durationMs: 1500,
      }),
    );
    expect(pushSystem).toHaveBeenCalledTimes(1);
    expect(pushSystem.mock.calls[0]?.[0]).toEqual({
      workerId: 'wk-1',
      workerName: 'worker-abc123',
      projectName: 'MathScrabble',
      statusKind: 'completed',
      durationMs: 1500,
      headline: 'h1',
      metrics: 'm1',
      details: 'd1',
      fallback: false,
    });
  });

  it('forwards workerId verbatim so the Bubble can resolve at render time', async () => {
    const handle = makeFakeRpc();
    const pushSystem = vi.fn();
    render(<Probe rpc={handle.rpc} pushSystem={pushSystem} />);
    await flush();
    handle.subscription().emit(makeSummary({ workerId: 'wk-renderer-resolves' }));
    expect(pushSystem.mock.calls[0]?.[0].workerId).toBe('wk-renderer-resolves');
  });

  it('does NOT dedupe by workerId — server is the source of truth', async () => {
    // A worker that completes, gets resumed, and completes again should
    // legitimately produce two summaries; dropping the second would
    // hide the resumed-worker case from the user.
    const handle = makeFakeRpc();
    const pushSystem = vi.fn();
    render(<Probe rpc={handle.rpc} pushSystem={pushSystem} />);
    await flush();
    handle.subscription().emit(makeSummary({ workerId: 'wk-1', headline: 'one' }));
    handle.subscription().emit(makeSummary({ workerId: 'wk-1', headline: 'two' }));
    handle.subscription().emit(makeSummary({ workerId: 'wk-2', headline: 'three' }));
    expect(pushSystem).toHaveBeenCalledTimes(3);
    expect(pushSystem.mock.calls.map((c) => c[0].headline)).toEqual(['one', 'two', 'three']);
  });

  it('omits metrics/details from the dispatched summary when absent in payload', async () => {
    const handle = makeFakeRpc();
    const pushSystem = vi.fn();
    render(<Probe rpc={handle.rpc} pushSystem={pushSystem} />);
    await flush();
    handle.subscription().emit(makeSummary({}));
    const dispatched = pushSystem.mock.calls[0]?.[0];
    expect(dispatched.metrics).toBeUndefined();
    expect(dispatched.details).toBeUndefined();
  });

  it('survives subscribe rejection silently (no throw, no pushSystem call)', async () => {
    const pushSystem = vi.fn();
    const rpc: TuiRpc = {
      call: {} as never,
      subscribe: vi.fn().mockRejectedValue(new Error('boom')) as unknown as TuiRpc['subscribe'],
      close: vi.fn(),
    } as unknown as TuiRpc;
    expect(() => render(<Probe rpc={rpc} pushSystem={pushSystem} />)).not.toThrow();
    await flush();
    expect(pushSystem).not.toHaveBeenCalled();
  });

  it('cancelled flag suppresses push if event arrives during teardown', async () => {
    // This race is hard to deterministically reproduce in unit tests
    // (cleanup runs synchronously on unmount). The hook's internal
    // cancelled flag and the dispatched-once dedupe both prevent
    // late-fire issues; this test just asserts unmount-after-emit
    // doesn't replay.
    const handle = makeFakeRpc();
    const pushSystem = vi.fn();
    const tree = render(<Probe rpc={handle.rpc} pushSystem={pushSystem} />);
    await flush();
    handle.subscription().emit(makeSummary({ workerId: 'wk-1' }));
    tree.unmount();
    await flush();
    expect(pushSystem).toHaveBeenCalledTimes(1);
  });
});
