/**
 * Phase 3F.1 — visual frame harness for the command palette,
 * help overlay, and worker-selector popups.
 *
 * Captures canonical states:
 *   01-palette-empty               palette open, empty filter, full command list
 *   02-palette-filtered            filter "next" → narrowed list with char highlights
 *   03-palette-no-match            filter "zzzz" → "(no commands match)"
 *   04-palette-disabled            includes a disabled command with reason
 *   05-help-overlay-grouped        full help overlay grouped by scope
 *   06-worker-select-empty         worker selector with two workers, no filter
 *   07-worker-select-filtered      filter "api" narrows to one worker
 *
 * `.visual-frames/3f1-<state>.{ansi,plain}.txt` + `INDEX-3f1.md`.
 */
import React from 'react';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Box } from 'ink';
import { render } from 'ink-testing-library';
import { ThemeProvider } from '../../src/ui/theme/context.js';
import { FocusProvider, type FocusState } from '../../src/ui/focus/focus.js';
import { KeybindProvider } from '../../src/ui/keybinds/dispatcher.js';
import { Palette } from '../../src/ui/panels/palette/Palette.js';
import { HelpOverlay } from '../../src/ui/panels/help/HelpOverlay.js';
import { WorkerSelector } from '../../src/ui/panels/palette/WorkerSelector.js';
import { WorkerSelectionProvider } from '../../src/ui/data/WorkerSelection.js';
import type { Command } from '../../src/ui/keybinds/registry.js';
import type { WorkerRecordSnapshot } from '../../src/orchestrator/worker-registry.js';

const OUT_DIR = path.resolve(process.cwd(), '.visual-frames');

const noop = (): void => undefined;

const cmd = (
  id: string,
  title: string,
  scope: 'global' | 'main' | 'chat' | 'workers' | 'output',
  key: Command['key'],
  overrides?: Partial<Command>,
): Command => ({
  id,
  title,
  key,
  scope,
  displayOnScreen: true,
  onSelect: noop,
  ...overrides,
});

// Realistic seed of commands the user would see in production. Mirrors
// what `buildGlobalCommands` + per-panel commands register in App boot.
function seedCommands(): readonly Command[] {
  return [
    cmd('focus.cycle', 'next panel', 'global', { kind: 'tab' }),
    cmd('focus.cycleReverse', 'prev panel', 'global', {
      kind: 'tab',
      shift: true,
    }),
    cmd('app.exit', 'exit', 'global', { kind: 'ctrl', char: 'c' }),
    cmd('palette.open', 'command palette', 'global', { kind: 'ctrl', char: 'p' }),
    cmd('app.help', 'help', 'main', { kind: 'char', char: '?' }),
    cmd('questions.open', 'questions', 'main', { kind: 'ctrl', char: 'q' }, {
      disabledReason: 'no questions queued',
    }),
    cmd('worker.select', 'select worker', 'main', { kind: 'ctrl', char: 'w' }),
    cmd('chat.send', 'send', 'chat', { kind: 'return' }),
    cmd('workers.kill', 'kill worker', 'workers', { kind: 'char', char: 'K' }),
    cmd('output.scrollTop', 'scroll to top', 'output', { kind: 'char', char: 'g' }),
  ];
}

interface PaletteScenario {
  readonly kind: 'palette';
  readonly name: string;
  readonly description: string;
  readonly commands: readonly Command[];
  readonly drive?: (stdin: { write: (s: string) => void }) => Promise<void>;
}

interface HelpScenario {
  readonly kind: 'help';
  readonly name: string;
  readonly description: string;
  readonly commands: readonly Command[];
}

interface WorkerSelectorScenario {
  readonly kind: 'worker-select';
  readonly name: string;
  readonly description: string;
  readonly workers: readonly WorkerRecordSnapshot[];
  readonly drive?: (stdin: { write: (s: string) => void }) => Promise<void>;
}

type Scenario = PaletteScenario | HelpScenario | WorkerSelectorScenario;

function makeWorker(over: Partial<WorkerRecordSnapshot>): WorkerRecordSnapshot {
  return {
    id: over.id ?? 'w-aaa',
    projectPath: '/repos/demo',
    worktreePath: `/repos/demo/.symphony/worktrees/${over.id ?? 'w-aaa'}`,
    role: 'implementer',
    featureIntent: over.featureIntent ?? 'frontend redesign',
    taskDescription: 'task',
    autonomyTier: 1,
    dependsOn: [],
    status: over.status ?? 'running',
    createdAt: '2026-05-04T00:00:00.000Z',
    ...over,
  } as WorkerRecordSnapshot;
}

