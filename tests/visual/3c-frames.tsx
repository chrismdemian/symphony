/**
 * Phase 3C — visual frame harness.
 *
 * Captures the WorkerPanel under canonical states for skeptical-subagent
 * review. Mirrors the 3B.3 harness: ThemeProvider + FocusProvider +
 * KeybindProvider wrap a WorkerPanel; each scenario seeds a synthetic
 * `WorkerRecordSnapshot[]` plus initial focus/selection state, captures
 * the rendered frame, dumps `.ansi` (with escapes) + `.plain` (stripped)
 * + `INDEX-3c.md`.
 *
 * Output: `.visual-frames/3c-<state>.{ansi,plain}.txt`.
 */
import React from 'react';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { render } from 'ink-testing-library';
import { ThemeProvider } from '../../src/ui/theme/context.js';
import { FocusProvider, useFocus } from '../../src/ui/focus/focus.js';
import { KeybindProvider } from '../../src/ui/keybinds/dispatcher.js';
import { buildGlobalCommands } from '../../src/ui/keybinds/global.js';
import {
  WorkerSelectionProvider,
  useWorkerSelection,
} from '../../src/ui/data/WorkerSelection.js';
import { WorkerPanel } from '../../src/ui/panels/workers/WorkerPanel.js';
import type { WorkerRecordSnapshot } from '../../src/orchestrator/worker-registry.js';
import type { TuiRpc } from '../../src/ui/runtime/rpc.js';
import type { UseWorkersResult } from '../../src/ui/data/useWorkers.js';

const OUT_DIR = path.resolve(process.cwd(), '.visual-frames');

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
    createdAt: '2026-05-03T11:55:00.000Z',
    ...over,
  };
}

