/**
 * Phase 3N.2 — visual frame harness for the status-bar session-totals
 * segment.
 *
 * Captures the StatusBar under canonical states for a SEPARATE
 * skeptical-subagent review:
 *   01: sessionTotals undefined          → segment absent (back-compat)
 *   02: sessionTotals zeroed             → segment absent (splash)
 *   03: small token count + sub-cent     → "↑ 234 · $0.0042"
 *   04: K-range tokens                   → "↑ 47K · $0.12"
 *   05: M-range tokens + multi-dollar    → "↑ 1.4M · $4.25"
 *   06: token-only (cost === 0)          → "↑ 5.2K · $0.00"
 *   07: cost-only (tokens === 0)         → "↑ 0 · $0.07"
 *   08: combined with awayMode + Q       → segment co-exists with Away segment
 *
 * Output: `.visual-frames/3n2-<state>.{ansi,plain}.txt` + `INDEX-3n2.md`.
 *
 * Invariants under review:
 * - "↑ " glyph uses muted-gray (`\x1b[38;2;136;136;136m`)
 * - Token + cost VALUES use violet accent (`\x1b[38;2;124;111;235m`)
 * - " · " separator uses muted-gray
 * - Segment sits BETWEEN `Workers: N` and `Q: N`
 * - Segment ABSENT when totals undefined OR both zero
 * - Segment PRESENT when either total is non-zero (even when one is 0)
 */
import React from 'react';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { render } from 'ink-testing-library';
import { Box } from 'ink';
import { ThemeProvider } from '../../src/ui/theme/context.js';
import { StatusBar } from '../../src/ui/layout/StatusBar.js';
import type { SessionTotals } from '../../src/orchestrator/session-totals.js';
import type { ProjectSnapshot } from '../../src/projects/types.js';
import type { WorkerRecordSnapshot } from '../../src/orchestrator/worker-registry.js';

const OUT_DIR = path.resolve(process.cwd(), '.visual-frames');

function project(): ProjectSnapshot {
  return {
    id: 'p1',
    name: 'MathScrabble',
    path: '/repos/MathScrabble',
    createdAt: '2026-04-30T00:00:00Z',
  };
}

function worker(over: Partial<WorkerRecordSnapshot>): WorkerRecordSnapshot {
  return {
    id: 'wk-1',
    projectPath: '/repos/MathScrabble',
    worktreePath: '/repos/MathScrabble/.symphony/worktrees/wk-1',
    role: 'implementer',
    featureIntent: 'do thing',
    taskDescription: 'do thing',
    autonomyTier: 1,
    dependsOn: [],
    status: 'running',
    createdAt: new Date(Date.now() - 60_000).toISOString(),
    ...over,
  };
}

