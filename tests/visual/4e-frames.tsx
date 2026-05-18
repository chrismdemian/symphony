/**
 * Phase 4E — visual frame harness.
 *
 * Captures the OutputPanel rendering `structured_completion` events: the
 * full textual completion summary (authoritative) plus the optional
 * advisory `display` json-render spec beneath it. Canonical states:
 * PASS no-display, FAIL with blockers + preview, advisory Card display,
 * advisory Table display, malformed display → fallback (textual summary
 * unaffected), multiple concurrent display blocks (the focus-shim
 * multi-instance case), and an open_questions-bearing report.
 *
 * Output: `.visual-frames/4e-<state>.{ansi,plain}.txt` + `INDEX-4e.md`.
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
import type { StreamEvent, WorkerCompletionReport } from '../../src/workers/types.js';

const OUT_DIR = path.resolve(process.cwd(), '.visual-frames');

interface SubscriptionEntry {
  workerId: string;
  listener: (e: unknown) => void;
  unsubscribed: boolean;
}

function makeFakeRpc(opts: {
  tailEvents?: StreamEvent[];
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
        tail: async () => ({
          events: opts.tailEvents ?? [],
          total: opts.tailEvents?.length ?? 0,
        }),
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
  readonly columns?: number;
  readonly rows?: number;
}

function report(over: Partial<WorkerCompletionReport> = {}): WorkerCompletionReport {
  return {
    did: ['x'],
    skipped: [],
    blockers: [],
    open_questions: [],
    audit: 'PASS',
    cite: [],
    tests_run: [],
    preview_url: null,
    ...over,
  };
}

const completion = (over: Partial<WorkerCompletionReport>): StreamEvent => ({
  type: 'structured_completion',
  report: report(over),
  raw: '{}',
});

const CARD_DISPLAY = {
  root: 'card-1',
  elements: {
    'card-1': {
      type: 'Card',
      props: { title: 'Run Summary' },
      children: ['h-1', 't-1'],
    },
    'h-1': { type: 'Heading', props: { text: 'auth refactor' } },
    't-1': { type: 'Text', props: { text: '3 files changed, 142 tests green' } },
  },
} as const;

const TABLE_DISPLAY = {
  root: 'tbl',
  elements: {
    tbl: {
      type: 'Table',
      props: {
        columns: [
          { header: 'Suite', key: 'suite' },
          { header: 'Result', key: 'result' },
        ],
        rows: [
          { suite: 'unit', result: '142/142' },
          { suite: 'integration', result: '18/18' },
          { suite: 'scenarios', result: '40/40' },
        ],
      },
    },
  },
} as const;

const SCENARIOS: Scenario[] = [
  {
    name: '01-pass-display-omitted',
    description:
      'audit PASS, `display` key OMITTED entirely (→ undefined) → just the authoritative one-line textual summary (counts only).',
    initialSelectedId: 'w-1',
    tailEvents: [
      completion({
        did: ['wired the reconnect', 'added backoff'],
        skipped: ['metrics dashboard (out of scope)'],
        tests_run: ['pnpm test: PASS', 'pnpm build: PASS'],
      }),
    ],
  },
  {
    name: '02-fail-blockers-preview',
    description:
      'audit FAIL → red audit token; blockers each on their own red line; preview_url line in muted gray.',
    initialSelectedId: 'w-1',
    tailEvents: [
      completion({
        audit: 'FAIL',
        did: ['attempted migration 0007'],
        blockers: [
          'migration 0007 conflicts with the 0006 audit_log trigger',
          'cannot reconcile without a manual rebase',
        ],
        preview_url: 'http://localhost:3000',
      }),
    ],
  },
  {
    name: '03-display-card',
    description:
      'audit PASS + advisory `display` Card → textual summary on top, themed (violet border + gold heading) Card rendered below via the shimmed JsonRenderBlock stack.',
    initialSelectedId: 'w-1',
    tailEvents: [completion({ did: ['shipped auth refactor'], display: CARD_DISPLAY })],
    rows: 32,
  },
  {
    name: '04-display-table',
    description:
      'audit PASS + advisory `display` Table → multi-row results table beneath the summary.',
    initialSelectedId: 'w-1',
    tailEvents: [
      completion({
        did: ['ran the full matrix'],
        tests_run: ['pnpm verify: PASS'],
        display: TABLE_DISPLAY,
      }),
    ],
    rows: 32,
  },
  {
    name: '05-malformed-display',
    description:
      'audit PASS + `display` is a bare string (not a spec) → advisory degrades to the ⚠ fallback row; the textual summary stays authoritative and intact (display NEVER affects audit).',
    initialSelectedId: 'w-1',
    tailEvents: [
      completion({
        audit: 'PASS',
        did: ['ok'],
        display: 'I forgot to emit a real json-render spec here',
      }),
    ],
  },
  {
    name: '06-multiple-completions-display',
    description:
      'THREE structured_completion events, each with its own `display` Card — the 4E multi-instance case. With the NoopFocusProvider shim this mounts ZERO json-render Tab handlers (no rivalry with Symphony KeybindProvider).',
    initialSelectedId: 'w-1',
    tailEvents: [
      completion({ did: ['worker A done'], display: CARD_DISPLAY }),
      completion({ did: ['worker B done'], display: TABLE_DISPLAY }),
      completion({ did: ['worker C done'], display: CARD_DISPLAY }),
    ],
    rows: 40,
  },
  {
    name: '07-open-questions',
    description:
      'audit PASS with open_questions populated → count shown in the summary (the entries themselves route to the 3E Question History as advisory/auto-acknowledged, not into this panel — rule #7).',
    initialSelectedId: 'w-1',
    tailEvents: [
      completion({
        did: ['fixed the bug'],
        open_questions: [
          'the legacy poller looks dead — worth removing?',
          'should auth move to middleware?',
        ],
      }),
    ],
  },
  {
    name: '08-display-null',
    description:
      'audit PASS with `display: null` — the DOCUMENTED contract default every worker emits. MUST render just the summary (NO ⚠ fallback row). This is the 4E-C1 regression: `null` === "no display", treated identically to omitted.',
    initialSelectedId: 'w-1',
    tailEvents: [completion({ did: ['shipped'], display: null })],
  },
];

interface CapturedFrame {
  ansi: string;
  plain: string;
}

async function captureScenario(scenario: Scenario): Promise<CapturedFrame> {
  const handle = makeFakeRpc({
    ...(scenario.tailEvents !== undefined ? { tailEvents: scenario.tailEvents } : {}),
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
    '# Phase 4E visual frames',
    '',
    `Generated: ${new Date().toISOString()}`,
    '',
    'Each scenario renders the OutputPanel with `structured_completion` events.',
    'Inspect `.plain.txt` for human-readable review;',
    '`.ansi.txt` keeps the color escapes (grep `\\x1b[38;2;…m` for hex codes).',
    '',
    'Locked palette tokens (all refs to existing palette — no new hex codes):',
    '- audit PASS / success → gold `#D4A843` → `\\x1b[38;2;212;168;67m`',
    '- audit FAIL / blockers / fallback → red `#E06C75` → `\\x1b[38;2;224;108;117m`',
    '- summary chrome / preview / muted → muted gray `#888888` → `\\x1b[38;2;136;136;136m`',
    '- json-render Card border → violet `#7C6FEB` → `\\x1b[38;2;124;111;235m`',
    '- json-render Heading → gold `#D4A843` → `\\x1b[38;2;212;168;67m`',
    '',
    'Phase 4E contract under review:',
    '- Textual fields (audit/did/skipped/blockers/open_questions/tests/preview) are AUTHORITATIVE.',
    '- `display` is advisory: rendered beneath the summary; malformed/absent → text only, never affects audit.',
    '- `display` renders through `<JsonRenderBlock>` with the `<NoopFocusProvider>` shim — N concurrent',
    '  blocks register ZERO Ink `useInput` Tab handlers (definitive observable proof: `pnpm smoke:4e`).',
    '- open_questions are COUNTED here; the entries route to the 3E Question History (advisory,',
    '  auto-acknowledged) — they never block this panel or the popup (rule #7).',
    '',
    '| Scenario | Description |',
    '|---|---|',
  ];

  for (const scenario of SCENARIOS) {
    process.stderr.write(`Capturing ${scenario.name}…\n`);
    const { ansi, plain } = await captureScenario(scenario);
    writeFileSync(path.join(OUT_DIR, `4e-${scenario.name}.ansi.txt`), ansi, 'utf8');
    writeFileSync(
      path.join(OUT_DIR, `4e-${scenario.name}.plain.txt`),
      `# ${scenario.name}\n# ${scenario.description}\n\n${plain}\n`,
      'utf8',
    );
    summary.push(`| \`${scenario.name}\` | ${scenario.description} |`);
  }

  writeFileSync(path.join(OUT_DIR, 'INDEX-4e.md'), summary.join('\n') + '\n', 'utf8');
  process.stderr.write(`\n${SCENARIOS.length} frames written to ${OUT_DIR}\n`);
}

void main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
