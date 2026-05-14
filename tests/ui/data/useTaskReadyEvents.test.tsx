import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { Text } from 'ink';
import { useTaskReadyEvents } from '../../../src/ui/data/useTaskReadyEvents.js';
import type { TuiRpc } from '../../../src/ui/runtime/rpc.js';
import type { TaskReadyEvent } from '../../../src/orchestrator/task-ready-types.js';
import type { SystemSummary } from '../../../src/ui/data/chatHistoryReducer.js';

/**
 * Phase 3P — useTaskReadyEvents hook tests.
 *
 * Mirrors `useCompletionEvents.test.tsx`: build a fake TuiRpc whose
 * subscribe returns a controllable handle, mount a Probe, drive the
 * listener directly, assert pushSystem invocations + mapping shape.
 */

const ISO = '2026-05-13T00:00:00.000Z';

interface FakeSubscription {
  emit(event: TaskReadyEvent): void;
  unsubscribed: boolean;
}

interface FakeRpcHandle {
  rpc: TuiRpc;
  subscription(): FakeSubscription;
  subscribeCallCount(): number;
}

function makeFakeRpc(opts: { rejectSubscribe?: boolean } = {}): FakeRpcHandle {
  const subs: Array<{
    listener: (e: unknown) => void;
    unsubscribed: boolean;
    handle: FakeSubscription;
  }> = [];
  const rpc: TuiRpc = {
    call: {} as never,
    subscribe: vi.fn(async (_topic: string, _args: unknown, listener: (e: unknown) => void) => {
      if (opts.rejectSubscribe) {
        throw new Error('topic not configured');
      }
      const entry = {
        listener,
        unsubscribed: false,
        handle: {
          emit(event: TaskReadyEvent): void {
            entry.listener(event);
          },
          get unsubscribed(): boolean {
            return entry.unsubscribed;
          },
        } as FakeSubscription,
      };
      subs.push(entry);
      return {
        topic: 'task-ready.events',
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

interface ProbeProps {
  readonly rpc: TuiRpc;
  readonly pushSystem: (summary: SystemSummary) => void;
}

function Probe(props: ProbeProps): React.JSX.Element {
  useTaskReadyEvents({ rpc: props.rpc, pushSystem: props.pushSystem });
  return <Text>probe</Text>;
}

function flush(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}

describe('useTaskReadyEvents', () => {
  it('subscribes to task-ready.events on mount', async () => {
    const fake = makeFakeRpc();
    const pushSystem = vi.fn();
    const { unmount } = render(<Probe rpc={fake.rpc} pushSystem={pushSystem} />);
    await flush();
    expect(fake.subscribeCallCount()).toBe(1);
    expect(fake.rpc.subscribe).toHaveBeenCalledWith(
      'task-ready.events',
      undefined,
      expect.any(Function),
    );
    unmount();
  });

  it('forwards each event as a SystemSummary with statusKind=completed', async () => {
    const fake = makeFakeRpc();
    const pushSystem = vi.fn();
    const { unmount } = render(<Probe rpc={fake.rpc} pushSystem={pushSystem} />);
    await flush();
    fake.subscription().emit(makeEvent());
    expect(pushSystem).toHaveBeenCalledOnce();
    const summary = pushSystem.mock.calls[0]?.[0] as SystemSummary;
    expect(summary.statusKind).toBe('completed');
    expect(summary.projectName).toBe('p1');
    expect(summary.headline).toContain('Task ready: B');
    expect(summary.workerId).toBe('task-ready-tk-b');
    expect(summary.workerName).toBe('Symphony');
    expect(summary.durationMs).toBeNull();
    expect(summary.fallback).toBe(false);
    unmount();
  });

  it('passes headline through verbatim (server-side formatted)', async () => {
    const fake = makeFakeRpc();
    const pushSystem = vi.fn();
    const { unmount } = render(<Probe rpc={fake.rpc} pushSystem={pushSystem} />);
    await flush();
    const customHeadline =
      'Task ready: Frontend wired (Frontend) — Pipeline API: filter endpoint (CRE Pipeline) completed';
    fake.subscription().emit(makeEvent({ headline: customHeadline }));
    const summary = pushSystem.mock.calls[0]?.[0] as SystemSummary;
    expect(summary.headline).toBe(customHeadline);
    unmount();
  });

  it('unsubscribes on unmount', async () => {
    const fake = makeFakeRpc();
    const pushSystem = vi.fn();
    const { unmount } = render(<Probe rpc={fake.rpc} pushSystem={pushSystem} />);
    await flush();
    expect(fake.subscription().unsubscribed).toBe(false);
    unmount();
    // Unmount triggers cleanup synchronously; the unsubscribe future
    // resolves on the next microtask.
    await flush();
    expect(fake.subscription().unsubscribed).toBe(true);
  });

  it('swallows subscribe failure (server downgrade scenario)', async () => {
    const fake = makeFakeRpc({ rejectSubscribe: true });
    const pushSystem = vi.fn();
    // Must not throw at render time; the chat panel keeps working for
    // normal Maestro events even if the orchestrator doesn't support
    // task-ready events (older server build, etc.).
    expect(() => render(<Probe rpc={fake.rpc} pushSystem={pushSystem} />)).not.toThrow();
    await flush();
    expect(pushSystem).not.toHaveBeenCalled();
  });
});