function stripAnsi(input: string): string {
  // eslint-disable-next-line no-control-regex
  return input.replace(/\x1b\[[\d;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
}

function flush(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}

interface Scenario {
  readonly name: string;
  readonly description: string;
  readonly props: React.ComponentProps<typeof StatusBar>;
}

function totals(over: Partial<SessionTotals>): SessionTotals {
  return {
    totalTokens: 0,
    totalCostUsd: 0,
    workerCount: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    ...over,
  };
}

const SCENARIOS: readonly Scenario[] = [
  {
    name: '01-no-segment-undefined-totals',
    description:
      'sessionTotals omitted entirely (back-compat with pre-3N.2 callers / test rigs without the namespace). Bar shows brand / mode / workers / Q / project / session ONLY.',
    props: {
      version: '0.0.0',
      mode: 'act',
      projects: [project()],
      workers: [worker({ status: 'running' })],
      sessionId: 'a1b2c3d4-aaaa-bbbb-cccc-dddddddddddd',
      questionsCount: 0,
    },
  },
  {
    name: '02-no-segment-zero-totals',
    description:
      'sessionTotals provided but all zero (splash state — Symphony just booted, no worker has billed). Segment hidden.',
    props: {
      version: '0.0.0',
      mode: 'act',
      projects: [project()],
      workers: [],
      sessionId: null,
      questionsCount: 0,
      sessionTotals: totals({}),
    },
  },
  {
    name: '03-small-tokens-sub-cent',
    description:
      'Tiny one-turn worker: 234 raw tokens, $0.0042 (sub-cent renders with 4 decimals). Segment "↑ 234 · $0.0042" between Workers and Q.',
    props: {
      version: '0.0.0',
      mode: 'act',
      projects: [project()],
      workers: [worker({ id: 'wk-1', status: 'completed' })],
      sessionId: null,
      questionsCount: 0,
      sessionTotals: totals({
        totalTokens: 234,
        totalCostUsd: 0.0042,
        workerCount: 1,
      }),
    },
  },
  {
    name: '04-k-range-tokens',
    description:
      'Mid-session: 47K tokens, $0.12. Renders "↑ 47K · $0.12" (no decimals on K above 10K).',
    props: {
      version: '0.0.0',
      mode: 'act',
      projects: [project()],
      workers: [worker({}), worker({ id: 'wk-2', status: 'completed' })],
      sessionId: null,
      questionsCount: 0,
      sessionTotals: totals({
        totalTokens: 47_120,
        totalCostUsd: 0.12,
        workerCount: 2,
      }),
    },
  },
  {
    name: '05-million-range-tokens',
    description:
      'Long-running session: 1.4M tokens, $4.25. Renders "↑ 1.4M · $4.25" (one-decimal M below 10M).',
    props: {
      version: '0.0.0',
      mode: 'act',
      projects: [project()],
      workers: [worker({}), worker({ id: 'wk-2' }), worker({ id: 'wk-3', status: 'completed' })],
      sessionId: 'a1b2c3d4-aaaa-bbbb-cccc-dddddddddddd',
      questionsCount: 0,
      sessionTotals: totals({
        totalTokens: 1_400_000,
        totalCostUsd: 4.25,
        workerCount: 5,
      }),
    },
  },
  {
    name: '06-tokens-no-cost',
    description:
      'Token-only edge: worker emitted usage but `total_cost_usd: 0` (free-tier or Max-plan zero-billed turn). Segment renders "↑ 5.2K · $0.00" — cost branch hits the exact-zero special case, not 4-decimal.',
    props: {
      version: '0.0.0',
      mode: 'act',
      projects: [project()],
      workers: [worker({})],
      sessionId: null,
      questionsCount: 0,
      sessionTotals: totals({
        totalTokens: 5_200,
        totalCostUsd: 0,
        workerCount: 1,
      }),
    },
  },
  {
    name: '07-cost-no-tokens',
    description:
      'Cost-only edge: cost accumulated before usage payload landed (race window). Segment renders "↑ 0 · $0.07" — under-1K tokens use raw count format.',
    props: {
      version: '0.0.0',
      mode: 'act',
      projects: [project()],
      workers: [worker({})],
      sessionId: null,
      questionsCount: 0,
      sessionTotals: totals({
        totalTokens: 0,
        totalCostUsd: 0.07,
        workerCount: 1,
      }),
    },
  },
  {
    name: '08-segment-with-away-and-q',
    description:
      'Combined: 320K tokens + $1.08 + awayMode=true + 2 blocking Qs. Bar shows BOTH the usage segment (between Workers and Q) AND the Away Mode segment (between Project and Session). Q cell colored red (blocking).',
    props: {
      version: '0.0.0',
      mode: 'act',
      projects: [project()],
      workers: [
        worker({ id: 'wk-1', status: 'completed' }),
        worker({ id: 'wk-2', status: 'completed' }),
        worker({ id: 'wk-3', status: 'completed' }),
        worker({ id: 'wk-4', status: 'running' }),
      ],
      sessionId: 'a1b2c3d4-aaaa-bbbb-cccc-dddddddddddd',
      questionsCount: 2,
      blockingCount: 1,
      awayMode: true,
      pendingQueueCount: 1,
      sessionTotals: totals({
        totalTokens: 320_000,
        totalCostUsd: 1.08,
        workerCount: 4,
      }),
    },
  },
];

async function capture(
  props: React.ComponentProps<typeof StatusBar>,
): Promise<{ ansi: string; plain: string }> {
  // Pin the harness terminal width to 160 cols. ink-testing-library's
  // default synthetic stdout is ~80 cols, which forces the full status
  // bar (brand + mode + workers + usage + Q + project + away + session)
  // to truncate. The 3H2/3H3/3H4 harnesses set `width={110}` via a
  // wrapping `<Box>` — sufficient for those layouts; the 3N.2 bar at
  // full population (scenario 08) carries eight segments and needs ≥150
  // cols to avoid wrap. 160 leaves headroom for future segment additions.
  const tree = (
    <Box flexDirection="column" width={160}>
      <ThemeProvider>
        <StatusBar {...props} />
      </ThemeProvider>
    </Box>
  );
  const result = render(tree);
  await flush();
  await flush();
  const ansi = result.lastFrame() ?? '';
  const plain = stripAnsi(ansi);
  result.unmount();
  return { ansi, plain };
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  const summary: string[] = [
    '# Phase 3N.2 visual frames — status-bar session-totals segment',
    '',
    `Generated: ${new Date().toISOString()}`,
    '',
    'Each scenario renders the StatusBar with a specific sessionTotals',
    'shape. Inspect `.plain.txt` for human review; `.ansi.txt` keeps the',
    'color escapes for grep-based palette verification.',
    '',
    'Locked palette under review (CLAUDE.md §Symphony palette):',
    '- violet `#7C6FEB` (segment VALUES + brand) → `\\x1b[38;2;124;111;235m`',
    '- muted  `#888888` (segment "↑", " · ", labels) → `\\x1b[38;2;136;136;136m`',
    '- text   `#E0E0E0` (mode value) → `\\x1b[38;2;224;224;224m`',
    '- red    `#E06C75` (blocking Q-cell) → `\\x1b[38;2;224;108;117m`',
    '',
    'Invariants to verify:',
    '- Segment ABSENT when sessionTotals undefined (scenario 01)',
    '- Segment ABSENT when both totalTokens and totalCostUsd are 0 (scenario 02)',
    '- Segment PRESENT when either non-zero (scenarios 03-08)',
    '- "↑ " glyph is muted-gray (NOT accent)',
    '- Token + cost values are violet accent',
    '- " · " separator is muted-gray',
    '- Segment sits between `Workers: N` and `Q: N`',
    '- formatTokenCount: <1K raw, 1K-10K one-decimal, 10K-1M no-decimal, 1M-10M one-decimal',
    '- formatCostUsd: 0 → $0.00, <$0.01 → 4 decimals, ≥$0.01 → 2 decimals',
    '- Scenario 08: usage segment + Away segment co-exist; usage between Workers and Q, Away between Project and Session',
    '',
    '| Scenario | Description |',
    '|---|---|',
  ];

  for (const scenario of SCENARIOS) {
    process.stderr.write(`Capturing ${scenario.name}…\n`);
    const { ansi, plain } = await capture(scenario.props);
    writeFileSync(path.join(OUT_DIR, `3n2-${scenario.name}.ansi.txt`), ansi, 'utf8');
    writeFileSync(
      path.join(OUT_DIR, `3n2-${scenario.name}.plain.txt`),
      `# ${scenario.name}\n# ${scenario.description}\n\n${plain}\n`,
      'utf8',
    );
    summary.push(`| \`${scenario.name}\` | ${scenario.description} |`);
  }

  writeFileSync(path.join(OUT_DIR, 'INDEX-3n2.md'), summary.join('\n') + '\n', 'utf8');
  process.stderr.write(`\n${SCENARIOS.length} frames written to ${OUT_DIR}\n`);
}

void main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
