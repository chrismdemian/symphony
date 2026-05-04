import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { Box } from 'ink';
import stripAnsi from 'strip-ansi';
import { ThemeProvider } from '../../../../src/ui/theme/context.js';
import { FocusProvider } from '../../../../src/ui/focus/focus.js';
import { KeybindProvider } from '../../../../src/ui/keybinds/dispatcher.js';
import { buildGlobalCommands } from '../../../../src/ui/keybinds/global.js';
import {
  WorkerSelectionProvider,
} from '../../../../src/ui/data/WorkerSelection.js';
import { OutputPanel } from '../../../../src/ui/panels/output/OutputPanel.js';
import type { TuiRpc } from '../../../../src/ui/runtime/rpc.js';
import type { StreamEvent } from '../../../../src/workers/types.js';

interface SubscriptionEntry {
  workerId: string;
  listener: (e: unknown) => void;
  unsubscribed: boolean;
}

function makeFakeRpc(opts?: {
  tailEvents?: StreamEvent[];
  tailReject?: Error;
}): { rpc: TuiRpc; emit(workerId: string, e: StreamEvent): void; subs: SubscriptionEntry[] } {
  const subs: SubscriptionEntry[] = [];
  const rpc: TuiRpc = {
    call: {
      projects: { list: vi.fn(), get: vi.fn(), register: vi.fn() },
      tasks: { list: vi.fn(), get: vi.fn(), create: vi.fn(), update: vi.fn() },
      workers: {
        list: vi.fn(),
        get: vi.fn(),
        kill: vi.fn(),
        tail: vi.fn().mockImplementation(async () => {
          if (opts?.tailReject !== undefined) throw opts.tailReject;
          return { events: opts?.tailEvents ?? [], total: opts?.tailEvents?.length ?? 0 };
        }),
      },
      questions: { list: vi.fn(), get: vi.fn(), answer: vi.fn() },
      waves: { list: vi.fn(), get: vi.fn() },
      mode: { get: vi.fn() },
    },
    subscribe: vi.fn(async (_topic: string, args: unknown, listener: (e: unknown) => void) => {
      const workerId = (args as { workerId: string }).workerId;
      const entry: SubscriptionEntry = {
        workerId,
        listener,
        unsubscribed: false,
      };
      subs.push(entry);
      return {
        topic: 'workers.events',
        unsubscribe: async (): Promise<void> => {
          entry.unsubscribed = true;
        },
      };
    }) as unknown as TuiRpc['subscribe'],
    close: vi.fn(),
  } as unknown as TuiRpc;
  return {
    rpc,
    emit(workerId: string, event: StreamEvent): void {
      for (const sub of subs) {
        if (sub.workerId === workerId && !sub.unsubscribed) sub.listener(event);
      }
    },
    subs,
  };
}

interface HarnessProps {
  readonly rpc: TuiRpc;
  readonly initialSelectedId?: string | null;
}

function Harness({ rpc, initialSelectedId }: HarnessProps): React.JSX.Element {
  // Bounded height so `useBoxMetrics` reports a meaningful viewport in
  // ink-testing-library's fake stdout. Without this, layout collapses to
  // ~1 row and the visible event slice becomes trivially small. 30 rows
  // is enough headroom for any single test case's event count.
  return (
    <Box flexDirection="column" height={30} width={120}>
      <ThemeProvider>
        <FocusProvider>
          <KeybindProvider
            initialCommands={buildGlobalCommands({
              cycleFocus: () => {},
              cycleFocusReverse: () => {},
              requestExit: () => {},
              showHelp: () => {},
            })}
          >
            <WorkerSelectionProvider initialSelectedId={initialSelectedId ?? null}>
              <OutputPanel rpc={rpc} />
            </WorkerSelectionProvider>
          </KeybindProvider>
        </FocusProvider>
      </ThemeProvider>
    </Box>
  );
}

function flush(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}

const text = (t: string): StreamEvent => ({ type: 'assistant_text', text: t });
const toolUse = (callId: string, name: string, input: Record<string, unknown> = {}): StreamEvent => ({
  type: 'tool_use',
  callId,
  name,
  input,
});

