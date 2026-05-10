import React from 'react';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render } from 'ink-testing-library';
import { ThemeProvider } from '../../../../src/ui/theme/context.js';
import { FocusProvider, useFocus } from '../../../../src/ui/focus/focus.js';
import { KeybindProvider } from '../../../../src/ui/keybinds/dispatcher.js';
import { buildGlobalCommands } from '../../../../src/ui/keybinds/global.js';
import { WorkerSelectionProvider } from '../../../../src/ui/data/WorkerSelection.js';
import { ToastProvider } from '../../../../src/ui/feedback/ToastProvider.js';
import { WorkerPanel } from '../../../../src/ui/panels/workers/WorkerPanel.js';
import type { WorkerRecordSnapshot } from '../../../../src/orchestrator/worker-registry.js';
import type { PendingSpawnSnapshot } from '../../../../src/rpc/router-impl.js';
import type { TuiRpc } from '../../../../src/ui/runtime/rpc.js';
import type { UseWorkersResult } from '../../../../src/ui/data/useWorkers.js';
import type { UseQueueResult } from '../../../../src/ui/data/useQueue.js';

/**
 * Phase 3L — WorkerPanel queue extension. Tests render flow, j/k
 * navigation into queue rows, X cancel + Ctrl+J / Ctrl+K reorder
 * commands fan out to the RPC, and the three-way selection mutex.
 */

function snap(over: Partial<WorkerRecordSnapshot>): WorkerRecordSnapshot {
  return {
    id: 'w',
    projectPath: 'C:/projects/alpha',
    worktreePath: 'C:/projects/alpha/.symphony/worktrees/w',
    role: 'implementer',
    featureIntent: 'do thing',
    taskDescription: 'do thing',
    autonomyTier: 1,
    dependsOn: [],
    status: 'running',
    createdAt: '2026-05-10T12:00:00.000Z',
    ...over,
  };
}

function pending(over: Partial<PendingSpawnSnapshot> = {}): PendingSpawnSnapshot {
  return {
    recordId: over.recordId ?? 'rec-1',
    projectPath: over.projectPath ?? 'C:/projects/alpha',
    featureIntent: over.featureIntent ?? 'add filters',
    taskDescription: over.taskDescription ?? 'add filters',
    enqueuedAt: over.enqueuedAt ?? 1000,
  };
}

interface FakeRpcRecorder {
  rpc: TuiRpc;
  cancelCalls: Array<{ recordId: string }>;
  reorderCalls: Array<{ recordId: string; direction: 'up' | 'down' }>;
  cancelOutcome: 'success' | 'not-in-queue';
  reorderOutcome: 'success' | 'no-neighbor';
}