const SCENARIOS: Scenario[] = [
  {
    kind: 'palette',
    name: '01-palette-empty',
    description:
      'Palette open, empty filter — full command list with [chat]/[workers]/[output] scope badges.',
    commands: seedCommands(),
  },
  {
    kind: 'palette',
    name: '02-palette-filtered',
    description:
      'Filter "next" → matched commands with char-level violet highlight on n/e/x/t.',
    commands: seedCommands(),
    drive: async (stdin) => {
      stdin.write('next');
      await flushAll();
    },
  },
  {
    kind: 'palette',
    name: '03-palette-no-match',
    description: 'Filter "zzzz" → "(no commands match)".',
    commands: seedCommands(),
    drive: async (stdin) => {
      stdin.write('zzzz');
      await flushAll();
    },
  },
  {
    kind: 'palette',
    name: '04-palette-disabled',
    description:
      'Empty filter — disabled questions row dimmed with reason "(no questions queued)".',
    commands: seedCommands(),
  },
  {
    kind: 'help',
    name: '05-help-overlay-grouped',
    description:
      'Help overlay rendered with groups: Global, Main panels, Chat, Workers, Output.',
    commands: seedCommands(),
  },
  {
    kind: 'worker-select',
    name: '06-worker-select-empty',
    description:
      'Worker selector with two workers — no filter; both rows visible with status suffix.',
    workers: [
      makeWorker({ id: 'w-1', featureIntent: 'frontend redesign' }),
      makeWorker({ id: 'w-2', featureIntent: 'api refactor', status: 'completed' }),
    ],
  },
  {
    kind: 'worker-select',
    name: '07-worker-select-filtered',
    description:
      'Filter "endpoint" narrows to one row (rest endpoint refactor); matched chars in violet.',
    workers: [
      makeWorker({ id: 'w-1', featureIntent: 'frontend redesign' }),
      makeWorker({
        id: 'w-2',
        featureIntent: 'rest endpoint refactor',
        status: 'running',
      }),
      makeWorker({ id: 'w-3', featureIntent: 'docs cleanup' }),
    ],
    drive: async (stdin) => {
      stdin.write('endpoint');
      await flushAll();
    },
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

const PALETTE_FOCUS: FocusState = {
  stack: [
    { kind: 'main', key: 'chat' },
    { kind: 'popup', key: 'palette' },
  ],
};

const HELP_FOCUS: FocusState = {
  stack: [
    { kind: 'main', key: 'chat' },
    { kind: 'popup', key: 'help' },
  ],
};

const WORKER_SELECT_FOCUS: FocusState = {
  stack: [
    { kind: 'main', key: 'chat' },
    { kind: 'popup', key: 'worker-select' },
  ],
};

async function captureScenario(scenario: Scenario): Promise<CapturedFrame> {
  const rows = 28;
  const columns = 110;
  let result: ReturnType<typeof render>;
  if (scenario.kind === 'palette') {
    result = render(
      <Box flexDirection="column" height={rows} width={columns}>
        <ThemeProvider>
          <FocusProvider initial={PALETTE_FOCUS}>
            <KeybindProvider initialCommands={scenario.commands}>
              <Palette />
            </KeybindProvider>
          </FocusProvider>
        </ThemeProvider>
      </Box>,
    );
  } else if (scenario.kind === 'help') {
    result = render(
      <Box flexDirection="column" height={rows} width={columns}>
        <ThemeProvider>
          <FocusProvider initial={HELP_FOCUS}>
            <KeybindProvider initialCommands={scenario.commands}>
              <HelpOverlay />
            </KeybindProvider>
          </FocusProvider>
        </ThemeProvider>
      </Box>,
    );
  } else {
    result = render(
      <Box flexDirection="column" height={rows} width={columns}>
        <ThemeProvider>
          <FocusProvider initial={WORKER_SELECT_FOCUS}>
            <WorkerSelectionProvider>
              <KeybindProvider initialCommands={[]}>
                <WorkerSelector workers={scenario.workers} />
              </KeybindProvider>
            </WorkerSelectionProvider>
          </FocusProvider>
        </ThemeProvider>
      </Box>,
    );
  }

  await flushAll();
  if ('drive' in scenario && scenario.drive !== undefined) {
    await scenario.drive(result.stdin as unknown as { write: (s: string) => void });
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
    '# Phase 3F.1 visual frames',
    '',
    `Generated: ${new Date().toISOString()}`,
    '',
    'Each scenario renders one of the new 3F.1 popups under canonical states.',
    'Inspect `.plain.txt` for human-readable review; `.ansi.txt` keeps escapes for hex-code grep.',
    '',
    'Palette referenced (locked, unchanged from PLAN.md §3A):',
    '- `accent` (popup border, headers, matched chars, selected marker) → violet `#7C6FEB` → `\\x1b[38;2;124;111;235m`',
    '- `primary` (help group labels) → gold `#D4A843` → `\\x1b[38;2;212;168;67m`',
    '- `text` (command titles, worker rows) → light gray `#E0E0E0` → `\\x1b[38;2;224;224;224m`',
    '- `textMuted` (filter cursor, hints, scope badges, disabled reasons) → muted `#888888` → `\\x1b[38;2;136;136;136m`',
    '',
    'Keybind contracts:',
    '- Palette popup scope `palette`: Esc → close · Enter → invoke · ↑/↓ → nav · printable → filter · Backspace → trim',
    '- Help popup scope `help`: Esc → close',
    '- Worker selector popup scope `worker-select`: Esc → close · Enter → select · ↑/↓ → nav · printable → filter',
    '',
    '| Scenario | Description |',
    '|---|---|',
  ];

  for (const scenario of SCENARIOS) {
    process.stderr.write(`Capturing ${scenario.name}…\n`);
    const { ansi, plain } = await captureScenario(scenario);
    writeFileSync(path.join(OUT_DIR, `3f1-${scenario.name}.ansi.txt`), ansi, 'utf8');
    writeFileSync(
      path.join(OUT_DIR, `3f1-${scenario.name}.plain.txt`),
      `# ${scenario.name}\n# ${scenario.description}\n\n${plain}\n`,
      'utf8',
    );
    summary.push(`| \`${scenario.name}\` | ${scenario.description} |`);
  }

  writeFileSync(path.join(OUT_DIR, 'INDEX-3f1.md'), summary.join('\n') + '\n', 'utf8');
  process.stderr.write(`\n${SCENARIOS.length} frames written to ${OUT_DIR}\n`);
}

void main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