function makeFakeRpc(): TuiRpc {
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
        kill: async () => ({ killed: false }),
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

function makeWorkersResult(workers: readonly WorkerRecordSnapshot[]): UseWorkersResult {
  return {
    workers,
    loading: false,
    error: null,
    refresh: () => {},
  };
}

function flush(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface ScenarioContext {
  type: (bytes: string) => void;
  selectId: (id: string | null) => void;
}

interface Scenario {
  readonly name: string;
  readonly description: string;
  readonly workers: readonly WorkerRecordSnapshot[];
  readonly settleMs?: number;
  readonly build?: (ctx: ScenarioContext) => Promise<void>;
}

// Compute createdAt offsets relative to the real wall-clock at harness
// run time. The panel's runtime label uses Date.now() — using a frozen
// NOW would render `Nh Mm` instead of the intended `Nm`.
const NOW = Date.now();

function ageMinutes(min: number): string {
  return new Date(NOW - min * 60_000).toISOString();
}

const SCENARIOS: Scenario[] = [
  {
    name: '01-empty',
    description: 'No workers — empty-state hint visible.',
    workers: [],
  },
  {
    name: '02-single-running',
    description: 'One running worker in one project, no selection yet.',
    workers: [
      snap({
        id: 'w1',
        projectPath: 'C:/projects/alpha',
        featureIntent: 'wire up auth flow',
        status: 'running',
        model: 'claude-opus-4-7',
        createdAt: ageMinutes(3),
      }),
    ],
  },
  {
    name: '03-mixed-statuses',
    description:
      'Multiple workers in one project covering running / completed / failed / killed / timeout / spawning / crashed.',
    workers: [
      snap({
        id: 'r1',
        featureIntent: 'implement search bar',
        status: 'running',
        model: 'claude-opus-4-7',
        createdAt: ageMinutes(5),
      }),
      snap({
        id: 's1',
        featureIntent: 'review API surface',
        status: 'spawning',
        model: 'claude-sonnet-4-6',
        createdAt: ageMinutes(0),
      }),
      snap({
        id: 'c1',
        featureIntent: 'fix CSV export bug',
        status: 'completed',
        model: 'claude-sonnet-4-6',
        createdAt: ageMinutes(12),
      }),
      snap({
        id: 'f1',
        featureIntent: 'refactor settings panel',
        status: 'failed',
        model: 'claude-opus-4-7',
        createdAt: ageMinutes(20),
      }),
      snap({
        id: 'k1',
        featureIntent: 'unused experiment',
        status: 'killed',
        createdAt: ageMinutes(45),
      }),
      snap({
        id: 't1',
        featureIntent: 'long-running scan',
        status: 'timeout',
        createdAt: ageMinutes(125),
      }),
      snap({
        id: 'cr1',
        featureIntent: 'pre-orch crash',
        status: 'crashed',
        createdAt: ageMinutes(60),
      }),
    ],
  },
  {
    name: '04-multi-project',
    description: 'Three projects, mix of states; alpha / beta / gamma.',
    workers: [
      snap({
        id: 'a1',
        projectPath: 'C:/projects/alpha',
        featureIntent: 'alpha task one',
        status: 'running',
        model: 'claude-opus-4-7',
        createdAt: ageMinutes(2),
      }),
      snap({
        id: 'a2',
        projectPath: 'C:/projects/alpha',
        featureIntent: 'alpha task two',
        status: 'completed',
        model: 'claude-sonnet-4-6',
        createdAt: ageMinutes(15),
      }),
      snap({
        id: 'b1',
        projectPath: 'C:/projects/beta',
        featureIntent: 'beta migration',
        status: 'running',
        model: 'claude-opus-4-7',
        createdAt: ageMinutes(7),
      }),
      snap({
        id: 'g1',
        projectPath: 'C:/projects/gamma',
        featureIntent: 'gamma readme',
        status: 'failed',
        model: 'claude-haiku-4-5',
        createdAt: ageMinutes(30),
      }),
    ],
  },
  {
    name: '05-selected-worker',
    description: 'Single project, second worker selected.',
    workers: [
      snap({
        id: 'sel1',
        featureIntent: 'first',
        status: 'running',
        createdAt: ageMinutes(8),
      }),
      snap({
        id: 'sel2',
        featureIntent: 'second (selected)',
        status: 'running',
        createdAt: ageMinutes(4),
      }),
      snap({
        id: 'sel3',
        featureIntent: 'third',
        status: 'completed',
        createdAt: ageMinutes(20),
      }),
    ],
    build: async ({ selectId }) => {
      selectId('sel2');
      await flush();
    },
  },
  {
    name: '06-collapsed-group',
    description: 'Two projects with second one collapsed via Enter on its header.',
    workers: [
      snap({
        id: 'a1',
        projectPath: 'C:/projects/alpha',
        featureIntent: 'alpha task',
        status: 'running',
        createdAt: ageMinutes(2),
      }),
      snap({
        id: 'b1',
        projectPath: 'C:/projects/beta',
        featureIntent: 'beta task',
        status: 'running',
        createdAt: ageMinutes(3),
      }),
      snap({
        id: 'b2',
        projectPath: 'C:/projects/beta',
        featureIntent: 'beta other task',
        status: 'completed',
        createdAt: ageMinutes(10),
      }),
    ],
    build: async ({ type }) => {
      // Initial state: first worker (alpha's a1) is auto-selected by
      // reconcile. One `j` lands on beta's header. Enter collapses it.
      type('j');
      await flush();
      type('\r');
      await flush();
    },
  },
  {
    name: '07-many-workers-overflow',
    description: 'Ten workers in one project — exercises layout under length.',
    workers: Array.from({ length: 10 }, (_, i) =>
      snap({
        id: `m${i + 1}`,
        featureIntent: `task #${i + 1} — ${'detail '.repeat(2)}`,
        status: i < 4 ? 'running' : i < 7 ? 'completed' : 'failed',
        model: i % 2 === 0 ? 'claude-opus-4-7' : 'claude-sonnet-4-6',
        createdAt: ageMinutes(i * 3),
      }),
    ),
  },
];

function FocusForcer({ to }: { readonly to: 'workers' }): React.JSX.Element {
  const focus = useFocus();
  React.useEffect(() => {
    focus.setMain(to);
  }, [focus, to]);
  return <></>;
}

function SelectionExposer({
  onReady,
}: {
  readonly onReady: (selectId: (id: string | null) => void) => void;
}): React.JSX.Element {
  const sel = useWorkerSelection();
  React.useEffect(() => {
    onReady((id) => sel.setSelectedId(id));
  }, [sel, onReady]);
  return <></>;
}

async function captureScenario(scenario: Scenario): Promise<{ ansi: string; plain: string }> {
  let selectIdFn: ((id: string | null) => void) | null = null;
  const onSelectionReady = (fn: (id: string | null) => void): void => {
    selectIdFn = fn;
  };

  const commands = buildGlobalCommands({
    cycleFocus: () => {},
    cycleFocusReverse: () => {},
    requestExit: () => {},
    showHelp: () => {},
  });

  const tree = (
    <ThemeProvider>
      <FocusProvider>
        <FocusForcer to="workers" />
        <WorkerSelectionProvider>
          <SelectionExposer onReady={onSelectionReady} />
          <KeybindProvider initialCommands={commands}>
            <WorkerPanel rpc={makeFakeRpc()} workersResult={makeWorkersResult(scenario.workers)} />
          </KeybindProvider>
        </WorkerSelectionProvider>
      </FocusProvider>
    </ThemeProvider>
  );

  const result = render(tree);
  await flush();
  await flush();

  const stdin = (result as unknown as { stdin: { write: (s: string) => void } }).stdin;
  const ctx: ScenarioContext = {
    type: (bytes) => stdin.write(bytes),
    selectId: (id) => {
      if (selectIdFn !== null) selectIdFn(id);
    },
  };

  if (scenario.build !== undefined) {
    await scenario.build(ctx);
  }
  if (scenario.settleMs !== undefined) {
    await wait(scenario.settleMs);
  }
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
    '# Phase 3C visual frames',
    '',
    `Generated: ${new Date().toISOString()}`,
    '',
    'Each scenario renders the WorkerPanel under a 3C canonical state.',
    'Inspect `.plain.txt` for human-readable review;',
    '`.ansi.txt` keeps the color escapes (grep `\\x1b[38;2;…m` for hex codes).',
    '',
    'Palette under review:',
    '- violet `#7C6FEB` (workerRunning, accent, borderActive) → `\\x1b[38;2;124;111;235m`',
    '- gold `#D4A843` (workerDone) → `\\x1b[38;2;212;168;67m`',
    '- gold-light `#E5C07B` (warning, used for timeout) → `\\x1b[38;2;229;192;123m`',
    '- red `#E06C75` (workerFailed) → `\\x1b[38;2;224;108;117m`',
    '- text light gray `#E0E0E0` (text — used for instrument + feature-intent) → `\\x1b[38;2;224;224;224m`',
    '- muted gray `#888888` (textMuted — used for model + runtime + summary counts) → `\\x1b[38;2;136;136;136m`',
    '- selected row → `\\x1b[7m` (inverse) wraps ONLY the visible glyphs, never trailing padding',
    '',
    'Status icons to verify:',
    '- spawning / running → `●` violet, flashes `●`↔`○` at ~500ms',
    '- completed → `✓` gold (solid)',
    '- failed / crashed → `✗` red (solid)',
    '- killed → `⊘` muted gray (solid)',
    '- timeout → `⏱` warning amber (solid)',
    '',
    'Layout invariants:',
    '- group headers always visible (▾ open, ▸ collapsed)',
    '- collapsed group hides its workers but keeps the header line',
    '- empty state shows `no workers — Maestro will populate this when it spawns one`',
    '',
    '| Scenario | Description |',
    '|---|---|',
  ];

  for (const scenario of SCENARIOS) {
    process.stderr.write(`Capturing ${scenario.name}…\n`);
    const { ansi, plain } = await captureScenario(scenario);
    writeFileSync(path.join(OUT_DIR, `3c-${scenario.name}.ansi.txt`), ansi, 'utf8');
    writeFileSync(
      path.join(OUT_DIR, `3c-${scenario.name}.plain.txt`),
      `# ${scenario.name}\n# ${scenario.description}\n\n${plain}\n`,
      'utf8',
    );
    summary.push(`| \`${scenario.name}\` | ${scenario.description} |`);
  }

  writeFileSync(path.join(OUT_DIR, 'INDEX-3c.md'), summary.join('\n') + '\n', 'utf8');
  process.stderr.write(`\n${SCENARIOS.length} frames written to ${OUT_DIR}\n`);
}

void main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
