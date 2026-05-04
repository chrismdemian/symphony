/**
 * Phase 3E — visual frame harness for the question popup.
 *
 * Captures the QuestionPopup overlay under canonical states:
 *  01-blocking-single        single blocking question, project + worker present
 *  02-advisory-single        single advisory question (gold-light tag)
 *  03-multi-queued           three blocking questions, "1/3 queued" footer
 *  04-context-overflow       blocking question with a long context block
 *  05-no-project-no-worker   minimal — `(no project)` + `(no worker)` fallbacks
 *  06-after-error            simulated submit error displayed inline
 *  07-statusbar-badge        StatusBar standalone showing Q: <n> in red/gold
 *
 * `.visual-frames/3e-<state>.{ansi,plain}.txt` + `INDEX-3e.md`.
 */
import React from 'react';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Box } from 'ink';
import { render } from 'ink-testing-library';
import { ThemeProvider } from '../../src/ui/theme/context.js';
import { FocusProvider, type FocusState } from '../../src/ui/focus/focus.js';
import { KeybindProvider } from '../../src/ui/keybinds/dispatcher.js';
import { QuestionPopup } from '../../src/ui/panels/questions/QuestionPopup.js';
import { StatusBar } from '../../src/ui/layout/StatusBar.js';
import type { TuiRpc } from '../../src/ui/runtime/rpc.js';
import type { QuestionSnapshot } from '../../src/state/question-registry.js';
import type { ProjectSnapshot } from '../../src/projects/types.js';

const OUT_DIR = path.resolve(process.cwd(), '.visual-frames');

function makeFakeRpc(opts?: {
  rejectAnswer?: string;
}): TuiRpc {
  const stub = (): unknown => () => Promise.resolve();
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
        answer: (() => {
          if (opts?.rejectAnswer !== undefined) {
            return Promise.reject(new Error(opts.rejectAnswer));
          }
          return Promise.resolve({});
        }) as never,
      },
      waves: { list: stub() as never, get: stub() as never },
      mode: { get: stub() as never },
    },
    subscribe: (() => Promise.resolve({ topic: 'workers.events', unsubscribe: () => {} })) as never,
    close: stub() as never,
  } as unknown as TuiRpc;
}

const PROJECTS: readonly ProjectSnapshot[] = [
  {
    id: 'p-mathscrabble',
    name: 'MathScrabble',
    path: 'C:/foo',
    createdAt: '2026-04-29T00:00:00.000Z',
  },
];

const FIXED_NOW = (): number => Date.parse('2026-05-04T00:02:00.000Z');

function snap(over: Partial<QuestionSnapshot>): QuestionSnapshot {
  return {
    id: over.id ?? 'q-1',
    question: over.question ?? 'placeholder',
    urgency: over.urgency ?? 'blocking',
    askedAt: over.askedAt ?? '2026-05-04T00:00:00.000Z',
    answered: false,
    ...(over.context !== undefined ? { context: over.context } : {}),
    ...(over.projectId !== undefined ? { projectId: over.projectId } : {}),
    ...(over.workerId !== undefined ? { workerId: over.workerId } : {}),
  };
}

interface PopupScenario {
  readonly kind: 'popup';
  readonly name: string;
  readonly description: string;
  readonly questions: readonly QuestionSnapshot[];
  readonly rows?: number;
  readonly columns?: number;
  readonly rpc?: TuiRpc;
  /** Send a few keystrokes after mount to drive the popup into a sub-state. */
  readonly drive?: (stdin: { write: (s: string) => void }) => Promise<void>;
}

interface StatusBarScenario {
  readonly kind: 'statusbar';
  readonly name: string;
  readonly description: string;
  readonly questionsCount: number;
  readonly blockingCount: number;
  readonly rows?: number;
  readonly columns?: number;
}

type Scenario = PopupScenario | StatusBarScenario;

const POPUP_INITIAL_FOCUS: FocusState = {
  stack: [
    { kind: 'main', key: 'chat' },
    { kind: 'popup', key: 'question' },
  ],
};

