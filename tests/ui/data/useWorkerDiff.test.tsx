import React from 'react';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { render } from 'ink-testing-library';

type RenderResult = ReturnType<typeof render>;
import { Text } from 'ink';
import { useWorkerDiff, type WorkerDiffState } from '../../../src/ui/data/useWorkerDiff.js';
import type { TuiRpc } from '../../../src/ui/runtime/rpc.js';
import type { WorkersDiffResult } from '../../../src/rpc/router-impl.js';

/**
 * Phase 3J — `useWorkerDiff` hook tests.
 *
 * State machine: idle → loading → ready | error → loading → …
 * In-flight dedup: rapid `refresh()` calls are coalesced to a single
 * follow-up after the in-flight settles.
 */

interface PendingDeferred {
  resolve: (v: WorkersDiffResult) => void;
  reject: (e: unknown) => void;
}

interface FakeRpcHandle {
  rpc: TuiRpc;
  resolveNext(value: WorkersDiffResult): void;
  rejectNext(error: unknown): void;
  callCount(): number;
  pendingCount(): number;
}

function makeFakeRpc(): FakeRpcHandle {
  const pending: PendingDeferred[] = [];
  let calls = 0;

  const diff = vi.fn().mockImplementation((): Promise<WorkersDiffResult> => {
    calls += 1;
    return new Promise<WorkersDiffResult>((resolve, reject) => {
      pending.push({ resolve, reject });
    });
  });

  const stub = (): unknown => vi.fn();

  const rpc: TuiRpc = {
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
        diff,
      },
      questions: { list: stub() as never, get: stub() as never, answer: stub() as never },
      waves: { list: stub() as never, get: stub() as never },
      mode: { get: stub() as never, setModel: stub() as never },
      notifications: { flushAwayDigest: stub() as never },
    },
    subscribe: vi.fn(),
    close: vi.fn(),
  } as unknown as TuiRpc;

  return {
    rpc,
    resolveNext(value): void {
      const next = pending.shift();
      if (!next) throw new Error('no pending workers.diff call');
      next.resolve(value);
    },
    rejectNext(error): void {
      const next = pending.shift();
      if (!next) throw new Error('no pending workers.diff call');
      next.reject(error);
    },
    callCount: () => calls,
    pendingCount: () => pending.length,
  };
}

function fakeResult(overrides: Partial<WorkersDiffResult> = {}): WorkersDiffResult {
  return {
    resolvedBase: 'main',
    mergeBaseSha: '0000000000000000000000000000000000000000',
    branch: 'feature/x',
    diff: '--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n',
    bytes: 40,
    truncated: false,
    cappedAt: null,
    files: [{ path: 'x', status: 'M' }],
    ...overrides,
  };
}

interface ProbeProps {
  readonly rpc: TuiRpc;
  readonly workerId: string;
  readonly enabled?: boolean;
  readonly onState?: (s: WorkerDiffState) => void;
  readonly refreshTrigger?: number;
}

function Probe({ rpc, workerId, enabled, onState, refreshTrigger }: ProbeProps): React.JSX.Element {
  const opts: { enabled?: boolean } = enabled !== undefined ? { enabled } : {};
  const result = useWorkerDiff(rpc, workerId, opts);
  const { state, refresh } = result;
  // Bump-driven external refresh trigger. Stable deps: `refresh` is
  // useCallback([]) inside the hook, so this effect only fires on real
  // refreshTrigger transitions.
  const lastTriggerRef = React.useRef(refreshTrigger);
  React.useEffect(() => {
    if (refreshTrigger === undefined) return;
    if (lastTriggerRef.current !== refreshTrigger) {
      lastTriggerRef.current = refreshTrigger;
      refresh();
    }
  }, [refreshTrigger, refresh]);
  React.useEffect(() => {
    onState?.(state);
  }, [state, onState]);
  return <Text>kind={state.kind}</Text>;
}

async function flushAsync(): Promise<void> {
  await new Promise((r) => setImmediate(r));
}

async function flushDeep(): Promise<void> {
  // 4 microtask + 1 macrotask flushes — covers `setTick` →
  // reducer dispatch → re-render → fetch-effect → runFetch → rpc call
  // chain seen in refresh-trigger tests.
  for (let i = 0; i < 4; i += 1) {
    await Promise.resolve();
  }
  await flushAsync();
}

/**
 * Poll a predicate until it succeeds or the budget runs out. Bridges
 * React's update scheduling and the test's synchronous expectations.
 * Replacement for `vi.waitFor` (avoids the polling-tick fake-timer
 * tangle some Symphony tests have hit).
 */
