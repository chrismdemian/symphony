/**
 * Phase 3Q — visual frame harness for the boot-time recovery banner.
 *
 * Surface exercised: chat-panel `<Bubble>` (system kind) rendering
 * the SystemSummary that `<AppShell>` pushes when `recovery.crashedIds`
 * is non-empty. Singular and plural copy variants.
 *
 * Output: `.visual-frames/3q-<name>.{ansi,plain}.txt` + `INDEX-3q.md`.
 *
 * Locked palette (CLAUDE.md):
 *   - error-red    `#E06C75` (✗ failed)        → `\x1b[38;2;224;108;117m`
 *   - text light   `#E0E0E0` (headline body)   → `\x1b[38;2;224;224;224m`
 *   - muted gray   `#888888` (parens, no proj) → `\x1b[38;2;136;136;136m`
 *
 * Reviewer scope (separate skeptical subagent):
 *   - Header: ✗ glyph + "Symphony" in error-red, bold.
 *   - NO project parens (empty projectName) AND NO duration tail
 *     (durationMs: null) — the Bubble's 3M skip-when-both-empty rule.
 *   - Headline indented 2 spaces, text-light.
 *   - Singular says "Recovered 1 worker"; plural says "Recovered N workers".
 *   - Closing copy: "Use resume_worker(id) to revive or kill_worker(id) to dismiss."
 *   - NO bordered bubble (matches 3K + 3O.1 + 3P).
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
  readonly element: React.ReactElement;
}

function recoveryTurn(count: number, capturedAt: string): SystemTurn {
  const headline =
    count === 1
      ? `Recovered 1 worker from previous session — visible in /workers as 'crashed'. Use resume_worker(id) to revive or kill_worker(id) to dismiss.`
      : `Recovered ${count} workers from previous session — visible in /workers as 'crashed'. Use resume_worker(id) to revive or kill_worker(id) to dismiss.`;
  return {
    kind: 'system',
    id: `system-recovery-${count}`,
    summary: {
      workerId: `recovery-boot-${capturedAt}`,
      workerName: 'Symphony',
      projectName: '',
      statusKind: 'failed',
      durationMs: null,
      headline,
      fallback: false,
    },
    ts: 0,
  };
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

const SCENARIOS: Scenario[] = [
  {
    name: '01-recovery-single',
    description:
      'One crashed worker recovered. Singular copy: "Recovered 1 worker from previous session…". ✗ red glyph, Symphony header in red-bold, no project parens, no duration.',
    element: (
      <BubbleHarness turn={recoveryTurn(1, '2026-05-14T10:00:00.000Z')} />
    ),
  },
  {
    name: '02-recovery-multi',
    description:
      'Three crashed workers. Plural copy: "Recovered 3 workers from previous session…". Same chrome as singular.',
    element: (
      <BubbleHarness turn={recoveryTurn(3, '2026-05-14T10:00:00.000Z')} />
    ),
  },
  {
    name: '03-recovery-many',
    description:
      'Ten crashed workers — stress test for wrapping behavior under a long count digit + the closing instruction text.',
    element: (
      <BubbleHarness turn={recoveryTurn(10, '2026-05-14T10:00:00.000Z')} />
    ),
  },
];

async function captureScenario(scenario: Scenario): Promise<{ ansi: string; plain: string }> {
  const result = render(scenario.element);
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
    '# Phase 3Q visual frames — Boot recovery banner',
    '',
    `Generated: ${new Date().toISOString()}`,
    '',
    'When `recovery.crashedIds.length > 0` at boot, `<AppShell>` ',
    'dispatches a one-shot SystemSummary chat row. These frames capture ',
    'that row under singular/plural copy variants for the skeptical ',
    'subagent review. Inspect `.plain.txt` for human review; `.ansi.txt` ',
    'keeps the color escapes (grep `\\x1b[38;2;…m` for hex codes).',
    '',
    'Locked palette under review (CLAUDE.md §Symphony palette):',
    '- error-red    `#E06C75` (✗ failed glyph + Symphony header) → `\\x1b[38;2;224;108;117m`',
    '- text light   `#E0E0E0` (headline body) → `\\x1b[38;2;224;224;224m`',
    '- muted gray   `#888888` (parens / project tail; SHOULD NOT APPEAR HERE) → `\\x1b[38;2;136;136;136m`',
    '',
    'SystemSummary → Bubble mapping (3Q):',
    '- workerName="Symphony", projectName="", durationMs=null → 3M skip-tail rule applies (no `(…) · …` after the header).',
    '- statusKind="failed" → ✗ red glyph + red workerName.',
    '- workerId=`recovery-boot-<capturedAt>` — synthetic; chat reducer keys turns by its own id, so collisions don\'t matter for rendering.',
    '',
    'Invariants to verify:',
    '- ✗ red glyph + "Symphony" in error-red, bold.',
    '- NO project parens, NO duration token. (Both empty/null.)',
    '- Headline indented 2 spaces, text-light.',
    '- Singular row: "Recovered 1 worker from previous session…"',
    '- Plural row: "Recovered N workers from previous session…" (e.g. 3, 10).',
    '- Closing instruction: "Use resume_worker(id) to revive or kill_worker(id) to dismiss."',
    '- NO bordered bubble; rows align with 3K/3O.1/3P system rows.',
    '',
    '| Scenario | Description |',
    '|---|---|',
  ];

  for (const scenario of SCENARIOS) {
    process.stderr.write(`Capturing ${scenario.name}…\n`);
    const { ansi, plain } = await captureScenario(scenario);
    writeFileSync(path.join(OUT_DIR, `3q-${scenario.name}.ansi.txt`), ansi, 'utf8');
    writeFileSync(
      path.join(OUT_DIR, `3q-${scenario.name}.plain.txt`),
      `# ${scenario.name}\n# ${scenario.description}\n\n${plain}\n`,
      'utf8',
    );
    summary.push(`| \`${scenario.name}\` | ${scenario.description} |`);
  }

  writeFileSync(path.join(OUT_DIR, 'INDEX-3q.md'), summary.join('\n') + '\n', 'utf8');
  process.stderr.write(`\n${SCENARIOS.length} frames written to ${OUT_DIR}\n`);
}

void main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
