import React, { useEffect } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { Text } from 'ink';
import { useQuestions } from '../../../src/ui/data/useQuestions.js';
import type { TuiRpc } from '../../../src/ui/runtime/rpc.js';
import type { QuestionSnapshot } from '../../../src/state/question-registry.js';

/**
 * Phase 3E — `useQuestions` covers the same shape as `useWorkers`:
 *  - polled once at mount
 *  - polled at `pollIntervalMs` cadence (with `inFlightRef` skip)
 *  - sorts blocking-first, oldest-first
 *  - exposes `count` + `blockingCount` + error state
 */

interface PendingDeferred {
  resolve: (v: QuestionSnapshot[]) => void;
  reject: (e: unknown) => void;
}

interface FakeRpcHandle {
  rpc: TuiRpc;
  resolveNext(list: QuestionSnapshot[]): void;
  rejectNext(error: unknown): void;
  callCount(): number;
}

function makeFakeRpc(): FakeRpcHandle {
  const pending: PendingDeferred[] = [];
  let calls = 0;

  const list = vi.fn().mockImplementation((): Promise<QuestionSnapshot[]> => {
    calls += 1;
    return new Promise<QuestionSnapshot[]>((resolve, reject) => {
      pending.push({ resolve, reject });
    });
  });

  const stubMethod = (): unknown => vi.fn();

  const rpc: TuiRpc = {
    call: {
      projects: {
        list: stubMethod() as never,
        get: stubMethod() as never,
        register: stubMethod() as never,
      },
      tasks: {
        list: stubMethod() as never,
        get: stubMethod() as never,
        create: stubMethod() as never,
        update: stubMethod() as never,
      },
      workers: {
        list: stubMethod() as never,
        get: stubMethod() as never,
        kill: stubMethod() as never,
        tail: stubMethod() as never,
      },
      questions: {
        list,
        get: stubMethod() as never,
        answer: stubMethod() as never,
      },
      waves: {
        list: stubMethod() as never,
        get: stubMethod() as never,
      },
      mode: {
        get: stubMethod() as never,
      },
    },
    subscribe: vi.fn(),
    close: vi.fn(),
  } as unknown as TuiRpc;

  return {
    rpc,
    resolveNext(value): void {
      const next = pending.shift();
      if (!next) throw new Error('no pending questions.list call');
      next.resolve(value);
    },
    rejectNext(error): void {
      const next = pending.shift();
      if (!next) throw new Error('no pending questions.list call');
      next.reject(error);
    },
    callCount: () => calls,
  };
}

function snap(overrides: Partial<QuestionSnapshot>): QuestionSnapshot {
  return {
    id: overrides.id ?? 'q-1',
    question: overrides.question ?? 'q?',
    urgency: overrides.urgency ?? 'blocking',
    askedAt: overrides.askedAt ?? '2026-05-04T00:00:00.000Z',
    answered: false,
    ...(overrides.context !== undefined ? { context: overrides.context } : {}),
    ...(overrides.projectId !== undefined ? { projectId: overrides.projectId } : {}),
    ...(overrides.workerId !== undefined ? { workerId: overrides.workerId } : {}),
  };
}

function Probe({
  rpc,
  pollIntervalMs,
}: {
  readonly rpc: TuiRpc;
  readonly pollIntervalMs?: number;
}): React.JSX.Element {
  const r = useQuestions(
    rpc,
    pollIntervalMs !== undefined ? { pollIntervalMs } : undefined,
  );
  const ids = r.questions.map((q) => `${q.id}:${q.urgency}`).join(',');
  return (
    <Text>
      count={r.count} blocking={r.blockingCount} loading={String(r.loading)} error=
      {r.error?.message ?? '-'} ids=[{ids}]
    </Text>
  );
}

async function flushAsync(): Promise<void> {
  await new Promise((r) => setImmediate(r));
}

describe('useQuestions', () => {
  it('polls once at mount and reflects results', async () => {
    const fake = makeFakeRpc();
    const { lastFrame } = render(<Probe rpc={fake.rpc} pollIntervalMs={0} />);
    expect(lastFrame()).toContain('loading=true');
    fake.resolveNext([snap({ id: 'q-1', urgency: 'advisory' })]);
    await flushAsync();
    await flushAsync();
    expect(lastFrame()).toContain('count=1');
    expect(lastFrame()).toContain('blocking=0');
    expect(lastFrame()).toContain('loading=false');
    expect(lastFrame()).toContain('ids=[q-1:advisory]');
  });

  it('sorts blocking before advisory and older askedAt first', async () => {
    const fake = makeFakeRpc();
    const { lastFrame } = render(<Probe rpc={fake.rpc} pollIntervalMs={0} />);
    fake.resolveNext([
      snap({ id: 'q-adv-old', urgency: 'advisory', askedAt: '2026-05-01T00:00:00.000Z' }),
      snap({ id: 'q-block-new', urgency: 'blocking', askedAt: '2026-05-04T00:00:00.000Z' }),
      snap({ id: 'q-block-old', urgency: 'blocking', askedAt: '2026-05-02T00:00:00.000Z' }),
    ]);
    await flushAsync();
    await flushAsync();
    expect(lastFrame()).toContain('count=3');
    expect(lastFrame()).toContain('blocking=2');
    expect(lastFrame()).toContain(
      'ids=[q-block-old:blocking,q-block-new:blocking,q-adv-old:advisory]',
    );
  });

  it('surfaces RPC errors without crashing the hook', async () => {
    const fake = makeFakeRpc();
    const { lastFrame } = render(<Probe rpc={fake.rpc} pollIntervalMs={0} />);
    fake.rejectNext(new Error('rpc down'));
    await flushAsync();
    await flushAsync();
    expect(lastFrame()).toContain('error=rpc down');
    expect(lastFrame()).toContain('loading=false');
    expect(lastFrame()).toContain('count=0');
  });

  it('manual refresh dispatches another call', async () => {
    const fake = makeFakeRpc();
    function Wrapper(): React.JSX.Element {
      const r = useQuestions(fake.rpc, { pollIntervalMs: 0 });
      // Trigger one refresh after the initial settle.
      useEffect(() => {
        const t = setTimeout(() => r.refresh(), 5);
        return () => clearTimeout(t);
      }, [r]);
      return <Text>count={r.count}</Text>;
    }
    render(<Wrapper />);
    fake.resolveNext([snap({ id: 'q-1' })]);
    await flushAsync();
    await flushAsync();
    expect(fake.callCount()).toBe(1);
    await new Promise((r) => setTimeout(r, 20));
    fake.resolveNext([snap({ id: 'q-1' }), snap({ id: 'q-2' })]);
    await flushAsync();
    expect(fake.callCount()).toBeGreaterThanOrEqual(2);
  });

  it('skips a poll tick while a previous request is still in flight', async () => {
    vi.useFakeTimers();
    try {
      const fake = makeFakeRpc();
      render(<Probe rpc={fake.rpc} pollIntervalMs={50} />);
      // First call has fired but not resolved.
      expect(fake.callCount()).toBe(1);
      // Advance past several ticks WITHOUT resolving — inFlightRef must
      // suppress the additional dispatches.
      await vi.advanceTimersByTimeAsync(200);
      expect(fake.callCount()).toBe(1);
      fake.resolveNext([]);
      // Yield several microtasks so the `.finally` clears inFlightRef
      // AND the next setInterval tick can dispatch a fresh call.
      await vi.advanceTimersByTimeAsync(100);
      expect(fake.callCount()).toBeGreaterThanOrEqual(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
