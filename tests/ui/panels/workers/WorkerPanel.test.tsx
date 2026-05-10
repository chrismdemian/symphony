import React from 'react';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render } from 'ink-testing-library';
import { ThemeProvider } from '../../../../src/ui/theme/context.js';
import { FocusProvider, useFocus } from '../../../../src/ui/focus/focus.js';
import { KeybindProvider } from '../../../../src/ui/keybinds/dispatcher.js';
import { buildGlobalCommands } from '../../../../src/ui/keybinds/global.js';
import { WorkerSelectionProvider } from '../../../../src/ui/data/WorkerSelection.js';
import { WorkerPanel } from '../../../../src/ui/panels/workers/WorkerPanel.js';
import type { WorkerRecordSnapshot } from '../../../../src/orchestrator/worker-registry.js';
import type { TuiRpc } from '../../../../src/ui/runtime/rpc.js';
import type { UseWorkersResult } from '../../../../src/ui/data/useWorkers.js';

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
    createdAt: '2026-05-03T12:00:00.000Z',
    ...over,
  };
}

interface FakeRpcOptions {
  readonly killOutcome?: 'success' | 'terminal';
  readonly onKill?: (id: string) => void;
}

function makeFakeRpc(opts: FakeRpcOptions = {}): TuiRpc {
  return {
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
        kill: async (args: { workerId: string }) => {
          opts.onKill?.(args.workerId);
          if (opts.killOutcome === 'terminal') {
            return { killed: false, reason: 'already terminal: completed' };
          }
          return { killed: true };
        },
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    subscribe: async () => ({ topic: 'noop', unsubscribe: async () => {} }),
    close: async () => {},
  };
}

function makeWorkersResult(workers: readonly WorkerRecordSnapshot[]): UseWorkersResult & {
  refreshes: number;
} {
  let refreshes = 0;
  const result: UseWorkersResult & { refreshes: number } = {
    workers,
    loading: false,
    error: null,
    refresh: () => {
      refreshes += 1;
      result.refreshes = refreshes;
    },
    refreshes,
  };
  return result;
}

interface HarnessProps {
  readonly rpc: TuiRpc;
  readonly workersResult: UseWorkersResult;
  readonly initialFocus?: 'workers' | 'chat' | 'output';
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
  initialFocus = 'workers',
}: HarnessProps): React.JSX.Element {
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
      <FocusProvider>
        <FocusForcer to={initialFocus} />
        <WorkerSelectionProvider>
          <KeybindProvider initialCommands={commands}>
            <WorkerPanel rpc={rpc} workersResult={workersResult} />
          </KeybindProvider>
        </WorkerSelectionProvider>
      </FocusProvider>
    </ThemeProvider>
  );
}

const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

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

describe('<WorkerPanel>', () => {
  it('renders the empty-state hint when there are no workers', async () => {
    const wr = makeWorkersResult([]);
    const { lastFrame, unmount } = render(<Harness rpc={makeFakeRpc()} workersResult={wr} />);
    await flush();
    expect(lastFrame() ?? '').toContain('no workers');
    unmount();
  });

  it('groups workers by project and renders instrument names', async () => {
    const a = snap({ id: 'a', projectPath: 'C:/projects/alpha', featureIntent: 'A task' });
    const b = snap({
      id: 'b',
      projectPath: 'C:/projects/alpha',
      featureIntent: 'B task',
      createdAt: '2026-05-03T12:01:00.000Z',
    });
    const c = snap({
      id: 'c',
      projectPath: 'C:/projects/beta',
      featureIntent: 'C task',
    });
    const wr = makeWorkersResult([a, b, c]);
    const { lastFrame, unmount } = render(<Harness rpc={makeFakeRpc()} workersResult={wr} />);
    await flush();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('alpha');
    expect(frame).toContain('beta');
    expect(frame).toContain('A task');
    expect(frame).toContain('B task');
    expect(frame).toContain('C task');
    expect(frame).toContain('Violin');
    expect(frame).toContain('Cello');
    unmount();
  });

  it('renders status icons for terminal workers', async () => {
    const completed = snap({ id: 'c1', status: 'completed', featureIntent: 'done' });
    const failed = snap({ id: 'c2', status: 'failed', featureIntent: 'fail' });
    const killed = snap({ id: 'c3', status: 'killed', featureIntent: 'gone' });
    const wr = makeWorkersResult([completed, failed, killed]);
    const { lastFrame, unmount } = render(<Harness rpc={makeFakeRpc()} workersResult={wr} />);
    await flush();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('✓');
    expect(frame).toContain('✗');
    expect(frame).toContain('⊘');
    unmount();
  });

  it('renders kill outcome notice on success', async () => {
    const w = snap({ id: 'k1' });
    const wr = makeWorkersResult([w]);
    let killed: string | null = null;
    const rpc = makeFakeRpc({ onKill: (id) => (killed = id) });
    const { lastFrame, stdin, unmount } = render(
      <Harness rpc={rpc} workersResult={wr} />,
    );
    await flush();
    stdin.write('K');
    await flush();
    await flush();
    expect(killed).toBe('k1');
    expect(lastFrame() ?? '').toContain('killed k1');
    expect(wr.refreshes).toBeGreaterThan(0);
    unmount();
  });

  it('renders kill outcome notice on already-terminal', async () => {
    const w = snap({ id: 't1' });
    const wr = makeWorkersResult([w]);
    const rpc = makeFakeRpc({ killOutcome: 'terminal' });
    const { lastFrame, stdin, unmount } = render(<Harness rpc={rpc} workersResult={wr} />);
    await flush();
    stdin.write('K');
    await flush();
    await flush();
    expect(lastFrame() ?? '').toContain('already terminal');
    unmount();
  });

  it('selects ordinals via 1-9', async () => {
    const a = snap({ id: 'a', featureIntent: 'first' });
    const b = snap({
      id: 'b',
      featureIntent: 'second',
      createdAt: '2026-05-03T12:00:01.000Z',
    });
    const c = snap({
      id: 'c',
      featureIntent: 'third',
      createdAt: '2026-05-03T12:00:02.000Z',
    });
    const wr = makeWorkersResult([a, b, c]);
    let killed: string | null = null;
    const rpc = makeFakeRpc({ onKill: (id) => (killed = id) });
    const { stdin, unmount } = render(<Harness rpc={rpc} workersResult={wr} />);
    await flush();
    stdin.write('2');
    await flush();
    stdin.write('K');
    await flush();
    await flush();
    expect(killed).toBe('b');
    unmount();
  });

  it('j/k cycles selection', async () => {
    const a = snap({ id: 'a' });
    const b = snap({
      id: 'b',
      createdAt: '2026-05-03T12:00:01.000Z',
    });
    const wr = makeWorkersResult([a, b]);
    let killed: string | null = null;
    const rpc = makeFakeRpc({ onKill: (id) => (killed = id) });
    const { stdin, unmount } = render(<Harness rpc={rpc} workersResult={wr} />);
    await flush();
    // WorkerSelectionProvider.reconcile pre-selects worker 'a' on mount,
    // so the cursor starts on row 'a'. One j press advances to 'b'.
    // (3L follow-up: K is now guarded against firing on header /
    // queue rows — it only fires when a worker row is selected.)
    stdin.write('j');
    await flush();
    stdin.write('K');
    await flush();
    await flush();
    expect(killed).toBe('b');
    unmount();
  });
});
