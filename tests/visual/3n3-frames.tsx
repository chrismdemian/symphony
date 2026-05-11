/**
 * Phase 3N.3 — visual frame harness for the StatsPanel popup.
 *
 * Captures the popup under canonical states for a SEPARATE
 * skeptical-subagent review:
 *   01: loading state (first poll in-flight)
 *   02: error state (RPC failed)
 *   03: no activity yet (zero session + empty byProject + empty byWorker)
 *   04: single project, single worker (typical first-run shape)
 *   05: multi-project breakdown (3 projects, mixed costs)
 *   06: long worker list (truncated with "… N more" footer)
 *   07: cache-heavy session (cache-row sub-line surfaces)
 *
 * Invariants under review:
 * - Header "Session statistics" in violet accent + bold
 * - Headline `Session: {tokens} tokens · ${cost} across N worker(s)`
 *   - tokens + cost in violet accent
 *   - labels + commas + "tokens" + "across" + count in muted-gray
 * - Cache row sub-line only when EITHER cacheReadTokens > 0 OR
 *   cacheWriteTokens > 0
 * - "By project" section header in violet accent + bold; rows show
 *   `  {projectName} · N worker(s) · {tokens} tokens · ${cost}`
 * - Empty byProject → `  (no billed activity yet)` in muted-gray
 * - "Recent workers" section header with `· last N` count
 * - First 12 rows shown; `… N more` footer when overflow
 * - Footer hint `Esc to close` in muted-gray
 */
import React from 'react';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { render } from 'ink-testing-library';
import { Box } from 'ink';
import { ThemeProvider } from '../../src/ui/theme/context.js';
import { FocusProvider } from '../../src/ui/focus/focus.js';
import { KeybindProvider } from '../../src/ui/keybinds/dispatcher.js';
import { StatsPanel } from '../../src/ui/panels/stats/StatsPanel.js';
import type {
  StatsByProjectRow,
  StatsByWorkerRow,
} from '../../src/rpc/router-impl.js';
import type { SessionTotals } from '../../src/orchestrator/session-totals.js';
import type { TuiRpc } from '../../src/ui/runtime/rpc.js';

const OUT_DIR = path.resolve(process.cwd(), '.visual-frames');

function flush(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}

