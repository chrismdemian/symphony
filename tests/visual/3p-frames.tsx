/**
 * Phase 3P — visual frame harness for cross-project task dependencies.
 *
 * Two surfaces exercised:
 *   1. The `<DepsPanel>` popup under canonical graph states (empty,
 *      simple chain, fan-out, cross-project, fan-in, cycle banner).
 *   2. The chat panel `<Bubble>` (system kind) rendering a `task_ready`
 *      event mapped to `statusKind='completed'` (✓ success-gold).
 *
 * Output: `.visual-frames/3p-<state>.{ansi,plain}.txt` + `INDEX-3p.md`.
 *
 * Locked palette (CLAUDE.md):
 *   - success-gold `#D4A843` (✓ completed)    → `\x1b[38;2;212;168;67m`
 *   - violet/accent `#7C6FEB` (◷ pending-ready, ● in_progress)
 *     → `\x1b[38;2;124;111;235m`
 *   - error-red    `#E06C75` (✗ failed + cycle banner)
 *     → `\x1b[38;2;224;108;117m`
 *   - text light   `#E0E0E0` (descriptions)   → `\x1b[38;2;224;224;224m`
 *   - muted gray   `#888888` (deps-on line, blocked ◷)
 *     → `\x1b[38;2;136;136;136m`
 *
 * Reviewer scope (separate skeptical subagent):
 *   - Glyph mapping: ✓ completed (gold), ● in_progress (violet),
 *     ◷ pending-ready (violet), ◷ pending-blocked (muted), ✗ failed (red).
 *   - Per-project group header uses accent + bold; node count annotation
 *     is muted "· N tasks".
 *   - Description text uses text-light; "depends on: …" sub-row uses
 *     muted-gray.
 *   - Cycle banner (when present) is red + bold "⚠ Dependency cycle
 *     detected (N):" followed by red lines `id → id → id`.
 *   - Bubble system row for task_ready uses ✓ gold (mapped to completed),
 *     headline reads "Task ready: <desc> (<proj>) — <unblockedBy> completed".
 */
import React from 'react';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { render } from 'ink-testing-library';
import { Box } from 'ink';
import { ThemeProvider } from '../../src/ui/theme/context.js';
import { FocusProvider, type FocusState } from '../../src/ui/focus/focus.js';
import { KeybindProvider } from '../../src/ui/keybinds/dispatcher.js';
import { ToastProvider } from '../../src/ui/feedback/ToastProvider.js';
import { DepsPanel } from '../../src/ui/panels/deps/DepsPanel.js';
import { Bubble } from '../../src/ui/panels/chat/Bubble.js';
import type { TuiRpc } from '../../src/ui/runtime/rpc.js';
import type { ProjectSnapshot } from '../../src/projects/types.js';
import type { TaskSnapshot } from '../../src/state/types.js';
import type { TaskGraph } from '../../src/orchestrator/task-deps.js';
import type { SystemTurn } from '../../src/ui/data/chatHistoryReducer.js';

const OUT_DIR = path.resolve(process.cwd(), '.visual-frames');
const ISO = '2026-05-13T00:00:00.000Z';

interface Scenario {
  readonly name: string;
  readonly description: string;
  readonly element: React.ReactElement;
}

function snap(
  id: string,
  projectId: string,
  description: string,
  status: TaskSnapshot['status'],
  dependsOn: readonly string[] = [],
): TaskSnapshot {
  return {
    id,
    projectId,
    description,
    status,
    priority: 0,
    dependsOn,
    notes: [],
    createdAt: ISO,
    updatedAt: ISO,
    ...(status === 'completed' ? { completedAt: ISO } : {}),
  };
}

function project(id: string, name: string): ProjectSnapshot {
  return {
    id,
    name,
    path: `/tmp/${id}`,
    createdAt: ISO,
  };
}

function makeStubRpc(graph: TaskGraph, projects: readonly ProjectSnapshot[]): TuiRpc {
  // Minimal stub — only the two procedures DepsPanel calls. Everything
  // else throws if the harness somehow reaches into it. Mirrors the
  // shape used by the 3o1 / 3n.3 visual harnesses.
  const tasks = {
    graph: async (): Promise<TaskGraph> => graph,
  };
  const projectsCall = {
    list: async (): Promise<readonly ProjectSnapshot[]> => projects,
  };
  const rpc = {
    call: {
      tasks,
      projects: projectsCall,
    },
    subscribe: async () => ({
      unsubscribe: async () => {},
    }),
  } as unknown as TuiRpc;
  return rpc;
}