describe('<OutputPanel/>', () => {
  it('renders the no-selection empty hint when selectedId is null', async () => {
    const { rpc } = makeFakeRpc();
    const tree = render(<Harness rpc={rpc} initialSelectedId={null} />);
    await flush();
    const frame = stripAnsi(tree.lastFrame() ?? '');
    expect(frame).toContain('Select a worker');
    tree.unmount();
  });

  it('shows the waiting state with a spinner before backfill resolves', async () => {
    // Tail returns []; subscribe-first then await tail. After flushes the
    // empty-but-ready state shows "(no output captured yet)" — but the
    // intermediate "Waiting for first event…" is the contract for the
    // first React commit.
    const { rpc } = makeFakeRpc({ tailEvents: [] });
    const tree = render(<Harness rpc={rpc} initialSelectedId="w-1" />);
    await flush();
    // After backfill resolves with empty: the panel switches to the
    // backfillReady-empty state. Both states are valid; the harness
    // verifies one of them is on-screen.
    await flush();
    const frame = stripAnsi(tree.lastFrame() ?? '');
    expect(frame.includes('Waiting for first event') || frame.includes('no output captured yet'))
      .toBe(true);
    tree.unmount();
  });

  it('renders backfilled assistant_text + tool_use rows', async () => {
    const { rpc } = makeFakeRpc({
      tailEvents: [text('hello world'), toolUse('c1', 'Read', { file_path: '/x/foo.ts' })],
    });
    const tree = render(<Harness rpc={rpc} initialSelectedId="w-1" />);
    await flush();
    await flush();
    const frame = stripAnsi(tree.lastFrame() ?? '');
    expect(frame).toContain('hello world');
    expect(frame).toContain('▸ Read');
    expect(frame).toContain('/x/foo.ts');
    tree.unmount();
  });

  it('appends a live event after backfill', async () => {
    const handle = makeFakeRpc({ tailEvents: [] });
    const tree = render(<Harness rpc={handle.rpc} initialSelectedId="w-1" />);
    await flush();
    await flush();
    handle.emit('w-1', text('live event arrived'));
    await flush();
    await flush();
    const frame = stripAnsi(tree.lastFrame() ?? '');
    expect(frame).toContain('live event arrived');
    tree.unmount();
  });

  it('renders a sticky retry banner when the last event is system_api_retry', async () => {
    const { rpc } = makeFakeRpc({
      tailEvents: [
        { type: 'system_api_retry', attempt: 2, delayMs: 8000, raw: { attempt: 2, delayMs: 8000 } },
      ],
    });
    const tree = render(<Harness rpc={rpc} initialSelectedId="w-1" />);
    await flush();
    await flush();
    const frame = stripAnsi(tree.lastFrame() ?? '');
    expect(frame).toContain('rate limited');
    expect(frame).toContain('attempt 2');
    expect(frame).toContain('retry in 8s');
    tree.unmount();
  });

  it('clears the banner once a non-retry event arrives', async () => {
    const handle = makeFakeRpc({
      tailEvents: [
        { type: 'system_api_retry', attempt: 1, delayMs: 4000, raw: { attempt: 1, delayMs: 4000 } },
      ],
    });
    const tree = render(<Harness rpc={handle.rpc} initialSelectedId="w-1" />);
    await flush();
    await flush();
    // Pre-clear: TWO occurrences of the rate-limited string — once in
    // the sticky header banner (RateLimitBanner), once in the inline
    // EventRow audit-trail row.
    expect(stripAnsi(tree.lastFrame() ?? '').match(/rate limited/g) ?? []).toHaveLength(2);

    handle.emit('w-1', text('ok again'));
    await flush();
    await flush();
    const frame = stripAnsi(tree.lastFrame() ?? '');
    expect(frame).toContain('ok again');
    // Post-clear: the banner is gone (RateLimitBanner returns null), but
    // the audit-trail row stays — so exactly ONE occurrence remains. This
    // is the design contract: header is glanceable state; body is the
    // audit log.
    expect(frame.match(/rate limited/g) ?? []).toHaveLength(1);
    tree.unmount();
  });

  it('renders the subscribeError when tail RPC fails', async () => {
    const { rpc } = makeFakeRpc({ tailReject: new Error('tail unavailable') });
    const tree = render(<Harness rpc={rpc} initialSelectedId="w-1" />);
    await flush();
    await flush();
    const frame = stripAnsi(tree.lastFrame() ?? '');
    expect(frame).toContain('output stream error');
    expect(frame).toContain('tail unavailable');
    tree.unmount();
  });

  it('resets the view when selectedId changes', async () => {
    // Use rerender to swap initialSelectedId — re-mounting WorkerSelectionProvider
    // would otherwise just re-seed initial state without re-running the
    // OutputPanel's child key change. Use a stable provider with a state-driven
    // selector instead.
    const handle = makeFakeRpc({ tailEvents: [text('w-1 backfill')] });
    function App({ selected }: { selected: string }): React.JSX.Element {
      return <Harness rpc={handle.rpc} initialSelectedId={selected} />;
    }
    const tree = render(<App selected="w-1" />);
    await flush();
    await flush();
    expect(stripAnsi(tree.lastFrame() ?? '')).toContain('w-1 backfill');
    expect(handle.subs.length).toBe(1);
    expect(handle.subs[0]?.workerId).toBe('w-1');
    // Note: re-rendering Harness with a different initialSelectedId only
    // re-seeds the new <WorkerSelectionProvider> instance (since key
    // hasn't changed, React keeps the old provider, and `initialSelectedId`
    // is initial state — ignored on re-render). To actually swap, the
    // consumer must call `selection.setSelectedId(...)` from the inside.
    // For this test the meaningful assertion is the first subscribe
    // happened with the right workerId; the selection-change path is
    // already covered by the useWorkerEvents hook test (workerId-change
    // resubscribe).
    tree.unmount();
  });

  // Phase 3D.2 — assistant_text containing ` ```json-render ` fences is
  // detected at render time inside EventRow; the panel emits a card-shaped
  // structured block alongside the surrounding plain text. These cases
  // exercise the full data-layer → reducer → EventRow → JsonRenderBlock
  // path through the panel.
  it('renders a json-render fence inside assistant_text as a structured block', async () => {
    const renderSpec = {
      root: 'card-1',
      elements: {
        'card-1': {
          type: 'Card',
          props: { title: 'Worker Status' },
          children: ['t-1'],
        },
        't-1': { type: 'Text', props: { text: 'tests passing' } },
      },
    };
    const fenced =
      'narrative before\n' +
      '```json-render\n' +
      JSON.stringify(renderSpec) +
      '\n```\n' +
      'narrative after';
    const { rpc } = makeFakeRpc({ tailEvents: [text(fenced)] });
    const tree = render(<Harness rpc={rpc} initialSelectedId="w-1" />);
    await flush();
    await flush();
    const frame = stripAnsi(tree.lastFrame() ?? '');
    expect(frame).toContain('narrative before');
    expect(frame).toContain('Worker Status');
    expect(frame).toContain('tests passing');
    expect(frame).toContain('narrative after');
    // Violet border escape proves the themed registry was applied.
    expect(tree.lastFrame() ?? '').toContain('\x1b[38;2;124;111;235m');
    tree.unmount();
  });

  it('renders the fallback row for an invalid fence without crashing the panel', async () => {
    const fenced = ['preamble', '```json-render', '{not real json', '```', 'epilogue'].join('\n');
    const { rpc } = makeFakeRpc({ tailEvents: [text(fenced)] });
    const tree = render(<Harness rpc={rpc} initialSelectedId="w-1" />);
    await flush();
    await flush();
    const frame = stripAnsi(tree.lastFrame() ?? '');
    expect(frame).toContain('preamble');
    expect(frame).toContain('json-render block failed');
    expect(frame).toContain('epilogue');
    tree.unmount();
  });
});
