/**
 * Phase 3K — visual frame harness for the system completion-summary
 * Bubble.
 *
 * Captures `<Bubble>` (system kind) under canonical states for a
 * SEPARATE skeptical-subagent review. Each scenario fabricates a
 * `SystemTurn` directly so the harness exercises the rendering
 * branches without an RPC roundtrip or live worker.
 *
 * Output: `.visual-frames/3k-<state>.{ansi,plain}.txt` + `INDEX-3k.md`.
 *
 * Locked palette (CLAUDE.md):
 *   - success-gold `#D4A843` → `\x1b[38;2;212;168;67m` (✓ glyph + completed name)
 *   - error-red   `#E06C75` → `\x1b[38;2;224;108;117m` (✗ glyph + failed name)
 *   - warning gold-light             → ⏱ glyph (timeout)
 *   - text light  `#E0E0E0` → `\x1b[38;2;224;224;224m` (headline body)
 *   - muted gray  `#888888` → `\x1b[38;2;136;136;136m` (project parens, metrics, details)
 */
import React from 'react';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { render } from 'ink-testing-library';
import { Box } from 'ink';
import { ThemeProvider } from '../../src/ui/theme/context.js';
import { Bubble } from '../../src/ui/panels/chat/Bubble.js';
import type { SystemTurn } from '../../src/ui/data/chatHistoryReducer.js';

const OUT_DIR = path.resolve(process.cwd(), '.visual-frames');

interface Scenario {
  readonly name: string;
  readonly description: string;
  readonly turn: SystemTurn;
}

function makeSystemTurn(over: Partial<SystemTurn['summary']> = {}): SystemTurn {
  return {
    kind: 'system',
    id: 'system-0',
    summary: {
      workerId: 'wk-1',
      workerName: 'Violin',
      projectName: 'MathScrabble',
      statusKind: 'completed',
      durationMs: 138_000,
      headline: 'Wired up the friend system endpoints',
      fallback: false,
      ...over,
    },
    ts: 0,
  };
}

const SCENARIOS: Scenario[] = [
  {
    name: '01-completed-headline-only',
    description:
      'Happy path. Completed worker, ✓ in success-gold, single-line headline. No metrics or details.',
    turn: makeSystemTurn(),
  },
  {
    name: '02-completed-with-metrics',
    description:
      'Completed worker with a metrics line ("12 tests passing"). Headline in text-light; metrics in muted-gray.',
    turn: makeSystemTurn({ metrics: '12 tests passing · $0.0042' }),
  },
  {
    name: '03-completed-headline-metrics-details',
    description:
      'Full 3-line system row: headline, metrics, details. Verifies all body lines render and stay distinct in color.',
    turn: makeSystemTurn({
      headline: 'Refactored the cache layer to use LRU',
      metrics: '47 tests passing',
      details: 'left a TODO in src/cache.ts:42 about TTL invalidation',
    }),
  },
  {
    name: '04-failed',
    description:
      'Worker reported failure. ✗ glyph in error-red. Headline reads "worker reported failure" (heuristic shape) — but verify the body color is text-light, not error-red, so the failure isn\'t over-emphasized.',
    turn: makeSystemTurn({
      statusKind: 'failed',
      headline: 'TypeError: Cannot read property of undefined',
      durationMs: 4_000,
    }),
  },
  {
    name: '05-crashed-no-message',
    description:
      'Worker crashed before producing a message. Heuristic-style headline. Verify ✗ in error-red and "(unknown)" duration when no exit info.',
    turn: makeSystemTurn({
      statusKind: 'crashed',
      headline: 'worker crashed · 0 tool calls',
      durationMs: null,
      fallback: true,
    }),
  },
  {
    name: '06-timeout',
    description:
      'Worker timed out. ⏱ glyph in warning-gold (the warning theme token resolves to goldLight in the truecolor theme). Multi-line headline (newline mid-text).',
    turn: makeSystemTurn({
      statusKind: 'timeout',
      headline: 'Hit 20-minute spawn timeout',
      durationMs: 1_200_000,
    }),
  },
  {
    name: '07-multi-line-headline',
    description:
      'Headline contains an explicit newline; both lines should render with text-light color and the same 2-space indent.',
    turn: makeSystemTurn({
      headline: 'first line of the headline\nsecond line of the headline',
    }),
  },
  {
    name: '08-very-long-headline',
    description:
      'Headline at the 200-char cap (just below ellipsis trigger). Verifies wrap behavior under a fixed-width container; should not break the "(project) · duration" header line.',
    turn: makeSystemTurn({
      headline:
        'Wired up the friend system across 4 API routes, ' +
        'updated the database schema with 3 migrations, ' +
        'added 47 unit tests, and verified end-to-end ' +
        'in the staging environment with manual smoke tests.',
      metrics: '47 tests passing',
    }),
  },
];

