import React from 'react';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { render } from 'ink-testing-library';

type RenderResult = ReturnType<typeof render>;
import { WorkerDiffView } from '../../../../src/ui/panels/output/WorkerDiffView.js';
import { ThemeProvider } from '../../../../src/ui/theme/context.js';
import { ConfigProvider } from '../../../../src/utils/config-context.js';
import { KeybindProvider } from '../../../../src/ui/keybinds/dispatcher.js';
import { FocusProvider, type FocusState } from '../../../../src/ui/focus/focus.js';
import { defaultConfig } from '../../../../src/utils/config-schema.js';
import type { ConfigSource } from '../../../../src/utils/config.js';
import type { TuiRpc } from '../../../../src/ui/runtime/rpc.js';
import type { WorkersDiffResult } from '../../../../src/rpc/router-impl.js';
import type { WorkerDiffState } from '../../../../src/ui/data/useWorkerDiff.js';

/**
 * Phase 3J — `<WorkerDiffView>` rendering tests. Uses the `stateOverride`
 * prop so we drive frame scenarios deterministically without a real
 * RPC roundtrip.
 */

function makeRpc(): TuiRpc {
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
        diff: stub() as never,
      },
      questions: { list: stub() as never, get: stub() as never, answer: stub() as never },
      waves: { list: stub() as never, get: stub() as never },
      mode: { get: stub() as never, setModel: stub() as never },
      notifications: { flushAwayDigest: stub() as never },
    },
    subscribe: vi.fn(),
    close: vi.fn(),
  } as unknown as TuiRpc;
}

const FROZEN_NOW = (): number => 1_700_000_010_000;

function fakeResult(overrides: Partial<WorkersDiffResult> = {}): WorkersDiffResult {
  return {
    resolvedBase: 'main',
    mergeBaseSha: 'abc1234567890abcdef1234567890abcdef12345',
    branch: 'feature/x',
    diff: '--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-old\n+new\n',
    bytes: 50,
    truncated: false,
    cappedAt: null,
    files: [{ path: 'x.ts', status: 'M' }],
    ...overrides,
  };
}

const liveRenders: RenderResult[] = [];
const initialSource: ConfigSource = {
  kind: 'file',
  path: '/fake/config.json',
  warnings: [],
};

const initialFocus: FocusState = {
  stack: [{ kind: 'main', key: 'output' }],
};

function renderTracked(node: React.ReactElement): RenderResult {
  const r = render(
    <ConfigProvider initial={{ config: defaultConfig(), source: initialSource }}>
      <ThemeProvider>
        <FocusProvider initial={initialFocus}>
          <KeybindProvider initialCommands={[]}>{node}</KeybindProvider>
        </FocusProvider>
      </ThemeProvider>
    </ConfigProvider>,
  );
  liveRenders.push(r);
  return r;
}

afterEach(() => {
  while (liveRenders.length > 0) liveRenders.pop()?.unmount();
});

