/**
 * Phase 3D.1 — visual frame harness.
 *
 * Captures the OutputPanel under canonical states for skeptical-subagent
 * review. Each scenario seeds a synthetic stream-event sequence (via a
 * fake RPC whose `workers.tail` returns a scripted backfill and whose
 * `subscribe` exposes an `emit(event)` hook), captures the rendered
 * frame, dumps `.ansi` (with escapes) + `.plain` (stripped) +
 * `INDEX-3d1.md`.
 *
 * Output: `.visual-frames/3d1-<state>.{ansi,plain}.txt`.
 */
import React from 'react';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Box } from 'ink';
import { render } from 'ink-testing-library';
import { ThemeProvider } from '../../src/ui/theme/context.js';
import { FocusProvider, useFocus, type FocusKey } from '../../src/ui/focus/focus.js';
import { KeybindProvider } from '../../src/ui/keybinds/dispatcher.js';
import { buildGlobalCommands } from '../../src/ui/keybinds/global.js';
import { WorkerSelectionProvider } from '../../src/ui/data/WorkerSelection.js';
import { OutputPanel } from '../../src/ui/panels/output/OutputPanel.js';
import type { TuiRpc } from '../../src/ui/runtime/rpc.js';
import type { StreamEvent } from '../../src/workers/types.js';

const OUT_DIR = path.resolve(process.cwd(), '.visual-frames');

interface SubscriptionEntry {
  workerId: string;
  listener: (e: unknown) => void;
  unsubscribed: boolean;
}

function makeFakeRpc(opts: {
  tailEvents?: StreamEvent[];
  tailReject?: Error;
  /** When true, the tail call returns a promise that never resolves —
   * useful for capturing the pre-backfill waiting state. */
  tailPending?: boolean;
}): { rpc: TuiRpc; emit(workerId: string, e: StreamEvent): void } {
  const subs: SubscriptionEntry[] = [];
  const rpc: TuiRpc = {
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
        kill: async () => ({ killed: false }),
        tail: async () => {
          if (opts.tailPending === true) {
            await new Promise(() => {
              /* never resolves */
            });
            throw new Error('unreachable');
          }
          if (opts.tailReject !== undefined) throw opts.tailReject;
          return { events: opts.tailEvents ?? [], total: opts.tailEvents?.length ?? 0 };
        },
      },
      questions: {
        list: async () => [],
        get: async () => null,
        answer: async () => {
          throw new Error('unused');
        },
      },
      waves: { list: async () => [], get: async () => null },
      mode: { get: async () => ({ mode: 'plan' as const }) },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    subscribe: (async (_topic: string, args: unknown, listener: (e: unknown) => void) => {
      const workerId = (args as { workerId: string }).workerId;
      const entry: SubscriptionEntry = { workerId, listener, unsubscribed: false };
      subs.push(entry);
      return {
        topic: 'workers.events',
        unsubscribe: async (): Promise<void> => {
          entry.unsubscribed = true;
        },
      };
    }) as unknown as TuiRpc['subscribe'],
    close: async () => {},
  };
  return {
    rpc,
    emit(workerId: string, event: StreamEvent): void {
      for (const sub of subs) {
        if (sub.workerId === workerId && !sub.unsubscribed) sub.listener(event);
      }
    },
  };
}

function FocusForcer({ to }: { readonly to: FocusKey }): React.JSX.Element {
  const focus = useFocus();
  // Only set focus once; calling on every focus-controller identity change
  // would loop because the FocusReducer always returns a new state object,
  // which regenerates the controller, which re-fires this effect, etc.
  // useRef gates the call so the effect's setMain only runs on first mount.
  const fired = React.useRef(false);
  React.useEffect(() => {
    if (fired.current) return;
    fired.current = true;
    focus.setMain(to);
  });
  return <></>;
}

function flush(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}

interface Scenario {
  readonly name: string;
  readonly description: string;
  readonly initialSelectedId: string | null;
  readonly tailEvents?: StreamEvent[];
  readonly tailReject?: Error;
  /** When true, the fake tail RPC never resolves — captures the
   * pre-backfill waiting state with the Equalizer. */
  readonly tailPending?: boolean;
  readonly liveEvents?: StreamEvent[];
  /** Number of PageUp keystrokes to issue before capture. */
  readonly pageUps?: number;
  /** Override the harness terminal columns (default 100 for narrow demo). */
  readonly columns?: number;
  /** Override the harness terminal rows (default 30). */
  readonly rows?: number;
}