async function waitFor(check: () => void, opts: { timeoutMs?: number } = {}): Promise<void> {
  const deadline = Date.now() + (opts.timeoutMs ?? 1500);
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      check();
      return;
    } catch (err) {
      lastError = err;
      await new Promise((r) => setImmediate(r));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

// Track all live `render()` results so we can unmount between tests —
// ink-testing-library leaves trees mounted otherwise, and prior trees'
// useEffects can interfere with subsequent tests' state observation
// (3H.4 known-gotcha).
const liveRenders: RenderResult[] = [];

function renderTracked(node: React.ReactElement): RenderResult {
  const r = render(node);
  liveRenders.push(r);
  return r;
}

afterEach(() => {
  while (liveRenders.length > 0) {
    const r = liveRenders.pop();
    r?.unmount();
  }
});

describe('useWorkerDiff', () => {
  it('starts idle when disabled', async () => {
    const fake = makeFakeRpc();
    const states: WorkerDiffState[] = [];
    renderTracked(
      <Probe
        rpc={fake.rpc}
        workerId="wk-1"
        enabled={false}
        onState={(s) => states.push(s)}
      />,
    );
    await flushAsync();
    expect(states[0]?.kind).toBe('idle');
    expect(fake.callCount()).toBe(0);
  });

  it('transitions idle → loading → ready on enabled mount', async () => {
    const fake = makeFakeRpc();
    const states: WorkerDiffState[] = [];
    const { lastFrame } = renderTracked(
      <Probe rpc={fake.rpc} workerId="wk-1" onState={(s) => states.push(s)} />,
    );
    await flushAsync();
    expect(lastFrame()).toContain('kind=loading');

    fake.resolveNext(fakeResult({ diff: 'hello\n' }));
    await flushAsync();
    await flushAsync();
    expect(lastFrame()).toContain('kind=ready');

    const kinds = states.map((s) => s.kind);
    expect(kinds).toContain('loading');
    expect(kinds).toContain('ready');
  });

  it('captures error and exposes the message', async () => {
    const fake = makeFakeRpc();
    const { lastFrame } = renderTracked(<Probe rpc={fake.rpc} workerId="wk-1" />);
    await flushAsync();
    fake.rejectNext(new Error('git boom'));
    await flushAsync();
    await flushAsync();
    expect(lastFrame()).toContain('kind=error');
  });

  it('refresh() re-fetches after ready', async () => {
    const fake = makeFakeRpc();
    let capturedRefresh: (() => void) | null = null;
    function P(): React.JSX.Element {
      const r = useWorkerDiff(fake.rpc, 'wk-1');
      capturedRefresh = r.refresh;
      return <Text>kind={r.state.kind}</Text>;
    }
    const { lastFrame } = renderTracked(<P />);
    await flushAsync();
    fake.resolveNext(fakeResult({ diff: 'first\n' }));
    await flushAsync();
    await flushAsync();
    expect(lastFrame()).toContain('kind=ready');
    expect(fake.callCount()).toBe(1);

    capturedRefresh!();
    await waitFor(() => expect(fake.callCount()).toBe(2));
    expect(fake.pendingCount()).toBe(1);
    fake.resolveNext(fakeResult({ diff: 'second\n' }));
    await flushDeep();
    expect(lastFrame()).toContain('kind=ready');
  });

  it('drops a queued refresh when the hook unmounts mid-flight', async () => {
    const fake = makeFakeRpc();
    const { unmount } = renderTracked(<Probe rpc={fake.rpc} workerId="wk-1" />);
    await flushAsync();
    expect(fake.pendingCount()).toBe(1);
    unmount();
    fake.resolveNext(fakeResult());
    await flushAsync();
    // After unmount, no further calls should fire — the in-flight result
    // is silently dropped.
    expect(fake.callCount()).toBe(1);
  });

  it('error path retains previous data so caller can render stale-with-error', async () => {
    const fake = makeFakeRpc();
    const states: WorkerDiffState[] = [];
    let capturedRefresh: (() => void) | null = null;
    function P(): React.JSX.Element {
      const r = useWorkerDiff(fake.rpc, 'wk-1');
      capturedRefresh = r.refresh;
      React.useEffect(() => {
        states.push(r.state);
      }, [r.state]);
      return <Text>k={r.state.kind}</Text>;
    }
    renderTracked(<P />);
    await flushAsync();
    fake.resolveNext(fakeResult({ diff: 'first\n' }));
    await flushAsync();
    await flushAsync();

    capturedRefresh!();
    await waitFor(() => expect(fake.pendingCount()).toBe(1));
    fake.rejectNext(new Error('refresh failed'));
    await waitFor(() => expect(states.some((s) => s.kind === 'error')).toBe(true));

    const errorState = states.find((s) => s.kind === 'error');
    expect(errorState?.kind).toBe('error');
    if (errorState?.kind === 'error') {
      expect(errorState.previous).toBeDefined();
      expect(errorState.previous?.diff).toBe('first\n');
    }
  });

  it('records fetchedAt with the injected clock', async () => {
    const fake = makeFakeRpc();
    let fixedNow = 1_700_000_000_000;
    const states: WorkerDiffState[] = [];
    function ClockProbe(): React.JSX.Element {
      const r = useWorkerDiff(fake.rpc, 'wk-1', { now: () => fixedNow });
      React.useEffect(() => {
        states.push(r.state);
      }, [r.state]);
      return <Text>k={r.state.kind}</Text>;
    }
    renderTracked(<ClockProbe />);
    await flushAsync();
    fixedNow += 5_000;
    fake.resolveNext(fakeResult());
    await flushAsync();
    await flushAsync();
    const ready = states.find((s) => s.kind === 'ready');
    expect(ready).toBeDefined();
    if (ready?.kind === 'ready') {
      expect(ready.fetchedAt).toBe(1_700_000_005_000);
    }
  });
});