const SCENARIOS: Scenario[] = [
  {
    kind: 'popup',
    name: '01-blocking-single',
    description:
      'Single blocking question with project + worker. Violet border, [BLOCKING] tag in red, body in light gray.',
    questions: [
      snap({
        id: 'q-100',
        question: 'Should we use Postgres or SQLite for the cache layer?',
        urgency: 'blocking',
        projectId: 'p-mathscrabble',
        workerId: 'w-abc12345',
      }),
    ],
  },
  {
    kind: 'popup',
    name: '02-advisory-single',
    description:
      'Single advisory question — `[advisory]` in gold-light, no urgency-driven red signal.',
    questions: [
      snap({
        id: 'q-200',
        question: 'Worker w-zz finished its review. Want a summary?',
        urgency: 'advisory',
        projectId: 'p-mathscrabble',
        workerId: 'w-zzz98765',
      }),
    ],
  },
  {
    kind: 'popup',
    name: '03-multi-queued',
    description:
      'Three blocking questions queued — footer shows "1/3 queued" + Tab/Shift+Tab navigation hint.',
    questions: [
      snap({
        id: 'q-301',
        question: 'Pick a default model for the implementer role: Opus or Sonnet?',
        urgency: 'blocking',
        projectId: 'p-mathscrabble',
        askedAt: '2026-05-04T00:00:00.000Z',
      }),
      snap({
        id: 'q-302',
        question: 'Branch naming convention: `feature/` or `feat/`?',
        urgency: 'blocking',
        projectId: 'p-mathscrabble',
        askedAt: '2026-05-04T00:00:30.000Z',
      }),
      snap({
        id: 'q-303',
        question: 'Should `finalize` auto-merge to master or stop at PR-ready?',
        urgency: 'blocking',
        projectId: 'p-mathscrabble',
        askedAt: '2026-05-04T00:01:00.000Z',
      }),
    ],
  },
  {
    kind: 'popup',
    name: '04-context-overflow',
    description:
      'Blocking question with a multi-line context block — verifies muted-gray Context: rendering.',
    questions: [
      snap({
        id: 'q-400',
        question: 'Postgres or SQLite?',
        urgency: 'blocking',
        projectId: 'p-mathscrabble',
        workerId: 'w-cache-eng',
        context:
          'The cache holds 100K rows. Postgres adds infra cost and latency budget; SQLite keeps the deploy single-file. PLAN.md §2 leans SQLite for greenfield; the team hit perf cliffs with SQLite at >10M rows.',
      }),
    ],
  },
  {
    kind: 'popup',
    name: '05-no-project-no-worker',
    description:
      'Minimal question — no project, no worker. Falls back to `(no project)` / `(no worker)`.',
    questions: [
      snap({
        id: 'q-500',
        question: 'Want me to create a default project at the cwd?',
        urgency: 'advisory',
      }),
    ],
  },
  {
    kind: 'popup',
    name: '06-after-error',
    description:
      'After typing + Enter, the RPC rejects with "already answered" — error renders in red, popup stays open.',
    questions: [
      snap({
        id: 'q-600',
        question: 'Pick a deploy region: us-east-1 or eu-west-1?',
        urgency: 'blocking',
        projectId: 'p-mathscrabble',
      }),
    ],
    rpc: makeFakeRpc({ rejectAnswer: 'already answered' }),
    drive: async (stdin) => {
      // Wait one tick for popup-scope keybinds to register, then type +
      // submit — the rpc rejects → setState('error') runs after a few
      // microtasks.
      await flushAll();
      stdin.write('us-east-1');
      await flushAll();
      stdin.write('\r');
      await flushAll();
    },
  },
  {
    kind: 'statusbar',
    name: '07-statusbar-badge-blocking',
    description: 'StatusBar with Q: 3 (1 blocking) — red truecolor escape on the count cell.',
    questionsCount: 3,
    blockingCount: 1,
    rows: 1,
  },
  {
    kind: 'statusbar',
    name: '08-statusbar-badge-advisory',
    description: 'StatusBar with Q: 2 (advisory only) — gold-light truecolor escape.',
    questionsCount: 2,
    blockingCount: 0,
    rows: 1,
  },
  {
    kind: 'statusbar',
    name: '09-statusbar-badge-empty',
    description: 'StatusBar with Q: 0 — muted gray (same color as the labels) — no signal.',
    questionsCount: 0,
    blockingCount: 0,
    rows: 1,
  },
];