const text = (t: string): StreamEvent => ({ type: 'assistant_text', text: t });
const thinking = (t: string): StreamEvent => ({ type: 'assistant_thinking', text: t });
const toolUse = (callId: string, name: string, input: Record<string, unknown> = {}): StreamEvent => ({
  type: 'tool_use',
  callId,
  name,
  input,
});
const toolResult = (callId: string, content: string, isError = false): StreamEvent => ({
  type: 'tool_result',
  callId,
  content,
  isError,
});
const result = (isError = false): StreamEvent => ({
  type: 'result',
  sessionId: 'sess-1',
  isError,
  resultText: 'done',
  durationMs: 12_000,
  numTurns: 4,
  usageByModel: {},
});
const retry = (attempt = 1, delayMs = 5000): StreamEvent => ({
  type: 'system_api_retry',
  attempt,
  delayMs,
  raw: { attempt, delayMs },
});
const parseError = (reason: string): StreamEvent => ({ type: 'parse_error', reason });

const SAMPLE_FILE_BODY = [
  'export function add(a: number, b: number): number {',
  '  return a + b;',
  '}',
  '',
  'export function sub(a: number, b: number): number {',
  '  return a - b;',
  '}',
].join('\n');

const SCENARIOS: Scenario[] = [
  {
    name: '01-no-selection',
    description: 'No worker selected — Select a worker hint visible.',
    initialSelectedId: null,
  },
  {
    name: '02-waiting-for-first-event',
    description:
      'Worker selected, but tail is mocked to never resolve so the Equalizer + waiting hint shows.',
    initialSelectedId: 'w-1',
    tailPending: true,
  },
  {
    name: '03-mid-assistant-text',
    description:
      'Backfill of two assistant text turns + a tool_use + tool_result — typical mid-task state.',
    initialSelectedId: 'w-1',
    tailEvents: [
      text("I'll start by reading the file you mentioned."),
      toolUse('c1', 'Read', { file_path: 'src/math/operations.ts' }),
      toolResult('c1', SAMPLE_FILE_BODY),
      text('The file looks good. Adding multiplication next.'),
    ],
  },
  {
    name: '04-mid-thinking',
    description: 'Assistant_thinking block visible (muted italic prefix).',
    initialSelectedId: 'w-1',
    tailEvents: [
      thinking('the user wants me to refactor without changing the public API surface'),
      text("Got it — refactoring internals."),
    ],
  },
  {
    name: '05-mid-tool-call-with-error',
    description: 'Tool_use followed by an error tool_result (red).',
    initialSelectedId: 'w-1',
    tailEvents: [
      toolUse('c2', 'Bash', { command: 'pnpm test' }),
      toolResult(
        'c2',
        'Error: Cannot find module @anthropic-ai/sdk\n  at Function.Module._resolveFilename\n  at Function.Module._load',
        true,
      ),
    ],
  },
  {
    name: '06-completed',
    description: 'Terminal "● completed — N turns, Ns" row at the bottom.',
    initialSelectedId: 'w-1',
    tailEvents: [
      text('All tests pass. Ready to merge.'),
      result(false),
    ],
  },
  {
    name: '07-rate-limited',
    description: 'Sticky amber banner + amber inline retry row.',
    initialSelectedId: 'w-1',
    tailEvents: [
      text("Sending request to Anthropic API..."),
      retry(2, 8000),
    ],
  },
  {
    name: '08-parse-error',
    description: 'Red parse_error row from a malformed stream chunk.',
    initialSelectedId: 'w-1',
    tailEvents: [
      text('partial stream chunk'),
      parseError("malformed json: Unexpected token at position 42"),
    ],
  },
  {
    name: '09-truncated-tool-result',
    description:
      'Tool_result that exceeds the 12-line + 1500-char cap shows the "… N more lines" suffix.',
    initialSelectedId: 'w-1',
    tailEvents: [
      toolUse('c3', 'Bash', { command: 'pnpm test --reporter=verbose' }),
      toolResult(
        'c3',
        Array.from({ length: 30 }, (_, i) => `  PASS  src/feature-${i + 1}.test.ts`).join('\n'),
      ),
    ],
  },
  {
    name: '10-narrow-layout',
    description:
      'Terminal width 80 cols (NarrowLayout collapses chat → workers → output vertically).',
    initialSelectedId: 'w-1',
    tailEvents: [text('this is a narrow-layout demo'), result(false)],
    columns: 80,
    rows: 40,
  },
];

interface CapturedFrame {
  ansi: string;
  plain: string;
}

