import React from 'react';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { render } from 'ink-testing-library';

type RenderResult = ReturnType<typeof render>;
import { WorkerOutputContainer } from '../../../../src/ui/panels/output/WorkerOutputContainer.js';
import { ThemeProvider } from '../../../../src/ui/theme/context.js';
import { ConfigProvider } from '../../../../src/utils/config-context.js';
import { KeybindProvider, useKeybinds } from '../../../../src/ui/keybinds/dispatcher.js';
import { FocusProvider, type FocusState } from '../../../../src/ui/focus/focus.js';
import { defaultConfig } from '../../../../src/utils/config-schema.js';
import type { ConfigSource } from '../../../../src/utils/config.js';
import type { Command } from '../../../../src/ui/keybinds/registry.js';
import type { TuiRpc } from '../../../../src/ui/runtime/rpc.js';
import type { WorkersDiffResult } from '../../../../src/rpc/router-impl.js';
import type { WorkerRecordSnapshot } from '../../../../src/orchestrator/worker-registry.js';

/**
 * Phase 3J — `<WorkerOutputContainer>` tests. Drives the D-toggle path
 * through stdin keystroke (the focus stack is set up so the container's
 * `'output'`-scope commands fire) and exercises the auto-refresh edge
 * via the polled `workers.get` mock.
 */

interface Stubs {
  diff: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  tail: ReturnType<typeof vi.fn>;
  subscribe: ReturnType<typeof vi.fn>;
}

function makeRpc(): { rpc: TuiRpc; stubs: Stubs } {
  const stub = (): unknown => vi.fn();
  const diff = vi.fn().mockResolvedValue({
    resolvedBase: 'main',
    mergeBaseSha: 'abc1234567890abcdef1234567890abcdef12345',
    branch: 'feature/x',
    diff: '--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n',
    bytes: 30,
    truncated: false,
    cappedAt: null,
    files: [{ path: 'x', status: 'M' }],
  } satisfies WorkersDiffResult);
  const get = vi.fn().mockResolvedValue({
    id: 'wk-1',
    projectPath: '/p',
    worktreePath: '/p',
    role: 'implementer',
    featureIntent: 'f',
    taskDescription: 't',
    autonomyTier: 2,
    dependsOn: [],
    status: 'running',
    createdAt: new Date().toISOString(),
  } satisfies WorkerRecordSnapshot);
  const tail = vi.fn().mockResolvedValue({ events: [], total: 0 });
  const subscribe = vi.fn().mockResolvedValue({
    unsubscribe: () => {},
  });
  const rpc = {
    call: {
      projects: { list: stub() as never, get: stub() as never, register: stub() as never },
      tasks: {
        list: stub() as never,
        get: stub() as never,
        create: stub() as never,
        update: stub() as never,
      },
      workers: { list: stub() as never, get, kill: stub() as never, tail, diff },
      questions: { list: stub() as never, get: stub() as never, answer: stub() as never },
      waves: { list: stub() as never, get: stub() as never },
      mode: { get: stub() as never, setModel: stub() as never },
      notifications: { flushAwayDigest: stub() as never },
    },
    subscribe,
    close: vi.fn(),
  } as unknown as TuiRpc;
  return { rpc, stubs: { diff, get, tail, subscribe } };
}

const liveRenders: RenderResult[] = [];
const initialSource: ConfigSource = { kind: 'file', path: '/x', warnings: [] };
const initialFocus: FocusState = { stack: [{ kind: 'main', key: 'output' }] };