interface CapturedFrame {
  ansi: string;
  plain: string;
}

async function flushAll(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await Promise.resolve();
    await new Promise((r) => setImmediate(r));
  }
}

async function captureScenario(scenario: Scenario): Promise<CapturedFrame> {
  const rows = scenario.rows ?? 28;
  const columns = scenario.columns ?? 100;

  let result: ReturnType<typeof render>;
  if (scenario.kind === 'statusbar') {
    result = render(
      <Box flexDirection="column" height={rows} width={columns}>
        <ThemeProvider>
          <StatusBar
            version="0.1.0"
            mode="plan"
            projects={[]}
            workers={[]}
            sessionId={null}
            questionsCount={scenario.questionsCount}
            blockingCount={scenario.blockingCount}
          />
        </ThemeProvider>
      </Box>,
    );
    await flushAll();
  } else {
    const rpc = scenario.rpc ?? makeFakeRpc();
    result = render(
      <Box flexDirection="column" height={rows} width={columns}>
        <ThemeProvider>
          <FocusProvider initial={POPUP_INITIAL_FOCUS}>
            <KeybindProvider initialCommands={[]}>
              <QuestionPopup
                rpc={rpc}
                questions={scenario.questions}
                projects={PROJECTS}
                now={FIXED_NOW}
              />
            </KeybindProvider>
          </FocusProvider>
        </ThemeProvider>
      </Box>,
    );
    await flushAll();
    if (scenario.drive !== undefined) {
      await scenario.drive(result.stdin as unknown as { write: (s: string) => void });
    }
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
    '# Phase 3E visual frames',
    '',
    `Generated: ${new Date().toISOString()}`,
    '',
    'Each scenario renders the QuestionPopup (or StatusBar standalone) under canonical states.',
    'Inspect `.plain.txt` for human-readable review; `.ansi.txt` keeps escapes for hex-code grep.',
    '',
    'Palette referenced (locked, unchanged from PLAN.md §3A):',
    '- `accent` (popup border, "Question" title, queue index) → violet `#7C6FEB` → `\\x1b[38;2;124;111;235m`',
    '- `error` (BLOCKING tag, Q-cell red, submit error) → red `#E06C75` → `\\x1b[38;2;224;108;117m`',
    '- `warning` (advisory tag, Q-cell advisory-only) → gold-light `#E5C07B` → `\\x1b[38;2;229;192;123m`',
    '- `success` (transient "answered" toast) → gold `#D4A843` → `\\x1b[38;2;212;168;67m`',
    '- `text` (question body, project/worker labels) → light gray `#E0E0E0` → `\\x1b[38;2;224;224;224m`',
    '- `textMuted` (Context: prose, footer hints) → muted `#888888` → `\\x1b[38;2;136;136;136m`',
    '',
    'Keybind contract (popup scope `question`):',
    '- Enter → submit',
    '- Esc → dismiss',
    '- Tab / Shift+Tab → cycle queue (only when `total > 1`)',
    '- Ctrl+J → newline inside the answer InputBar (universal fallback)',
    '',
    '| Scenario | Description |',
    '|---|---|',
  ];

  for (const scenario of SCENARIOS) {
    process.stderr.write(`Capturing ${scenario.name}…\n`);
    const { ansi, plain } = await captureScenario(scenario);
    writeFileSync(path.join(OUT_DIR, `3e-${scenario.name}.ansi.txt`), ansi, 'utf8');
    writeFileSync(
      path.join(OUT_DIR, `3e-${scenario.name}.plain.txt`),
      `# ${scenario.name}\n# ${scenario.description}\n\n${plain}\n`,
      'utf8',
    );
    summary.push(`| \`${scenario.name}\` | ${scenario.description} |`);
  }

  writeFileSync(path.join(OUT_DIR, 'INDEX-3e.md'), summary.join('\n') + '\n', 'utf8');
  process.stderr.write(`\n${SCENARIOS.length} frames written to ${OUT_DIR}\n`);
}

void main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
