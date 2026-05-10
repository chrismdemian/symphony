import React, { useEffect } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { Text } from 'ink';
import { useQueue } from '../../../src/ui/data/useQueue.js';
import type { PendingSpawnSnapshot } from '../../../src/rpc/router-impl.js';
import type { TuiRpc } from '../../../src/ui/runtime/rpc.js';

/**
 * Phase 3L — `useQueue` mirrors `useWorkers` / `useQuestions`:
 *  - polls once at mount
 *  - polls at `pollIntervalMs` cadence with `inFlightRef` skip-tick guard
 *  - surfaces RPC errors without crashing the hook
 *  - `refresh()` triggers an extra dispatch
 */

interface PendingDeferred {
  resolve: (v: readonly PendingSpawnSnapshot[]) => void;
  reject: (e: unknown) => void;
}

interface FakeRpcHandle {
  rpc: TuiRpc;
  resolveNext(list: readonly PendingSpawnSnapshot[]): void;
  rejectNext(error: unknown): void;
  callCount(): number;
}

function makeFakeRpc(): FakeRpcHandle {
  const pending: PendingDeferred[] = [];
  let calls = 0;
  const list = vi.fn().mockImplementation((): Promise<readonly PendingSpawnSnapshot[]> => {
    calls += 1;
    return new Promise<readonly PendingSpawnSnapshot[]>((resolve, reject) => {
      pending.push({ resolve, reject });
    });
  });
  const stubMethod = (): unknown => vi.fn();
  const rpc: TuiRpc = {
    call: {
      queue: {
        list,
        cancel: stubMethod() as never,
        reorder: stubMethod() as never,
      },
    },
    subscribe: vi.fn(),
    close: vi.fn(),
  } as unknown as TuiRpc;
  return {
    rpc,
    resolveNext(value): void {
      const next = pending.shift();
      if (!next) throw new Error('no pending queue.list call');
      next.resolve(value);
    },
    rejectNext(error): void {
      const next = pending.shift();
      if (!next) throw new Error('no pending queue.list call');
      next.reject(error);
    },
    callCount: () => calls,
  };
}

function pending(over: Partial<PendingSpawnSnapshot> = {}): PendingSpawnSnapshot {
  return {
    recordId: over.recordId ?? 'rec-1',
    projectPath: over.projectPath ?? '/projA',
    featureIntent: over.featureIntent ?? 'intent',
    taskDescription: over.taskDescription ?? 'task',
    enqueuedAt: over.enqueuedAt ?? 1000,
  };
}

function Probe({
  rpc,
  pollIntervalMs,
}: {
  readonly rpc: TuiRpc;
  readonly pollIntervalMs?: number;
}): React.JSX.Element {
  const r = useQueue(
    rpc,
    pollIntervalMs !== undefined ? { pollIntervalMs } : undefined,
  );
  const ids = r.pending.map((p) => p.recordId).join(',');
  return (
    <Text>
      n={r.pending.length} loading={String(r.loading)} error={r.error?.message ?? '-'} ids=[{ids}]
    </Text>
  );
}

async function flushAsync(): Promise<void> {
  await new Promise((r) => setImmediate(r));
}

describe('useQueue', () => {
  it('polls once at mount and reflects results', async () => {
    const fake = makeFakeRpc();
    const { lastFrame } = render(<Probe rpc={fake.rpc} pollIntervalMs={0} />);
    expect(lastFrame()).toContain('loading=true');
    fake.resolveNext([pending({ recordId: 'r-1' })]);
    await flushAsync();
    await flushAsync();
    expect(lastFrame()).toContain('n=1');
    expect(lastFrame()).toContain('loading=false');
    expect(lastFrame()).toContain('ids=[r-1]');
  });

  it('reflects multi-entry results in the order returned by the server', async () => {
    const fake = makeFakeRpc();
    const { lastFrame } = render(<Probe rpc={fake.rpc} pollIntervalMs={0} />);
    fake.resolveNext([
      pending({ recordId: 'a', enqueuedAt: 1000 }),
      pending({ recordId: 'b', enqueuedAt: 1100 }),
      pending({ recordId: 'c', enqueuedAt: 1200 }),
    ]);
    await flushAsync();
    await flushAsync();
    // Hook does NOT re-sort; server-side ordering wins.
    expect(lastFrame()).toContain('ids=[a,b,c]');
  });

  it('surfaces RPC errors without crashing the hook', async () => {
    const fake = makeFakeRpc();
    const { lastFrame } = render(<Probe rpc={fake.rpc} pollIntervalMs={0} />);
    fake.rejectNext(new Error('queue down'));
    await flushAsync();
    await flushAsync();
    expect(lastFrame()).toContain('error=queue down');
    expect(lastFrame()).toContain('loading=false');
    expect(lastFrame()).toContain('n=0');
  });

  it('manual refresh dispatches another call', async () => {
    const fake = makeFakeRpc();
    function Wrapper(): React.JSX.Element {
      const r = useQueue(fake.rpc, { pollIntervalMs: 0 });
      useEffect(() => {
        const t = setTimeout(() => r.refresh(), 5);
        return () => clearTimeout(t);
      }, [r]);
      return <Text>n={r.pending.length}</Text>;
    }
    render(<Wrapper />);
    fake.resolveNext([]);
    await flushAsync();
    await flushAsync();
    expect(fake.callCount()).toBe(1);
    await new Promise((r) => setTimeout(r, 20));
    fake.resolveNext([pending({ recordId: 'a' })]);
    await flushAsync();
    expect(fake.callCount()).toBeGreaterThanOrEqual(2);
  });

  it('skips a poll tick while a previous request is still in flight', async () => {
    vi.useFakeTimers();
    try {
      const fake = makeFakeRpc();
      render(<Probe rpc={fake.rpc} pollIntervalMs={50} />);
      expect(fake.callCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(200);
      expect(fake.callCount()).toBe(1);
      fake.resolveNext([]);
      await vi.advanceTimersByTimeAsync(100);
      expect(fake.callCount()).toBeGreaterThanOrEqual(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