function DepsHarness({
  graph,
  projects,
}: {
  graph: TaskGraph;
  projects: readonly ProjectSnapshot[];
}): React.JSX.Element {
  const initialFocus: FocusState = {
    stack: [
      { kind: 'main', key: 'chat' },
      { kind: 'popup', key: 'deps' },
    ],
  };
  const rpc = makeStubRpc(graph, projects);
  return (
    <ThemeProvider>
      <ToastProvider>
        <FocusProvider initial={initialFocus}>
          <KeybindProvider initialCommands={[]}>
            <Box width={90} height={26}>
              <DepsPanel rpc={rpc} />
            </Box>
          </KeybindProvider>
        </FocusProvider>
      </ToastProvider>
    </ThemeProvider>
  );
}

function BubbleHarness({ turn }: { turn: SystemTurn }): React.JSX.Element {
  return (
    <ThemeProvider>
      <Box flexDirection="column" width={90}>
        <Bubble turn={turn} />
      </Box>
    </ThemeProvider>
  );
}

function makeTaskReadyTurn(headline: string): SystemTurn {
  return {
    kind: 'system',
    id: 'system-0',
    summary: {
      workerId: 'task-ready-tk-b',
      workerName: 'Symphony',
      projectName: 'Frontend',
      statusKind: 'completed',
      durationMs: null,
      headline,
      fallback: false,
    },
    ts: 0,
  };
}

// Build the scenarios.
const PROJECTS_TWO: readonly ProjectSnapshot[] = [
  project('p1', 'CRE Pipeline'),
  project('p2', 'Frontend'),
];

function makeChainGraph(): TaskGraph {
  // A → B → C, A completed, B pending-ready, C pending-blocked.
  const a = snap('tk-aaaa1111', 'p1', 'Build API endpoint', 'completed');
  const b = snap('tk-bbbb2222', 'p1', 'Add filters middleware', 'pending', [a.id]);
  const c = snap('tk-cccc3333', 'p1', 'Wire chart rendering', 'pending', [b.id]);
  return {
    nodes: [a, b, c],
    edges: [
      { from: b.id, to: a.id },
      { from: c.id, to: b.id },
    ],
    cycles: [],
  };
}

function makeFanOutGraph(): TaskGraph {
  // A completed → {B, C, D} pending-ready (cross-project mix).
  const a = snap('tk-aaaa1111', 'p1', 'API endpoint live', 'completed');
  const b = snap('tk-bbbb2222', 'p2', 'Frontend filter UI', 'pending', [a.id]);
  const c = snap('tk-cccc3333', 'p2', 'Frontend charts', 'pending', [a.id]);
  const d = snap('tk-dddd4444', 'p1', 'API monitoring dashboard', 'pending', [a.id]);
  return {
    nodes: [a, b, c, d],
    edges: [
      { from: b.id, to: a.id },
      { from: c.id, to: a.id },
      { from: d.id, to: a.id },
    ],
    cycles: [],
  };
}

function makeFanInGraph(): TaskGraph {
  // B blocked on {A, X, Y}: A done, X in_progress, Y pending → B blocked.
  const a = snap('tk-aaaa1111', 'p1', 'A: schema migration', 'completed');
  const x = snap('tk-xxxx2222', 'p1', 'X: backfill job', 'in_progress');
  const y = snap('tk-yyyy3333', 'p1', 'Y: index build', 'pending');
  const b = snap('tk-bbbb4444', 'p2', 'B: roll out feature', 'pending', [a.id, x.id, y.id]);
  return {
    nodes: [a, x, y, b],
    edges: [
      { from: b.id, to: a.id },
      { from: b.id, to: x.id },
      { from: b.id, to: y.id },
    ],
    cycles: [],
  };
}

