/**
 * Phase 3I — visual frame harness for the worker pipeline progress bar.
 *
 * Captures the WorkerPanel under canonical pipeline-progress states for
 * a SEPARATE skeptical-subagent review. Mirrors the 3C harness shape.
 *
 * Output: `.visual-frames/3i-<state>.{ansi,plain}.txt` + `INDEX-3i.md`.
 *
 * Locked palette under review:
 *   - violet `#7C6FEB` → `\x1b[38;2;124;111;235m` (running pipeline cell)
 *   - gold `#D4A843`   → `\x1b[38;2;212;168;67m` (completed prior + completed current)
 *   - red `#E06C75`    → `\x1b[38;2;224;108;117m` (failed/crashed/timeout current)
 *   - muted `#888888`  → `\x1b[38;2;136;136;136m` (future + killed-paused)
 *   - text `#E0E0E0`   → `\x1b[38;2;224;224;224m` (instrument + label + intent)
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

interface ScenarioContext {
  selectId: (id: string | null) => void;
}

interface Scenario {
  readonly name: string;
  readonly description: string;
  readonly workers: readonly WorkerRecordSnapshot[];
  readonly build?: (ctx: ScenarioContext) => Promise<void>;
}

const NOW = Date.now();

function ageMinutes(min: number): string {
  return new Date(NOW - min * 60_000).toISOString();
}

const SCENARIOS: Scenario[] = [
  {
    name: '01-all-stages-running',
    description:
      'One worker per stage, all running. Demonstrates left-to-right gold→violet→muted progression as stage advances.',
    workers: [
      snap({
        id: 'rs1',
        role: 'researcher',
        featureIntent: 'survey embedding libs',
        status: 'running',
        model: 'claude-opus-4-7',
        createdAt: ageMinutes(2),
      }),
      snap({
        id: 'pl1',
        role: 'planner',
        featureIntent: 'plan auth refactor',
        status: 'running',
        model: 'claude-opus-4-7',
        createdAt: ageMinutes(4),
      }),
      snap({
        id: 'im1',
        role: 'implementer',
        featureIntent: 'wire OAuth callback',
        status: 'running',
        model: 'claude-sonnet-4-6',
        createdAt: ageMinutes(6),
      }),
      snap({
        id: 'db1',
        role: 'debugger',
        featureIntent: 'flaky integration test',
        status: 'running',
        model: 'claude-sonnet-4-6',
        createdAt: ageMinutes(8),
      }),
      snap({
        id: 'rv1',
        role: 'reviewer',
        featureIntent: 'final review pre-merge',
        status: 'running',
        model: 'claude-opus-4-7',
        createdAt: ageMinutes(11),
      }),
    ],
  },
  {
    name: '02-all-stages-completed',
    description:
      'One worker per stage, all completed. Each bar shows gold for cells up to and including the worker\'s own stage; cells AFTER stay muted (bar appears fully gold only for a completed reviewer at stage 4).',
    workers: [
      snap({
        id: 'rs2',
        role: 'researcher',
        featureIntent: 'embedding survey done',
        status: 'completed',
        model: 'claude-opus-4-7',
        createdAt: ageMinutes(20),
      }),
      snap({
        id: 'pl2',
        role: 'planner',
        featureIntent: 'auth plan ready',
        status: 'completed',
        model: 'claude-opus-4-7',
        createdAt: ageMinutes(25),
      }),
      snap({
        id: 'im2',
        role: 'implementer',
        featureIntent: 'OAuth wired',
        status: 'completed',
        model: 'claude-sonnet-4-6',
        createdAt: ageMinutes(30),
      }),
      snap({
        id: 'db2',
        role: 'debugger',
        featureIntent: 'flake fixed',
        status: 'completed',
        model: 'claude-sonnet-4-6',
        createdAt: ageMinutes(35),
      }),
      snap({
        id: 'rv2',
        role: 'reviewer',
        featureIntent: 'review approved',
        status: 'completed',
        model: 'claude-opus-4-7',
        createdAt: ageMinutes(40),
      }),
    ],
  },
  {
    name: '03-failed-mid-task',
    description:
      'Failed planner: bar = 1 gold + 1 red + 3 muted. The current-stage cell signals the breakage point.',
    workers: [
      snap({
        id: 'pf1',
        role: 'planner',
        featureIntent: 'plan checkout flow',
        status: 'failed',
        model: 'claude-opus-4-7',
        createdAt: ageMinutes(15),
      }),
    ],
  },
  {
    name: '04-killed-mid-task',
    description:
      'Killed implementer: bar = 2 gold + 1 paused-gray + 2 muted. The killed cell collapses with the future cells into a single muted run.',
    workers: [
      snap({
        id: 'kk1',
        role: 'implementer',
        featureIntent: 'experimental refactor',
        status: 'killed',
        model: 'claude-opus-4-7',
        createdAt: ageMinutes(20),
      }),
    ],
  },
  {
    name: '05-mixed-pipeline',
    description:
      'Three workers in one project across three stages: researcher running, implementer running, reviewer completed. Shows what a real-world group looks like.',
    workers: [
      snap({
        id: 'mx1',
        role: 'researcher',
        featureIntent: 'survey caching options',
        status: 'running',
        model: 'claude-opus-4-7',
        createdAt: ageMinutes(2),
      }),
      snap({
        id: 'mx2',
        role: 'implementer',
        featureIntent: 'add LRU cache',
        status: 'running',
        model: 'claude-sonnet-4-6',
        createdAt: ageMinutes(7),
      }),
      snap({
        id: 'mx3',
        role: 'reviewer',
        featureIntent: 'review caching change',
        status: 'completed',
        model: 'claude-opus-4-7',
        createdAt: ageMinutes(15),
      }),
    ],
  },
  {
    name: '06-selected-row-no-bleed',
    description:
      'Same as mixed-pipeline but with the middle row selected. Verifies the inverse highlight wraps ONLY the instrument glyphs — bar + label render in their normal colors with no inverse bleed.',
    workers: [
      snap({
        id: 'sx1',
        role: 'researcher',
        featureIntent: 'survey caching options',
        status: 'running',
        model: 'claude-opus-4-7',
        createdAt: ageMinutes(2),
      }),
      snap({
        id: 'sx2',
        role: 'implementer',
        featureIntent: 'add LRU cache',
        status: 'running',
        model: 'claude-sonnet-4-6',
        createdAt: ageMinutes(7),
      }),
      snap({
        id: 'sx3',
        role: 'reviewer',
        featureIntent: 'review caching change',
        status: 'completed',
        model: 'claude-opus-4-7',
        createdAt: ageMinutes(15),
      }),
    ],
    build: async ({ selectId }) => {
      selectId('sx2');
      await flush();
    },
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

  const ctx: ScenarioContext = {
    selectId: (id) => {
      if (selectIdFn !== null) selectIdFn(id);
    },
  };

  if (scenario.build !== undefined) {
    await scenario.build(ctx);
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
    '# Phase 3I visual frames — Worker Pipeline Progress',
    '',
    `Generated: ${new Date().toISOString()}`,
    '',
    'Each scenario renders the WorkerPanel with the new 5-cell pipeline bar + gerund stage label.',
    'Inspect `.plain.txt` for human-readable review;',
    '`.ansi.txt` keeps the color escapes (grep `\\x1b[38;2;…m` for hex codes).',
    '',
    'Locked palette under review:',
    '- violet `#7C6FEB` (current pipeline cell, accent) → `\\x1b[38;2;124;111;235m`',
    '- gold `#D4A843` (completed pipeline cells, workerDone) → `\\x1b[38;2;212;168;67m`',
    '- red `#E06C75` (failed/crashed/timeout current cell) → `\\x1b[38;2;224;108;117m`',
    '- muted gray `#888888` (future cells, killed-paused, model+runtime metadata) → `\\x1b[38;2;136;136;136m`',
    '- text light gray `#E0E0E0` (instrument + stage label + feature intent) → `\\x1b[38;2;224;224;224m`',
    '- selected row inverse → `\\x1b[7m` wraps ONLY the instrument glyphs, never the bar or label',
    '',
    'Pipeline stage map:',
    '- researcher → cell 0 / "Researching"',
    '- planner    → cell 1 / "Planning"',
    '- implementer → cell 2 / "Implementing"',
    '- debugger   → cell 3 / "Debugging" (Test slot)',
    '- reviewer   → cell 4 / "Reviewing"',
    '',
    'Cell coloring rules:',
    '- cells BEFORE this worker\'s stage → gold',
    '- cell AT this worker\'s stage:',
    '    - spawning / running → violet (current)',
    '    - completed → gold (collapses with prior cells; the bar appears FULLY gold only when stageIndex == 4 / reviewer)',
    '    - failed / crashed / timeout → red',
    '    - killed → muted gray (paused; collapses with future cells into one muted SGR run)',
    '- cells AFTER this worker\'s stage → muted gray',
    '',
    'Layout invariants to verify:',
    '- bar (5 cells) sits between the instrument padding and the gerund label',
    '- gerund label is left-padded to 12 chars so the right column stays aligned',
    '- selected-row inverse highlight does NOT bleed onto the bar or the label',
    '',
    '| Scenario | Description |',
    '|---|---|',
  ];

  for (const scenario of SCENARIOS) {
    process.stderr.write(`Capturing ${scenario.name}…\n`);
    const { ansi, plain } = await captureScenario(scenario);
    writeFileSync(path.join(OUT_DIR, `3i-${scenario.name}.ansi.txt`), ansi, 'utf8');
    writeFileSync(
      path.join(OUT_DIR, `3i-${scenario.name}.plain.txt`),
      `# ${scenario.name}\n# ${scenario.description}\n\n${plain}\n`,
      'utf8',
    );
    summary.push(`| \`${scenario.name}\` | ${scenario.description} |`);
  }

  writeFileSync(path.join(OUT_DIR, 'INDEX-3i.md'), summary.join('\n') + '\n', 'utf8');
  process.stderr.write(`\n${SCENARIOS.length} frames written to ${OUT_DIR}\n`);
}

void main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
