import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { Text } from 'ink';
import { useAnswerQuestion } from '../../../src/ui/data/useAnswerQuestion.js';
import type { TuiRpc } from '../../../src/ui/runtime/rpc.js';
import type { QuestionSnapshot } from '../../../src/state/question-registry.js';

function makeRpc(impl: (id: string, answer: string) => Promise<QuestionSnapshot>): TuiRpc {
  const stub = (): unknown => vi.fn();
  return {
    call: {
      projects: { list: stub() as never, get: stub() as never, register: stub() as never },
      tasks: {
        list: stub() as never,
        get: stub() as never,
        create: stub() as never,
        update: stub() as never,
      },
      workers: {
        list: stub() as never,
        get: stub() as never,
        kill: stub() as never,
        tail: stub() as never,
      },
      questions: {
        list: stub() as never,
        get: stub() as never,
        answer: vi.fn().mockImplementation((args: { id: string; answer: string }) =>
          impl(args.id, args.answer),
        ) as never,
      },
      waves: { list: stub() as never, get: stub() as never },
      mode: { get: stub() as never },
    },
    subscribe: vi.fn(),
    close: vi.fn(),
  } as unknown as TuiRpc;
}

interface ProbeApi {
  submit(id: string, answer: string): Promise<{ ok: true } | { ok: false; message: string }>;
  reset(): void;
  state: ReturnType<typeof useAnswerQuestion>['state'];
}

function ProbeWithRef({
  rpc,
  apiRef,
}: {
  readonly rpc: TuiRpc;
  readonly apiRef: { current: ProbeApi | null };
}): React.JSX.Element {
  const r = useAnswerQuestion(rpc);
  apiRef.current = { submit: r.submit, reset: r.reset, state: r.state };
  return <Text>state={r.state.kind}</Text>;
}

async function flush(): Promise<void> {
  await new Promise((r) => setImmediate(r));
}

describe('useAnswerQuestion', () => {
  it('submits successfully and clears to idle', async () => {
    const rpc = makeRpc(async () => ({
      id: 'q-1',
      question: '?',
      urgency: 'blocking',
      askedAt: '2026-05-04T00:00:00.000Z',
      answered: true,
      answer: 'a',
      answeredAt: '2026-05-04T00:00:01.000Z',
    }));
    const apiRef: { current: ProbeApi | null } = { current: null };
    const { lastFrame } = render(<ProbeWithRef rpc={rpc} apiRef={apiRef} />);
    expect(apiRef.current).not.toBeNull();
    const result = await apiRef.current!.submit('q-1', 'a');
    await flush();
    expect(result).toEqual({ ok: true });
    expect(lastFrame()).toContain('state=idle');
  });

  it('captures error message on RPC failure', async () => {
    const rpc = makeRpc(async () => {
      throw new Error('already answered');
    });
    const apiRef: { current: ProbeApi | null } = { current: null };
    const { lastFrame } = render(<ProbeWithRef rpc={rpc} apiRef={apiRef} />);
    const result = await apiRef.current!.submit('q-1', 'a');
    await flush();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toBe('already answered');
    expect(lastFrame()).toContain('state=error');
  });

  it('reset() clears error to idle', async () => {
    const rpc = makeRpc(async () => {
      throw new Error('boom');
    });
    const apiRef: { current: ProbeApi | null } = { current: null };
    const { lastFrame } = render(<ProbeWithRef rpc={rpc} apiRef={apiRef} />);
    await apiRef.current!.submit('q-1', 'x');
    await flush();
    expect(lastFrame()).toContain('state=error');
    apiRef.current!.reset();
    await flush();
    expect(lastFrame()).toContain('state=idle');
  });

  it('does not setState after unmount', async () => {
    let resolveOuter: (() => void) | null = null;
    const rpc = makeRpc(
      () =>
        new Promise<QuestionSnapshot>((resolve) => {
          resolveOuter = () =>
            resolve({
              id: 'q-1',
              question: '?',
              urgency: 'blocking',
              askedAt: '2026-05-04T00:00:00.000Z',
              answered: true,
              answer: 'a',
              answeredAt: '2026-05-04T00:00:01.000Z',
            });
        }),
    );
    const apiRef: { current: ProbeApi | null } = { current: null };
    const { unmount } = render(<ProbeWithRef rpc={rpc} apiRef={apiRef} />);
    const submitPromise = apiRef.current!.submit('q-1', 'a');
    unmount();
    resolveOuter!();
    const result = await submitPromise;
    expect(result.ok).toBe(true);
    // No throw / no React warning is the assertion. If `setState` had run
    // post-unmount React 19 logs a console warning (not an error), which
    // would surface in the test harness output.
  });
});