async function captureScenario(scenario: Scenario): Promise<{ ansi: string; plain: string }> {
  const tree = (
    <ThemeProvider>
      <Box flexDirection="column" width={80}>
        <Bubble turn={scenario.turn} />
      </Box>
    </ThemeProvider>
  );
  const result = render(tree);
  await new Promise((r) => setImmediate(r));
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
    '# Phase 3K visual frames — Worker Completion Summaries (system Bubble)',
    '',
    `Generated: ${new Date().toISOString()}`,
    '',
    'Each scenario renders the chat-panel `<Bubble>` for a `system` turn ',
    'with a fabricated SystemSummary so the harness exercises the rendering ',
    'branches without an RPC roundtrip or live worker. Inspect `.plain.txt` ',
    'for human review; `.ansi.txt` keeps the color escapes (grep ',
    '`\\x1b[38;2;…m` for hex codes).',
    '',
    'Locked palette under review (CLAUDE.md §Symphony palette):',
    '- success-gold `#D4A843` (`✓` + completed worker name) → `\\x1b[38;2;212;168;67m`',
    '- error-red   `#E06C75` (`✗` + failed/crashed worker name) → `\\x1b[38;2;224;108;117m`',
    '- warning gold-light (⏱ for timeout)',
    '- text light  `#E0E0E0` (headline body) → `\\x1b[38;2;224;224;224m`',
    '- muted gray  `#888888` (project parens · duration · metrics · details) → `\\x1b[38;2;136;136;136m`',
    '',
    'Layout invariants to verify:',
    '- header line: `<icon> <workerName> (<projectName>) · <duration>`',
    '- icon + workerName carry the status color (success/error/warning), bold',
    '- project parens + duration are muted-gray (NOT colored by status)',
    '- headline indented 2 spaces, text-light color',
    '- metrics + details indented 2 spaces, muted-gray, omitted entirely when absent',
    '- multi-line headlines wrap with consistent 2-space indent',
    '- system row has a `marginTop={1}` separator above the bubble',
    '- NO bordered bubble (distinct from user `❯ ` prefix and assistant blocks)',
    '',
    '| Scenario | Description |',
    '|---|---|',
  ];

  for (const scenario of SCENARIOS) {
    process.stderr.write(`Capturing ${scenario.name}…\n`);
    const { ansi, plain } = await captureScenario(scenario);
    writeFileSync(path.join(OUT_DIR, `3k-${scenario.name}.ansi.txt`), ansi, 'utf8');
    writeFileSync(
      path.join(OUT_DIR, `3k-${scenario.name}.plain.txt`),
      `# ${scenario.name}\n# ${scenario.description}\n\n${plain}\n`,
      'utf8',
    );
    summary.push(`| \`${scenario.name}\` | ${scenario.description} |`);
  }

  writeFileSync(path.join(OUT_DIR, 'INDEX-3k.md'), summary.join('\n') + '\n', 'utf8');
  process.stderr.write(`\n${SCENARIOS.length} frames written to ${OUT_DIR}\n`);
}

void main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
