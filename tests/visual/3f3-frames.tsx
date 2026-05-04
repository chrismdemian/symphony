/**
 * Phase 3F.3 — visual frame harness for the question history popup.
 *
 * Captures canonical states:
 *   01-history-multi          three answered questions, newest first
 *   02-history-empty          empty state — "(no answered questions yet)"
 *   03-history-no-project     answered question with no projectId fallback
 *   04-history-loading        first paint before fake RPC resolves
 *
 * `.visual-frames/3f3-<state>.{ansi,plain}.txt` + `INDEX-3f3.md`.
 */
import React from 'react';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Box } from 'ink';
import { render } from 'ink-testing-library';
import { ThemeProvider } from '../../src/ui/theme/context.js';
import { FocusProvider, type FocusState } from '../../src/ui/focus/focus.js';
import { KeybindProvider } from '../../src/ui/keybinds/dispatcher.js';
import { QuestionHistory } from '../../src/ui/panels/questions/QuestionHistory.js';
import type { TuiRpc } from '../../src/ui/runtime/rpc.js';
import type { QuestionSnapshot } from '../../src/state/question-registry.js';
import type { ProjectSnapshot } from '../../src/projects/types.js';

const OUT_DIR = path.resolve(process.cwd(), '.visual-frames');

function makeFakeRpc(
  answered: readonly QuestionSnapshot[],
  delay = 0,
): TuiRpc {
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
        list: ((filter?: { answered?: boolean }) => {
          if (filter?.answered === true) {
            if (delay > 0) {
              return new Promise((resolve) => {
                setTimeout(() => resolve([...answered]), delay);
              });
            }
            return Promise.resolve([...answered]);
          }
          return Promise.resolve([]);
        }) as never,
        get: stub() as never,
        answer: stub() as never,
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

interface Scenario {
  readonly name: string;
  readonly description: string;
  readonly answered: readonly QuestionSnapshot[];
  readonly delay?: number;
  readonly waitMs?: number;
}

const SCENARIOS: Scenario[] = [
  {
    name: '01-history-multi',
    description:
      'Three answered questions sorted newest answeredAt first. Violet border, urgency badges, Q/A pairs muted-gray for answers.',
    answered: [
      {
        id: 'q-301',
        question: 'Pick a default model for the implementer role: Opus or Sonnet?',
        urgency: 'blocking',
        askedAt: '2026-05-04T00:00:00.000Z',
        answered: true,
        answer: 'opus',
        answeredAt: '2026-05-04T00:00:30.000Z',
        projectId: 'p-mathscrabble',
      },
      {
        id: 'q-302',
        question: 'Branch naming convention: `feature/` or `feat/`?',
        urgency: 'advisory',
        askedAt: '2026-05-04T00:01:00.000Z',
        answered: true,
        answer: 'feature/',
        answeredAt: '2026-05-04T00:02:00.000Z',
        projectId: 'p-mathscrabble',
      },
      {
        id: 'q-303',
        question: 'Should `finalize` auto-merge to master or stop at PR-ready?',
        urgency: 'blocking',
        askedAt: '2026-05-04T00:02:00.000Z',
        answered: true,
        answer: 'stop at PR-ready',
        answeredAt: '2026-05-04T00:03:00.000Z',
        projectId: 'p-mathscrabble',
      },
    ],
  },
  {
    name: '02-history-empty',
    description: 'No answered questions yet — empty-state message in muted gray.',
    answered: [],
  },
  {
    name: '03-history-no-project',
    description: 'Single answered question with no projectId — project label omitted.',
    answered: [
      {
        id: 'q-orphan',
        question: 'Want me to create a default project at the cwd?',
        urgency: 'advisory',
        askedAt: '2026-05-04T00:00:00.000Z',
        answered: true,
        answer: 'yes',
        answeredAt: '2026-05-04T00:00:10.000Z',
      },
    ],
  },
  {
    name: '04-history-loading',
    description: 'First-paint loading state — header shows "(loading)" while RPC is in flight.',
    answered: [],
    delay: 1000,
    waitMs: 50,
  },
];

interface CapturedFrame {
  readonly ansi: string;
  readonly plain: string;
}

async function flushAll(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await Promise.resolve();
    await new Promise((r) => setImmediate(r));
  }
}

const INITIAL_FOCUS: FocusState = {
  stack: [
    { kind: 'main', key: 'chat' },
    { kind: 'popup', key: 'question-history' },
  ],
};

async function captureScenario(scenario: Scenario): Promise<CapturedFrame> {
  const rows = 28;
  const columns = 110;
  const rpc = makeFakeRpc(scenario.answered, scenario.delay ?? 0);

  const result = render(
    <Box flexDirection="column" height={rows} width={columns}>
      <ThemeProvider>
        <FocusProvider initial={INITIAL_FOCUS}>
          <KeybindProvider initialCommands={[]}>
            <QuestionHistory rpc={rpc} projects={PROJECTS} />
          </KeybindProvider>
        </FocusProvider>
      </ThemeProvider>
    </Box>,
  );

  await flushAll();
  // Wait for RPC to resolve (or for the loading state to be observed).
  if (scenario.waitMs !== undefined) {
    await new Promise((r) => setTimeout(r, scenario.waitMs));
  } else {
    await new Promise((r) => setTimeout(r, 50));
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
    '# Phase 3F.3 visual frames',
    '',
    `Generated: ${new Date().toISOString()}`,
    '',
    'QuestionHistory popup — answered-question archive surfaced via the palette.',
    '',
    'Palette referenced (locked):',
    '- `accent` (popup border, header, selected `▸` marker) → violet `#7C6FEB` → `\\x1b[38;2;124;111;235m`',
    '- `error` (BLOCKING tag) → red `#E06C75` → `\\x1b[38;2;224;108;117m`',
    '- `warning` (advisory tag) → gold-light `#E5C07B` → `\\x1b[38;2;229;192;123m`',
    '- `text` (question text) → light gray `#E0E0E0` → `\\x1b[38;2;224;224;224m`',
    '- `textMuted` (answer text, project labels, footer hint) → muted `#888888` → `\\x1b[38;2;136;136;136m`',
    '',
    'Keybind contract (popup scope `question-history`):',
    '- ↑/↓ → scroll selection',
    '- Esc → close popup',
    '',
    '| Scenario | Description |',
    '|---|---|',
  ];

  for (const scenario of SCENARIOS) {
    process.stderr.write(`Capturing ${scenario.name}…\n`);
    const { ansi, plain } = await captureScenario(scenario);
    writeFileSync(path.join(OUT_DIR, `3f3-${scenario.name}.ansi.txt`), ansi, 'utf8');
    writeFileSync(
      path.join(OUT_DIR, `3f3-${scenario.name}.plain.txt`),
      `# ${scenario.name}\n# ${scenario.description}\n\n${plain}\n`,
      'utf8',
    );
    summary.push(`| \`${scenario.name}\` | ${scenario.description} |`);
  }

  writeFileSync(path.join(OUT_DIR, 'INDEX-3f3.md'), summary.join('\n') + '\n', 'utf8');
  process.stderr.write(`\n${SCENARIOS.length} frames written to ${OUT_DIR}\n`);
}

void main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