function makeCrossProjectGraph(): TaskGraph {
  // P1.A → P2.B: A completed, B pending-ready.
  const a = snap('tk-aaaa1111', 'p1', 'Pipeline API: filter endpoint', 'completed');
  const b = snap('tk-bbbb2222', 'p2', 'Frontend filters wired to API', 'pending', [a.id]);
  return {
    nodes: [a, b],
    edges: [{ from: b.id, to: a.id }],
    cycles: [],
  };
}

function makeCycleGraph(): TaskGraph {
  // Defensive: a hand-edited DB introduces A→B→A cycle.
  const a = snap('tk-aaaa1111', 'p1', 'A', 'pending', ['tk-bbbb2222']);
  const b = snap('tk-bbbb2222', 'p1', 'B', 'pending', ['tk-aaaa1111']);
  return {
    nodes: [a, b],
    edges: [
      { from: a.id, to: b.id },
      { from: b.id, to: a.id },
    ],
    cycles: [['tk-aaaa1111', 'tk-bbbb2222', 'tk-aaaa1111']],
  };
}

const SCENARIOS: Scenario[] = [
  {
    name: '01-deps-empty',
    description:
      'DepsPanel with zero graph nodes. Shows the empty-state hint ("No task dependencies yet…").',
    element: (
      <DepsHarness
        graph={{ nodes: [], edges: [], cycles: [] }}
        projects={PROJECTS_TWO}
      />
    ),
  },
  {
    name: '02-deps-chain-a-done',
    description:
      'Chain A→B→C inside one project. A completed (gold ✓), B pending-ready (violet ◷), C pending-blocked (muted ◷). Verifies the ready-vs-blocked distinction within pending status.',
    element: <DepsHarness graph={makeChainGraph()} projects={PROJECTS_TWO} />,
  },
  {
    name: '03-deps-fan-out-cross-project',
    description:
      'A (CRE Pipeline) completed → {B, C, D}. B and C live in Frontend project; D lives in CRE Pipeline. Verifies grouped-by-project rendering and that dependents in different projects all show as ready (violet ◷).',
    element: <DepsHarness graph={makeFanOutGraph()} projects={PROJECTS_TWO} />,
  },
  {
    name: '04-deps-fan-in-mixed-status',
    description:
      'B depends on {A (completed), X (in_progress), Y (pending)}. Glyphs differ: ✓ gold for A, ● violet for X, ◷ muted for Y (blocked because A is the only completed). B itself is muted ◷ (multiple unmet deps).',
    element: <DepsHarness graph={makeFanInGraph()} projects={PROJECTS_TWO} />,
  },
  {
    name: '05-deps-cross-project-two-line',
    description:
      'Single cross-project edge: CRE Pipeline.A → Frontend.B. A completed; B ready. Verifies the per-project grouping shows both project headers and the deps-on line references the source id.',
    element: <DepsHarness graph={makeCrossProjectGraph()} projects={PROJECTS_TWO} />,
  },
  {
    name: '06-deps-cycle-banner',
    description:
      'Defensive cycle case: graph has A→B→A. Red ⚠ banner reads "⚠ Dependency cycle detected (1):" with the cycle path "tk-aaaa1 → tk-bbbb2 → tk-aaaa1" (8-char short ids matching body rows) in red below.',
    element: <DepsHarness graph={makeCycleGraph()} projects={PROJECTS_TWO} />,
  },
  {
    name: '07-chat-task-ready-same-project',
    description:
      'Chat system row for a task_ready event (mapped to statusKind=completed → gold ✓ glyph). Headline reads "Task ready: <desc> (<proj>) — <unblockedBy> completed".',
    element: (
      <BubbleHarness
        turn={makeTaskReadyTurn(
          'Task ready: Add filters middleware (CRE Pipeline) — Build API endpoint completed',
        )}
      />
    ),
  },
  {
    name: '08-chat-task-ready-cross-project',
    description:
      'Chat system row for a cross-project task_ready event. Headline mentions both project names so the user sees the dependency span at a glance: "Frontend filters wired to API (Frontend) — Pipeline API: filter endpoint (CRE Pipeline) completed".',
    element: (
      <BubbleHarness
        turn={makeTaskReadyTurn(
          'Task ready: Frontend filters wired to API (Frontend) — Pipeline API: filter endpoint (CRE Pipeline) completed',
        )}
      />
    ),
  },
];