function makeFakeRpc(): FakeRpcRecorder {
  const recorder: FakeRpcRecorder = {
    rpc: {} as TuiRpc,
    cancelCalls: [],
    reorderCalls: [],
    cancelOutcome: 'success',
    reorderOutcome: 'success',
  };
  recorder.rpc = {
    call: {
      projects: {
        list: async () => [],
        get: async () => null,
        register: async () => {
          throw new Error('unused');
        },
      },
      tasks: {
        list: async () => [],
        get: async () => null,
        create: async () => {
          throw new Error('unused');
        },
        update: async () => {
          throw new Error('unused');
        },
      },
      workers: {
        list: async () => [],
        get: async () => null,
        kill: async () => ({ killed: true }),
      },
      questions: {
        list: async () => [],
        get: async () => null,
        answer: async () => {
          throw new Error('unused');
        },
      },
      waves: {
        list: async () => [],
        get: async () => null,
      },
      mode: {
        get: async () => ({ mode: 'plan' as const }),
      },
      queue: {
        list: async () => [],
        cancel: async (args: { recordId: string }) => {
          recorder.cancelCalls.push({ recordId: args.recordId });
          if (recorder.cancelOutcome === 'not-in-queue') {
            return { cancelled: false, reason: 'not in queue' };
          }
          return { cancelled: true };
        },
        reorder: async (args: { recordId: string; direction: 'up' | 'down' }) => {
          recorder.reorderCalls.push({ recordId: args.recordId, direction: args.direction });
          if (recorder.reorderOutcome === 'no-neighbor') {
            return { moved: false, reason: 'no neighbor' };
          }
          return { moved: true };
        },
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    subscribe: async () => ({ topic: 'noop', unsubscribe: async () => {} }),
    close: async () => {},
  };
  return recorder;
}

function makeWorkersResult(workers: readonly WorkerRecordSnapshot[]): UseWorkersResult {
  return {
    workers,
    loading: false,
    error: null,
    refresh: () => undefined,
  };
}

function makeQueueResult(items: readonly PendingSpawnSnapshot[]): UseQueueResult & {
  refreshes: number;
} {
  let refreshes = 0;
  const r: UseQueueResult & { refreshes: number } = {
    pending: items,
    loading: false,
    error: null,
    refresh: () => {
      refreshes += 1;
      r.refreshes = refreshes;
    },
    refreshes,
  };
  return r;
}

function FocusForcer({ to }: { readonly to: 'workers' | 'chat' | 'output' }): React.JSX.Element {
  const focus = useFocus();
  React.useEffect(() => {
    focus.setMain(to);
  }, [focus, to]);
  return <></>;
}

function Harness({
  rpc,
  workersResult,
  queueResult,
}: {
  readonly rpc: TuiRpc;
  readonly workersResult: UseWorkersResult;
  readonly queueResult: UseQueueResult;
}): React.JSX.Element {
  const commands = React.useMemo(
    () =>
      buildGlobalCommands({
        cycleFocus: () => {},
        cycleFocusReverse: () => {},
        requestExit: () => {},
        showHelp: () => {},
      }),
    [],
  );
  return (
    <ThemeProvider>
      <ToastProvider>
        <FocusProvider>
          <FocusForcer to="workers" />
          <WorkerSelectionProvider>
            <KeybindProvider initialCommands={commands}>
              <WorkerPanel rpc={rpc} workersResult={workersResult} queueResult={queueResult} />
            </KeybindProvider>
          </WorkerSelectionProvider>
        </FocusProvider>
      </ToastProvider>
    </ThemeProvider>
  );
}

// State-transition chains through KeybindProvider's setCommands queue
// need more than one setImmediate to fully settle. A queue-row keystroke
// triggers: selection setState → WorkerPanel re-render (new commands
// memo, new onSelect closures) → useRegisterCommands cleanup +
// re-register → KeybindProvider setCommands → KeybindProvider re-render
// → new `active` memo → new useInput closure. That's 2-3 commit cycles.
// 32 microtasks + 4 setImmediates covers the cascade under test pressure.
const flush = async (): Promise<void> => {
  for (let i = 0; i < 32; i += 1) await Promise.resolve();
  for (let i = 0; i < 4; i += 1) {
    await new Promise((r) => setImmediate(r));
  }
};

let originalColumns: number | undefined;
let originalRows: number | undefined;

beforeEach(() => {
  originalColumns = process.stdout.columns;
  originalRows = process.stdout.rows;
  Object.defineProperty(process.stdout, 'columns', { value: 120, configurable: true });
  Object.defineProperty(process.stdout, 'rows', { value: 30, configurable: true });
});

afterEach(() => {
  if (originalColumns !== undefined) {
    Object.defineProperty(process.stdout, 'columns', {
      value: originalColumns,
      configurable: true,
    });
  }
  if (originalRows !== undefined) {
    Object.defineProperty(process.stdout, 'rows', {
      value: originalRows,
      configurable: true,
    });
  }
});

describe('<WorkerPanel> queue extension (3L)', () => {
  it('does not render queue header when pending list is empty', async () => {
    const wr = makeWorkersResult([snap({ id: 'a' })]);
    const qr = makeQueueResult([]);
    const { lastFrame, unmount } = render(
      <Harness rpc={makeFakeRpc().rpc} workersResult={wr} queueResult={qr} />,
    );
    await flush();
    const frame = lastFrame() ?? '';
    expect(frame).not.toContain('Queue (');
    expect(frame).not.toContain('Next →');
    unmount();
  });

  it('renders queue header and Next → marker on the head row when pending', async () => {
    const wr = makeWorkersResult([snap({ id: 'a' })]);
    const qr = makeQueueResult([
      pending({ recordId: 'r1', featureIntent: 'add filters', projectPath: '/p/MathScrabble' }),
      pending({
        recordId: 'r2',
        featureIntent: 'fix scraper',
        projectPath: '/p/CRE',
        enqueuedAt: 2000,
      }),
    ]);
    const { lastFrame, unmount } = render(
      <Harness rpc={makeFakeRpc().rpc} workersResult={wr} queueResult={qr} />,
    );
    await flush();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Queue');
    expect(frame).toContain('(2 pending)');
    expect(frame).toContain('Next →');
    expect(frame).toContain('add filters');
    expect(frame).toContain('(MathScrabble)');
    expect(frame).toContain(' 2.');
    expect(frame).toContain('fix scraper');
    expect(frame).toContain('(CRE)');
    unmount();
  });

  it('j / k navigates into queue rows after worker rows; X cancels the selected queued task', async () => {
    const wr = makeWorkersResult([snap({ id: 'a' })]);
    const qr = makeQueueResult([
      pending({ recordId: 'r1', featureIntent: 'first' }),
      pending({ recordId: 'r2', featureIntent: 'second', enqueuedAt: 2000 }),
    ]);
    const fake = makeFakeRpc();
    const { stdin, lastFrame, unmount } = render(
      <Harness rpc={fake.rpc} workersResult={wr} queueResult={qr} />,
    );
    await flush();
    // On mount, WorkerSelectionProvider.reconcile picks the first
    // visible worker as the selection default. So from initial
    // state (cursor on Violin/'a'), three j-presses reach r2:
    //   j → queue-header
    //   j → queue-item r1
    //   j → queue-item r2
    stdin.write('j');
    await flush();
    stdin.write('j');
    await flush();
    stdin.write('j');
    await flush();
    const beforeX = lastFrame() ?? '';
    expect(beforeX).toMatch(/second/);
    // Inverse SGR followed (after possible color SGR) by 'second'.
    // eslint-disable-next-line no-control-regex
    expect(beforeX).toMatch(/\x1b\[7m[\s\S]*?second/);
    stdin.write('X');
    await flush();
    await flush();
    expect(fake.cancelCalls).toEqual([{ recordId: 'r2' }]);
    expect(qr.refreshes).toBeGreaterThan(0);
    unmount();
  });

  it('"]" reorders down; "[" reorders up — only fires on queue rows', async () => {
    const wr = makeWorkersResult([snap({ id: 'a' })]);
    const qr = makeQueueResult([
      pending({ recordId: 'r1', featureIntent: 'first' }),
      pending({ recordId: 'r2', featureIntent: 'second', enqueuedAt: 2000 }),
    ]);
    const fake = makeFakeRpc();
    const { stdin, unmount } = render(
      <Harness rpc={fake.rpc} workersResult={wr} queueResult={qr} />,
    );
    await flush();
    // From initial state (cursor on Violin/'a' via mount-time reconcile):
    //   j → queue-header
    //   j → r1
    stdin.write('j');
    await flush();
    stdin.write('j');
    await flush();
    stdin.write(']');
    await flush();
    await flush();
    expect(fake.reorderCalls).toEqual([{ recordId: 'r1', direction: 'down' }]);
    // Move to r2 and reorder up.
    stdin.write('j');
    await flush();
    stdin.write('[');
    await flush();
    await flush();
    expect(fake.reorderCalls).toEqual([
      { recordId: 'r1', direction: 'down' },
      { recordId: 'r2', direction: 'up' },
    ]);
    unmount();
  });

  it('X is a no-op when worker row is selected (default after mount via reconcile)', async () => {
    const wr = makeWorkersResult([snap({ id: 'a' })]);
    const qr = makeQueueResult([pending({ recordId: 'r1' })]);
    const fake = makeFakeRpc();
    const { stdin, unmount } = render(
      <Harness rpc={fake.rpc} workersResult={wr} queueResult={qr} />,
    );
    await flush();
    // WorkerSelectionProvider.reconcile pre-selects worker 'a' on mount.
    // No navigation needed — X here must be a no-op.
    stdin.write('X');
    await flush();
    await flush();
    expect(fake.cancelCalls).toEqual([]);
    unmount();
  });

  it('"]" is a no-op when worker row is selected (default after mount)', async () => {
    const wr = makeWorkersResult([snap({ id: 'a' })]);
    const qr = makeQueueResult([pending({ recordId: 'r1' })]);
    const fake = makeFakeRpc();
    const { stdin, unmount } = render(
      <Harness rpc={fake.rpc} workersResult={wr} queueResult={qr} />,
    );
    await flush();
    stdin.write(']');
    await flush();
    await flush();
    expect(fake.reorderCalls).toEqual([]);
    unmount();
  });

  it('selecting a worker row clears any prior queue selection (three-way mutex)', async () => {
    const wr = makeWorkersResult([snap({ id: 'a', featureIntent: 'work-a' })]);
    const qr = makeQueueResult([pending({ recordId: 'r1', featureIntent: 'q-first' })]);
    const fake = makeFakeRpc();
    const { stdin, unmount } = render(
      <Harness rpc={fake.rpc} workersResult={wr} queueResult={qr} />,
    );
    await flush();
    // From cursor on worker 'a': j → queue-header → r1, then k k back.
    stdin.write('j');
    await flush();
    stdin.write('j');
    await flush();
    // Cursor on r1; X here would cancel r1. Move back to worker row.
    stdin.write('k');
    await flush();
    stdin.write('k');
    await flush();
    stdin.write('X');
    await flush();
    await flush();
    // X on a worker row is a no-op — must not cancel.
    expect(fake.cancelCalls).toEqual([]);
    unmount();
  });
});