describe('WorkerDiffView', () => {
  it('renders loading state with spinner', () => {
    const state: WorkerDiffState = { kind: 'loading' };
    const { lastFrame } = renderTracked(
      <WorkerDiffView
        rpc={makeRpc()}
        workerId="wk-1"
        isFocused={false}
        now={FROZEN_NOW}
        stateOverride={state}
      />,
    );
    expect(lastFrame()).toContain('Computing diff…');
  });

  it('renders idle hint when state is idle', () => {
    const state: WorkerDiffState = { kind: 'idle' };
    const { lastFrame } = renderTracked(
      <WorkerDiffView
        rpc={makeRpc()}
        workerId="wk-1"
        isFocused={false}
        now={FROZEN_NOW}
        stateOverride={state}
      />,
    );
    expect(lastFrame()).toContain('diff view inactive');
  });

  it('renders ready state with header and diff body', () => {
    const data = fakeResult({
      diff: '--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-old\n+new\n',
      bytes: 60,
      files: [{ path: 'x.ts', status: 'M' }],
    });
    const state: WorkerDiffState = {
      kind: 'ready',
      data,
      fetchedAt: 1_700_000_000_000,
    };
    const { lastFrame } = renderTracked(
      <WorkerDiffView
        rpc={makeRpc()}
        workerId="wk-1"
        isFocused={false}
        now={FROZEN_NOW}
        stateOverride={state}
      />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Diff vs main@abc1234');
    expect(frame).toContain('1 file: 1M');
    expect(frame).toContain('60 bytes');
    expect(frame).toContain('captured 10s ago');
    expect(frame).toContain('-old');
    expect(frame).toContain('+new');
  });

  it('renders empty state when diff body is empty', () => {
    const state: WorkerDiffState = {
      kind: 'ready',
      data: fakeResult({ diff: '', bytes: 0, files: [] }),
      fetchedAt: 1_700_000_000_000,
    };
    const { lastFrame } = renderTracked(
      <WorkerDiffView
        rpc={makeRpc()}
        workerId="wk-1"
        isFocused={false}
        now={FROZEN_NOW}
        stateOverride={state}
      />,
    );
    expect(lastFrame()).toContain('no changes vs main@abc1234');
  });

  it('renders truncation banner when result is truncated', () => {
    const state: WorkerDiffState = {
      kind: 'ready',
      data: fakeResult({
        diff: '+'.repeat(4000),
        bytes: 600_000,
        truncated: true,
        cappedAt: 256_000,
      }),
      fetchedAt: 1_700_000_000_000,
    };
    const { lastFrame } = renderTracked(
      <WorkerDiffView
        rpc={makeRpc()}
        workerId="wk-1"
        isFocused={false}
        now={FROZEN_NOW}
        stateOverride={state}
      />,
    );
    expect(lastFrame()).toContain('truncated');
    // Banner shows the actual cap (256000) AND the total bytes (600000).
    expect(lastFrame()).toContain('256,000');
    expect(lastFrame()).toContain('600,000 bytes');
  });

  it('renders error banner with retry hint', () => {
    const state: WorkerDiffState = {
      kind: 'error',
      error: new Error('git boom'),
    };
    const { lastFrame } = renderTracked(
      <WorkerDiffView
        rpc={makeRpc()}
        workerId="wk-1"
        isFocused={false}
        now={FROZEN_NOW}
        stateOverride={state}
      />,
    );
    expect(lastFrame()).toContain('git boom');
    expect(lastFrame()).toContain('press r to retry');
  });

  it('renders error with stale previous data underneath', () => {
    const state: WorkerDiffState = {
      kind: 'error',
      error: new Error('refresh failed'),
      previous: fakeResult({ diff: '-old\n+new\n' }),
    };
    const { lastFrame } = renderTracked(
      <WorkerDiffView
        rpc={makeRpc()}
        workerId="wk-1"
        isFocused={false}
        now={FROZEN_NOW}
        stateOverride={state}
      />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('refresh failed');
    expect(frame).toContain('Diff vs main@abc1234');
    expect(frame).toContain('(stale)');
    expect(frame).toContain('-old');
    expect(frame).toContain('+new');
  });

  it('summarizes mixed file statuses', () => {
    const state: WorkerDiffState = {
      kind: 'ready',
      data: fakeResult({
        files: [
          { path: 'a.ts', status: 'M' },
          { path: 'b.ts', status: 'M' },
          { path: 'c.ts', status: 'A' },
          { path: 'd.ts', status: 'D' },
          { path: 'e.txt', status: '??' },
        ],
        bytes: 200,
      }),
      fetchedAt: 1_700_000_000_000,
    };
    const { lastFrame } = renderTracked(
      <WorkerDiffView
        rpc={makeRpc()}
        workerId="wk-1"
        isFocused={false}
        now={FROZEN_NOW}
        stateOverride={state}
      />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('5 files');
    // Sorted by status code (?, A, D, M).
    expect(frame).toMatch(/1\?\?/);
    expect(frame).toContain('1A');
    expect(frame).toContain('1D');
    expect(frame).toContain('2M');
  });
});