async function captureScenario(scenario: Scenario): Promise<{ ansi: string; plain: string }> {
  const result = render(scenario.element);
  // Let the DepsPanel's mount-effect run its first fetch + commit.
  // Need a microtask drain (for the inner Promise.all in the useEffect)
  // plus a macrotask hop so the post-fetch setState commits.
  for (let i = 0; i < 8; i += 1) {
    await new Promise((r) => setImmediate(r));
  }
  await new Promise((r) => setTimeout(r, 0));
  for (let i = 0; i < 8; i += 1) {
    await new Promise((r) => setImmediate(r));
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
    '# Phase 3P visual frames — Cross-Project Task Dependencies',
    '',
    `Generated: ${new Date().toISOString()}`,
    '',
    'Each scenario renders a single surface (DepsPanel popup OR chat-panel ',
    'system Bubble for `task_ready` events) under canonical states for ',
    'the skeptical-subagent review. Inspect `.plain.txt` for human ',
    'review; `.ansi.txt` keeps the color escapes (grep `\\x1b[38;2;…m` ',
    'for hex codes).',
    '',
    'Locked palette under review (CLAUDE.md §Symphony palette):',
    '- success-gold `#D4A843` (✓ completed) → `\\x1b[38;2;212;168;67m`',
    '- violet/accent `#7C6FEB` (◷ pending-ready, ● in_progress) → `\\x1b[38;2;124;111;235m`',
    '- error-red    `#E06C75` (✗ failed, cycle banner) → `\\x1b[38;2;224;108;117m`',
    '- text light   `#E0E0E0` (descriptions, body) → `\\x1b[38;2;224;224;224m`',
    '- muted gray   `#888888` (◷ pending-blocked, "depends on:" line) → `\\x1b[38;2;136;136;136m`',
    '',
    'Glyph mapping (DepsPanel.statusGlyphFor):',
    '- `completed`              → ✓ (success-gold)',
    '- `in_progress`            → ● (violet/accent)',
    '- `pending` + ready=true   → ◷ (violet/accent)',
    '- `pending` + ready=false  → ◷ (muted gray) — same glyph, different color',
    '- `failed`                 → ✗ (error-red)',
    '- `cancelled`              → ⊘ (muted gray)',
    '',
    'task_ready → SystemSummary mapping (drives Bubble glyph + color):',
    '- `task_ready` → `completed` (✓ success-gold)',
    '',
    'DepsPanel invariants to verify:',
    '- title "Task dependencies" in accent (violet/`#7C6FEB`), bold',
    '- per-project group header: project name in accent (violet), bold; node count in muted-gray',
    '- deps-on sub-row indented 6 spaces, prefixed `depends on:`, muted-gray text',
    '- short ids (8 chars) preserve project context without overflowing — BOTH in body rows AND in cycle-banner paths',
    '- cycle banner only present when cycles.length > 0; never empty',
    '- footer reads "Esc to close" in muted-gray',
    '',
    'Bubble (chat row) invariants to verify:',
    '- header: ✓ + workerName in success-gold, bold',
    '- project parens + duration token in muted-gray',
    '- headline indented 2 spaces, text-light',
    '- multi-project headline names both projects clearly',
    '- NO bordered bubble (matches 3K + 3O.1)',
    '',
    '| Scenario | Description |',
    '|---|---|',
  ];

  for (const scenario of SCENARIOS) {
    process.stderr.write(`Capturing ${scenario.name}…\n`);
    const { ansi, plain } = await captureScenario(scenario);
    writeFileSync(path.join(OUT_DIR, `3p-${scenario.name}.ansi.txt`), ansi, 'utf8');
    writeFileSync(
      path.join(OUT_DIR, `3p-${scenario.name}.plain.txt`),
      `# ${scenario.name}\n# ${scenario.description}\n\n${plain}\n`,
      'utf8',
    );
    summary.push(`| \`${scenario.name}\` | ${scenario.description} |`);
  }

  writeFileSync(path.join(OUT_DIR, 'INDEX-3p.md'), summary.join('\n') + '\n', 'utf8');
  process.stderr.write(`\n${SCENARIOS.length} frames written to ${OUT_DIR}\n`);
}

void main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