async function captureScenario(scenario: Scenario): Promise<CapturedFrame> {
  const handle = makeFakeRpc({
    ...(scenario.tailEvents !== undefined ? { tailEvents: scenario.tailEvents } : {}),
    ...(scenario.tailReject !== undefined ? { tailReject: scenario.tailReject } : {}),
    ...(scenario.tailPending === true ? { tailPending: true } : {}),
  });
  const rows = scenario.rows ?? 30;
  const columns = scenario.columns ?? 100;

  const tree = (
    <Box flexDirection="column" height={rows} width={columns}>
      <ThemeProvider>
        <FocusProvider>
          <FocusForcer to="output" />
          <KeybindProvider
            initialCommands={buildGlobalCommands({
              cycleFocus: () => {},
              cycleFocusReverse: () => {},
              requestExit: () => {},
              showHelp: () => {},
            })}
          >
            <WorkerSelectionProvider initialSelectedId={scenario.initialSelectedId}>
              <OutputPanel rpc={handle.rpc} />
            </WorkerSelectionProvider>
          </KeybindProvider>
        </FocusProvider>
      </ThemeProvider>
    </Box>
  );

  const result = render(tree);
  await flush();
  await flush();
  await flush();

  if (scenario.liveEvents !== undefined) {
    for (const ev of scenario.liveEvents) {
      handle.emit(scenario.initialSelectedId ?? 'w-1', ev);
    }
    await flush();
    await flush();
  }

  const stdin = (result as unknown as { stdin: { write: (s: string) => void } }).stdin;
  if (scenario.pageUps !== undefined) {
    for (let i = 0; i < scenario.pageUps; i += 1) {
      stdin.write('\x1b[5~');
      await flush();
    }
    await flush();
  }

  const ansi = result.lastFrame() ?? '';
  const plain = stripAnsi(ansi);
  result.unmount();
  return { ansi, plain };
}

function stripAnsi(input: string): string {
  // eslint-disable-next-line no-control-regex
  return input.replace(/\x1b\[[\d;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  const summary: string[] = [
    '# Phase 3D.1 visual frames',
    '',
    `Generated: ${new Date().toISOString()}`,
    '',
    'Each scenario renders the OutputPanel under a 3D.1 canonical state.',
    'Inspect `.plain.txt` for human-readable review;',
    '`.ansi.txt` keeps the color escapes (grep `\\x1b[38;2;…m` for hex codes).',
    '',
    'Palette under review (locked from PLAN.md §3A):',
    '- violet `#7C6FEB` (accent, borderActive — focused panel) → `\\x1b[38;2;124;111;235m`',
    '- gold `#D4A843` (toolSuccess, success — completed) → `\\x1b[38;2;212;168;67m`',
    '- gold-light `#E5C07B` (rateLimitWarning — banner + inline retry row) → `\\x1b[38;2;229;192;123m`',
    '- red `#E06C75` (toolError, error — parse_error + ✗ failed + tool_result error) → `\\x1b[38;2;224;108;117m`',
    '- text light gray `#E0E0E0` (outputText — assistant text) → `\\x1b[38;2;224;224;224m`',
    '- muted gray `#888888` (textMuted, toolPending — tool_use + thinking + hints) → `\\x1b[38;2;136;136;136m`',
    '',
    'Event-row glyphs to verify:',
    '- assistant_text → no glyph; default outputText color',
    '- assistant_thinking → `thinking  ...` muted-italic prefix',
    '- tool_use → `▸ <name>  <summary>` in toolPending muted gray',
    '- tool_result (success) → ANSI-stripped content in toolSuccess gold',
    '- tool_result (error) → ANSI-stripped content in toolError red',
    '- result (success) → `● completed — N turns, Ns` in success gold',
    '- result (error) → `✗ failed — ...` in error red',
    '- system_api_retry → `⏱ rate limited — attempt N, retry in Xs` in rateLimitWarning amber',
    '- parse_error → `parse_error: <reason>` in error red',
    '',
    'Sticky rate-limit banner: when the most recent visible event is a',
    'system_api_retry not yet followed by anything else, the panel renders',
    'an amber bold banner row at the top — composed with the inline event row.',
    '',
    'Layout invariants:',
    '- focused panel border = violet (output panel forced focus in this harness)',
    '- empty selection state shows the no-selection hint, no scroll markers',
    '- waiting state (pre-backfill) shows the Equalizer (4 violet bars) +',
    '  "Waiting for first event…" on the same line',
    '- truncated tool_result shows trailing "… N more lines"',
    '- narrow layout (col < 100) collapses to vertical stack: chat → workers → output',
    '',
    '| Scenario | Description |',
    '|---|---|',
  ];

  for (const scenario of SCENARIOS) {
    process.stderr.write(`Capturing ${scenario.name}…\n`);
    const { ansi, plain } = await captureScenario(scenario);
    writeFileSync(path.join(OUT_DIR, `3d1-${scenario.name}.ansi.txt`), ansi, 'utf8');
    writeFileSync(
      path.join(OUT_DIR, `3d1-${scenario.name}.plain.txt`),
      `# ${scenario.name}\n# ${scenario.description}\n\n${plain}\n`,
      'utf8',
    );
    summary.push(`| \`${scenario.name}\` | ${scenario.description} |`);
  }

  writeFileSync(path.join(OUT_DIR, 'INDEX-3d1.md'), summary.join('\n') + '\n', 'utf8');
  process.stderr.write(`\n${SCENARIOS.length} frames written to ${OUT_DIR}\n`);
}

void main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