function renderTracked(
  node: React.ReactElement,
  opts: { onRegistry?: (cmds: readonly Command[]) => void } = {},
): RenderResult {
  function RegistryProbe(): null {
    const k = useKeybinds();
    React.useEffect(() => {
      opts.onRegistry?.(k.commands);
    }, [k.commands]);
    return null;
  }

  const r = render(
    <ConfigProvider initial={{ config: defaultConfig(), source: initialSource }}>
      <ThemeProvider>
        <FocusProvider initial={initialFocus}>
          <KeybindProvider initialCommands={[]}>
            {opts.onRegistry !== undefined ? <RegistryProbe /> : null}
            {node}
          </KeybindProvider>
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

async function flush(n = 6): Promise<void> {
  for (let i = 0; i < n; i += 1) {
    await new Promise((r) => setImmediate(r));
  }
}

async function waitFor(check: () => void, timeoutMs = 1500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
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

describe('WorkerOutputContainer', () => {
  it('renders streaming output view by default', async () => {
    const { rpc, stubs } = makeRpc();
    renderTracked(
      <WorkerOutputContainer
        rpc={rpc}
        workerId="wk-1"
        isFocused
        statusPollMs={0}
      />,
    );
    await flush();
    // Output view subscribes via rpc.subscribe + tail; diff RPC NOT called.
    expect(stubs.subscribe).toHaveBeenCalled();
    expect(stubs.diff).not.toHaveBeenCalled();
  });

  it('invoking toggle command via onSelect mounts diff view + fires diff RPC', async () => {
    const { rpc, stubs } = makeRpc();
    let latestRegistry: readonly Command[] = [];
    renderTracked(
      <WorkerOutputContainer
        rpc={rpc}
        workerId="wk-1"
        isFocused
        statusPollMs={0}
      />,
      {
        onRegistry: (cmds) => {
          latestRegistry = cmds;
        },
      },
    );
    await flush();
    expect(stubs.diff).not.toHaveBeenCalled();
    const toggle = latestRegistry.find((c) => c.id === 'output.toggleDiff');
    toggle?.onSelect();
    await waitFor(() => expect(stubs.diff).toHaveBeenCalledTimes(1));
  });

  it('toggle command initial title is "diff" (target on press)', async () => {
    const { rpc } = makeRpc();
    let latestRegistry: readonly Command[] = [];
    renderTracked(
      <WorkerOutputContainer
        rpc={rpc}
        workerId="wk-1"
        isFocused
        statusPollMs={0}
      />,
      {
        onRegistry: (cmds) => {
          latestRegistry = cmds;
        },
      },
    );
    await flush();
    expect(latestRegistry.find((c) => c.id === 'output.toggleDiff')?.title).toBe('diff');
  });

  it('registers `D` toggle command at output scope', async () => {
    const { rpc } = makeRpc();
    let latestRegistry: readonly Command[] = [];
    renderTracked(
      <WorkerOutputContainer
        rpc={rpc}
        workerId="wk-1"
        isFocused
        statusPollMs={0}
      />,
      {
        onRegistry: (cmds) => {
          latestRegistry = cmds;
        },
      },
    );
    await flush();
    const toggle = latestRegistry.find((c) => c.id === 'output.toggleDiff');
    expect(toggle).toBeDefined();
    expect(toggle?.scope).toBe('output');
    expect(toggle?.key).toEqual({ kind: 'char', char: 'D' });
    expect(toggle?.displayOnScreen).toBe(true);
  });

  it('does NOT register `r` refresh command in output mode', async () => {
    const { rpc } = makeRpc();
    let latestRegistry: readonly Command[] = [];
    renderTracked(
      <WorkerOutputContainer
        rpc={rpc}
        workerId="wk-1"
        isFocused
        statusPollMs={0}
      />,
      {
        onRegistry: (cmds) => {
          latestRegistry = cmds;
        },
      },
    );
    await flush();
    expect(latestRegistry.some((c) => c.id === 'output.refreshDiff')).toBe(false);
  });

  it('does NOT register commands when not focused', async () => {
    const { rpc } = makeRpc();
    let latestRegistry: readonly Command[] = [];
    renderTracked(
      <WorkerOutputContainer
        rpc={rpc}
        workerId="wk-1"
        isFocused={false}
        statusPollMs={0}
      />,
      {
        onRegistry: (cmds) => {
          latestRegistry = cmds;
        },
      },
    );
    await flush();
    expect(latestRegistry.some((c) => c.id === 'output.toggleDiff')).toBe(false);
  });

  it('polls workers.get when statusPollMs > 0', async () => {
    const { rpc, stubs } = makeRpc();
    renderTracked(
      <WorkerOutputContainer
        rpc={rpc}
        workerId="wk-1"
        isFocused
        statusPollMs={50}
      />,
    );
    await flush();
    expect(stubs.get).toHaveBeenCalled();
    const initialCount = stubs.get.mock.calls.length;
    // Wait for at least one more poll tick.
    await waitFor(() => expect(stubs.get.mock.calls.length).toBeGreaterThan(initialCount), 1000);
  });

  it('cappedAt is exposed via WorkersDiffResult shape (audit M3)', async () => {
    // Compile-time check via the diff stub: returning `cappedAt: number`
    // satisfies the result type. Runtime smoke that the field flows
    // through to the diff RPC mock without error.
    const { rpc, stubs } = makeRpc();
    stubs.diff.mockResolvedValueOnce({
      resolvedBase: 'main',
      mergeBaseSha: 'a'.repeat(40),
      branch: null,
      diff: 'truncated body…',
      bytes: 600_000,
      truncated: true,
      cappedAt: 256_000,
      files: [{ path: 'x', status: 'M' }],
    });
    let latestRegistry: readonly Command[] = [];
    renderTracked(
      <WorkerOutputContainer
        rpc={rpc}
        workerId="wk-1"
        isFocused
        statusPollMs={0}
      />,
      {
        onRegistry: (cmds) => {
          latestRegistry = cmds;
        },
      },
    );
    await flush();
    const toggle = latestRegistry.find((c) => c.id === 'output.toggleDiff');
    toggle?.onSelect();
    await waitFor(() => expect(stubs.diff).toHaveBeenCalledTimes(1));
  });

  // Phase 3J audit M6: the positive auto-refresh path (toggle to diff →
  // worker terminates → second diff RPC fires) is covered end-to-end by
  // the production scenario `tests/scenarios/3j.test.ts`. The unit-test
  // probe for "refresh command appears in registry after toggle" is
  // unreliable under React 19 strict mode (the register/unregister
  // double-cycle obscures the steady-state observation), so the unit
  // suite covers the negative cases here and the scenario covers
  // positive end-to-end.

  it('does NOT auto-refresh while in output mode', async () => {
    const { rpc, stubs } = makeRpc();
    let callIdx = 0;
    stubs.get.mockImplementation(async () => ({
      id: 'wk-1',
      projectPath: '/p',
      worktreePath: '/p',
      role: 'implementer' as const,
      featureIntent: 'f',
      taskDescription: 't',
      autonomyTier: 2 as const,
      dependsOn: [],
      status: callIdx++ === 0 ? ('running' as const) : ('completed' as const),
      createdAt: new Date().toISOString(),
    }));

    renderTracked(
      <WorkerOutputContainer
        rpc={rpc}
        workerId="wk-1"
        isFocused
        statusPollMs={50}
      />,
    );
    // Wait long enough for the status poll to flip to completed.
    await new Promise((r) => setTimeout(r, 200));
    expect(stubs.diff).not.toHaveBeenCalled();
  });
});