function stripAnsi(input: string): string {
  // eslint-disable-next-line no-control-regex
  return input.replace(/\x1b\[[\d;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
}

interface FakeRpcShape {
  readonly session: () => Promise<SessionTotals>;
  readonly byProject: () => Promise<readonly StatsByProjectRow[]>;
  readonly byWorker: () => Promise<readonly StatsByWorkerRow[]>;
}

function makeRpc(shape: FakeRpcShape): TuiRpc {
  return {
    call: {
      stats: {
        session: shape.session,
        byProject: shape.byProject,
        byWorker: shape.byWorker,
      },
    },
  } as unknown as TuiRpc;
}

function workerRow(over: Partial<StatsByWorkerRow>): StatsByWorkerRow {
  return {
    workerId: 'wk-x',
    projectId: 'p1',
    projectName: 'MathScrabble',
    featureIntent: 'do-thing',
    role: 'implementer',
    status: 'completed',
    createdAt: '2026-05-11T12:00:00.000Z',
    completedAt: '2026-05-11T12:01:00.000Z',
    costUsd: 0.05,
    inputTokens: 1_200,
    outputTokens: 300,
    cacheReadTokens: 200,
    cacheWriteTokens: 50,
    ...over,
  };
}

interface Scenario {
  readonly name: string;
  readonly description: string;
  readonly rpc: TuiRpc;
}

const NEVER_RESOLVES: Promise<never> = new Promise(() => undefined);

const SCENARIOS: readonly Scenario[] = [
  {
    name: '01-loading',
    description:
      'First poll in-flight. Header shows "Session statistics · loading"; body empty until promises resolve.',
    rpc: makeRpc({
      session: () => NEVER_RESOLVES,
      byProject: () => NEVER_RESOLVES,
      byWorker: () => NEVER_RESOLVES,
    }),
  },
  {
    name: '02-error',
    description:
      'RPC rejected. Header shows error message in red token color. Sections still render their empty-state placeholders.',
    rpc: makeRpc({
      session: () => Promise.reject(new Error('rpc transport closed')),
      byProject: () => Promise.reject(new Error('rpc transport closed')),
      byWorker: () => Promise.reject(new Error('rpc transport closed')),
    }),
  },
  {
    name: '03-no-activity',
    description:
      'Zero session + empty byProject + empty byWorker. Three sections all render empty-state messages.',
    rpc: makeRpc({
      session: async () => ({
        totalTokens: 0,
        totalCostUsd: 0,
        workerCount: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      }),
      byProject: async () => [],
      byWorker: async () => [],
    }),
  },
  {
    name: '04-single-project-single-worker',
    description:
      'One project, one completed worker. Headline reads "Session: 1.5K tokens · $0.05 across 1 worker". By-project row + 1 worker row.',
    rpc: makeRpc({
      session: async () => ({
        totalTokens: 1_500,
        totalCostUsd: 0.05,
        workerCount: 1,
        cacheReadTokens: 200,
        cacheWriteTokens: 50,
      }),
      byProject: async () => [
        {
          projectId: 'p1',
          projectName: 'MathScrabble',
          workerCount: 1,
          totalTokens: 1_500,
          totalCostUsd: 0.05,
          cacheReadTokens: 200,
          cacheWriteTokens: 50,
        },
      ],
      byWorker: async () => [workerRow({})],
    }),
  },
  {
    name: '05-multi-project',
    description:
      'Three projects sorted by cost desc. Heaviest project first. Headline aggregates everything; rows show per-project breakdown.',
    rpc: makeRpc({
      session: async () => ({
        totalTokens: 245_000,
        totalCostUsd: 3.42,
        workerCount: 8,
        cacheReadTokens: 80_000,
        cacheWriteTokens: 5_000,
      }),
      byProject: async () => [
        {
          projectId: 'p1',
          projectName: 'symphony',
          workerCount: 5,
          totalTokens: 180_000,
          totalCostUsd: 2.21,
          cacheReadTokens: 60_000,
          cacheWriteTokens: 4_000,
        },
        {
          projectId: 'p2',
          projectName: 'MathScrabble',
          workerCount: 2,
          totalTokens: 50_000,
          totalCostUsd: 0.98,
          cacheReadTokens: 15_000,
          cacheWriteTokens: 800,
        },
        {
          projectId: null,
          projectName: '(unregistered)',
          workerCount: 1,
          totalTokens: 15_000,
          totalCostUsd: 0.23,
          cacheReadTokens: 5_000,
          cacheWriteTokens: 200,
        },
      ],
      byWorker: async () =>
        [
          workerRow({ workerId: 'wk-a', featureIntent: 'token-tracking', status: 'completed' }),
          workerRow({
            workerId: 'wk-b',
            featureIntent: 'audit-fix',
            projectName: 'MathScrabble',
            projectId: 'p2',
            status: 'completed',
            costUsd: 0.31,
          }),
          workerRow({
            workerId: 'wk-c',
            featureIntent: 'one-shot-eval',
            projectName: '(unregistered)',
            projectId: null,
            status: 'failed',
            costUsd: 0.23,
          }),
        ],
    }),
  },
  {
    name: '06-long-worker-list-truncated',
    description:
      '20 workers in the recent list. UI shows first 12 + "… 8 more" footer.',
    rpc: makeRpc({
      session: async () => ({
        totalTokens: 50_000,
        totalCostUsd: 1.5,
        workerCount: 20,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      }),
      byProject: async () => [
        {
          projectId: 'p1',
          projectName: 'symphony',
          workerCount: 20,
          totalTokens: 50_000,
          totalCostUsd: 1.5,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      ],
      byWorker: async () =>
        Array.from({ length: 20 }, (_, i) =>
          workerRow({
            workerId: `wk-${i}`,
            featureIntent: `task-${i}`,
            status: i % 5 === 0 ? 'failed' : 'completed',
            costUsd: 0.05 + i * 0.005,
            inputTokens: 1_000 + i * 100,
            outputTokens: 200 + i * 20,
          }),
        ),
    }),
  },
  {
    name: '08-mixed-status-glyphs',
    description:
      'Recent workers section exercises every status glyph + color tier: ✓ completed (accent), ● running (accent), ◌ spawning (muted), ✗ failed (error/red), ⊘ killed (warning/gold). Audit 3N.3 M1: glyph color must match the locked palette tier per status.',
    rpc: makeRpc({
      session: async () => ({
        totalTokens: 8_000,
        totalCostUsd: 0.18,
        workerCount: 5,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      }),
      byProject: async () => [
        {
          projectId: 'p1',
          projectName: 'symphony',
          workerCount: 5,
          totalTokens: 8_000,
          totalCostUsd: 0.18,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      ],
      byWorker: async () => [
        workerRow({
          workerId: 'wk-ok',
          featureIntent: 'completed-task',
          status: 'completed',
          costUsd: 0.05,
          inputTokens: 1_500,
          outputTokens: 200,
        }),
        workerRow({
          workerId: 'wk-run',
          featureIntent: 'running-task',
          status: 'running',
          costUsd: 0.04,
          inputTokens: 1_200,
          outputTokens: 150,
        }),
        workerRow({
          workerId: 'wk-spawn',
          featureIntent: 'spawning-task',
          status: 'spawning',
          costUsd: null as unknown as number,
          inputTokens: null as unknown as number,
          outputTokens: null as unknown as number,
        }),
        workerRow({
          workerId: 'wk-fail',
          featureIntent: 'failed-task',
          status: 'failed',
          costUsd: 0.06,
          inputTokens: 1_800,
          outputTokens: 250,
        }),
        workerRow({
          workerId: 'wk-kill',
          featureIntent: 'killed-task',
          status: 'killed',
          costUsd: 0.03,
          inputTokens: 800,
          outputTokens: 100,
        }),
        workerRow({
          workerId: 'wk-timeout',
          featureIntent: 'timeout-task',
          status: 'timeout',
          costUsd: 0.07,
          inputTokens: 2_100,
          outputTokens: 300,
        }),
      ],
    }),
  },
  {
    name: '07-cache-heavy',
    description:
      'Session with substantial cache reads (matters for Max-plan effective volume but bills at 10% on API). Cache sub-line surfaces under headline.',
    rpc: makeRpc({
      session: async () => ({
        totalTokens: 90_000,
        totalCostUsd: 0.27,
        workerCount: 3,
        cacheReadTokens: 450_000,
        cacheWriteTokens: 12_000,
      }),
      byProject: async () => [
        {
          projectId: 'p1',
          projectName: 'symphony',
          workerCount: 3,
          totalTokens: 90_000,
          totalCostUsd: 0.27,
          cacheReadTokens: 450_000,
          cacheWriteTokens: 12_000,
        },
      ],
      byWorker: async () => [
        workerRow({ workerId: 'wk-cache', cacheReadTokens: 450_000, cacheWriteTokens: 12_000 }),
      ],
    }),
  },
];

async function capture(rpc: TuiRpc): Promise<{ ansi: string; plain: string }> {
  // Force the StatsPanel into its "popup focused" scope. The component
  // reads `useFocus().currentScope === 'stats'` and only renders fully
  // when that's true. We wrap with FocusProvider + an initial stack that
  // pushes 'stats' — same pattern other phase-3 visual harnesses use.
  const tree = (
    <Box flexDirection="column" width={120} height={28}>
      <ThemeProvider>
        <FocusProvider
          initial={{
            stack: [
              { kind: 'main', key: 'chat' },
              { kind: 'popup', key: 'stats' },
            ],
          }}
        >
          <KeybindProvider initialCommands={[]}>
            <StatsPanel rpc={rpc} />
          </KeybindProvider>
        </FocusProvider>
      </ThemeProvider>
    </Box>
  );
  const result = render(tree);
  // Allow several microtasks so the Promise.all in the panel resolves.
  for (let i = 0; i < 5; i += 1) await flush();
  await new Promise((r) => setTimeout(r, 50));
  const ansi = result.lastFrame() ?? '';
  const plain = stripAnsi(ansi);
  result.unmount();
  return { ansi, plain };
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  const summary: string[] = [
    '# Phase 3N.3 visual frames — `/stats` popup',
    '',
    `Generated: ${new Date().toISOString()}`,
    '',
    'StatsPanel rendered under canonical states. Inspect `.plain.txt` for',
    'human review; `.ansi.txt` keeps the color escapes for hex-grep.',
    '',
    'Locked palette under review:',
    '- violet `#7C6FEB` (accent — section headers + values) → `\\x1b[38;2;124;111;235m`',
    '- text   `#E0E0E0` (project names + feature intent) → `\\x1b[38;2;224;224;224m`',
    '- muted  `#888888` (labels + separators + secondary) → `\\x1b[38;2;136;136;136m`',
    '- red    `#E06C75` (error messages) → `\\x1b[38;2;224;108;117m`',
    '',
    'Invariants:',
    '- Header "Session statistics" bold + accent',
    '- Section headers "By project" / "Recent workers" bold + accent',
    '- Token + cost values in accent; labels in muted',
    '- Cache sub-line ONLY when cacheReadTokens > 0 OR cacheWriteTokens > 0',
    '- Empty byProject → "  (no billed activity yet)" in muted',
    '- Empty byWorker → "  (no workers tracked)" in muted',
    '- Recent workers truncated to first 12; "… N more" footer when overflow',
    '- Footer "Esc to close" in muted',
    '',
    '| Scenario | Description |',
    '|---|---|',
  ];

  for (const scenario of SCENARIOS) {
    process.stderr.write(`Capturing ${scenario.name}…\n`);
    const { ansi, plain } = await capture(scenario.rpc);
    writeFileSync(path.join(OUT_DIR, `3n3-${scenario.name}.ansi.txt`), ansi, 'utf8');
    writeFileSync(
      path.join(OUT_DIR, `3n3-${scenario.name}.plain.txt`),
      `# ${scenario.name}\n# ${scenario.description}\n\n${plain}\n`,
      'utf8',
    );
    summary.push(`| \`${scenario.name}\` | ${scenario.description} |`);
  }

  writeFileSync(path.join(OUT_DIR, 'INDEX-3n3.md'), summary.join('\n') + '\n', 'utf8');
  process.stderr.write(`\n${SCENARIOS.length} frames written to ${OUT_DIR}\n`);
}

void main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
