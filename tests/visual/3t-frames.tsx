/**
 * Phase 3T — visual frame harness for Interrupt Semantics.
 *
 * Captures the three surfaces 3T touches under canonical states for a
 * SEPARATE skeptical-subagent review:
 *   - StatusDot at every status (focus on the new 'interrupted' case)
 *   - PipelineBar across the role × status matrix for 'interrupted'
 *   - WorkerRow at status='interrupted' (must show ⏸ glyph + " — awaiting new direction" suffix)
 *   - SystemBubble carrying the synthetic interrupt chat row
 *
 * Output: `.visual-frames/3t-<state>.{ansi,plain}.txt` + `INDEX-3t.md`.
 *
 * Locked palette under review (CLAUDE.md):
 *   - text light gray `#E0E0E0` → `\x1b[38;2;224;224;224m` (body text)
 *   - muted gray      `#888888` → `\x1b[38;2;136;136;136m` (interrupted glyph + suffix)
 *   - gold            `#D4A843` → `\x1b[38;2;212;168;67m`  (✓ success)
 *   - red             `#E06C75` → `\x1b[38;2;224;108;117m` (✗ failure)
 *
 * Invariants to verify:
 *   - StatusDot renders `⏸` glyph in muted gray when status='interrupted'.
 *   - PipelineBar's current-stage cell renders muted-gray for 'interrupted'
 *     (same as 'killed' — paused colorway).
 *   - WorkerRow appends " — awaiting new direction" suffix in muted gray
 *     ONLY when status === 'interrupted' (NOT when killed/crashed/etc).
 *   - Chat SystemBubble for interrupt summary renders `⏸` glyph in
 *     textMuted color + the pivot tally line ("N workers killed · M
 *     queued spawns drained · K pending tasks cancelled. Awaiting new
 *     direction.").
 */
import React from 'react';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { render } from 'ink-testing-library';
import { ThemeProvider } from '../../src/ui/theme/context.js';
import { StatusDot } from '../../src/ui/panels/workers/StatusDot.js';
import { PipelineBar } from '../../src/ui/panels/workers/PipelineBar.js';
import { WorkerRow } from '../../src/ui/panels/workers/WorkerRow.js';
import { Bubble } from '../../src/ui/panels/chat/Bubble.js';
import type { WorkerRecordSnapshot } from '../../src/orchestrator/worker-registry.js';
import type { WorkerStatus } from '../../src/workers/types.js';
import type { WorkerRole } from '../../src/orchestrator/types.js';
import type { SystemTurn } from '../../src/ui/data/chatHistoryReducer.js';

const OUT_DIR = path.resolve(process.cwd(), '.visual-frames');

function worker(over: Partial<WorkerRecordSnapshot>): WorkerRecordSnapshot {
  return {
    id: 'wk-1',
    projectPath: '/repos/MathScrabble',
    worktreePath: '/repos/MathScrabble/.symphony/worktrees/wk-1',
    role: 'implementer',
    featureIntent: 'wire-payments',
    taskDescription: 'wire payments',
    autonomyTier: 1,
    dependsOn: [],
    status: 'running',
    createdAt: new Date(Date.now() - 60_000).toISOString(),
    ...over,
  };
}

function flush(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}

function stripAnsi(input: string): string {
  // eslint-disable-next-line no-control-regex
  return input.replace(/\x1b\[[\d;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
}

interface DotScenario {
  readonly kind: 'dot';
  readonly name: string;
  readonly description: string;
  readonly status: WorkerStatus;
}

interface BarScenario {
  readonly kind: 'bar';
  readonly name: string;
  readonly description: string;
  readonly role: WorkerRole;
  readonly status: WorkerStatus;
}

interface RowScenario {
  readonly kind: 'row';
  readonly name: string;
  readonly description: string;
  readonly status: WorkerStatus;
}

interface BubbleScenario {
  readonly kind: 'bubble';
  readonly name: string;
  readonly description: string;
  readonly headline: string;
}

type Scenario = DotScenario | BarScenario | RowScenario | BubbleScenario;

const SCENARIOS: readonly Scenario[] = [
  {
    kind: 'dot',
    name: '01-dot-interrupted',
    description:
      'StatusDot at status=interrupted. Glyph is `⏸` in muted gray (`\\x1b[38;2;136;136;136m`). Same theme key (`workerPaused`) as `killed` but distinct glyph (⊘ vs ⏸).',
    status: 'interrupted',
  },
  {
    kind: 'dot',
    name: '02-dot-killed',
    description:
      'StatusDot at status=killed — regression reference. Glyph is `⊘` in muted gray. Confirms 3T did not regress the killed glyph.',
    status: 'killed',
  },
  {
    kind: 'bar',
    name: '03-bar-interrupted-implementer',
    description:
      'PipelineBar at role=implementer + status=interrupted. Stage 3 (current) cell is muted gray (workerPaused theme key). Prior stages remain gold (done), future stages muted.',
    role: 'implementer',
    status: 'interrupted',
  },
  {
    kind: 'bar',
    name: '04-bar-interrupted-reviewer',
    description:
      'PipelineBar at role=reviewer + status=interrupted. Final stage cell muted gray; reviewer pipeline ends with the same workerPaused colorway as killed.',
    role: 'reviewer',
    status: 'interrupted',
  },
  {
    kind: 'row',
    name: '05-row-interrupted-suffix',
    description:
      'WorkerRow at status=interrupted. Suffix " — awaiting new direction" appears in muted gray (`\\x1b[38;2;136;136;136m`) RIGHT after `wire-payments`. Confirms the 3T suffix renders only for interrupted, not killed/crashed.',
    status: 'interrupted',
  },
  {
    kind: 'row',
    name: '06-row-killed-no-suffix',
    description:
      'WorkerRow at status=killed — regression reference. NO " — awaiting new direction" suffix. Confirms the conditional only fires for `interrupted`.',
    status: 'killed',
  },
  {
    kind: 'bubble',
    name: '07-bubble-interrupt-multi',
    description:
      'SystemBubble for the synthetic interrupt row. Headline reads `Interrupted — 2 workers killed · 1 queued spawn drained · 3 pending tasks cancelled. Awaiting new direction.`. Glyph `⏸` in muted gray (textMuted theme token).',
    headline: 'Interrupted — 2 workers killed · 1 queued spawn drained · 3 pending tasks cancelled. Awaiting new direction.',
  },
  {
    kind: 'bubble',
    name: '08-bubble-interrupt-empty',
    description:
      'SystemBubble for an interrupt fired with nothing in flight (the user pressed Esc with no workers / queue / tasks active). Headline degrades to `Interrupted — nothing in flight. Awaiting new direction.`.',
    headline: 'Interrupted — nothing in flight. Awaiting new direction.',
  },
];

async function captureDot(status: WorkerStatus): Promise<{ ansi: string; plain: string }> {
  const tree = (
    <ThemeProvider>
      <StatusDot status={status} />
    </ThemeProvider>
  );
  const result = render(tree);
  await flush();
  await flush();
  const ansi = result.lastFrame() ?? '';
  const plain = stripAnsi(ansi);
  result.unmount();
  return { ansi, plain };
}

async function captureBar(
  role: WorkerRole,
  status: WorkerStatus,
): Promise<{ ansi: string; plain: string }> {
  const tree = (
    <ThemeProvider>
      <PipelineBar role={role} status={status} />
    </ThemeProvider>
  );
  const result = render(tree);
  await flush();
  await flush();
  const ansi = result.lastFrame() ?? '';
  const plain = stripAnsi(ansi);
  result.unmount();
  return { ansi, plain };
}

async function captureRow(status: WorkerStatus): Promise<{ ansi: string; plain: string }> {
  const tree = (
    <ThemeProvider>
      <WorkerRow
        worker={worker({ status, model: 'claude-opus-4-7' })}
        instrument="Violin"
        selected={false}
        featureIntentDisplay="wire-payments"
        runtimeDisplay="2m"
      />
    </ThemeProvider>
  );
  const result = render(tree);
  await flush();
  await flush();
  const ansi = result.lastFrame() ?? '';
  const plain = stripAnsi(ansi);
  result.unmount();
  return { ansi, plain };
}

async function captureBubble(headline: string): Promise<{ ansi: string; plain: string }> {
  const turn: SystemTurn = {
    kind: 'system',
    id: 'sys-1',
    ts: Date.now(),
    summary: {
      workerId: 'interrupt-1',
      workerName: 'Symphony',
      projectName: '',
      statusKind: 'interrupted',
      durationMs: null,
      headline,
      fallback: false,
    },
  };
  const tree = (
    <ThemeProvider>
      <Bubble turn={turn} />
    </ThemeProvider>
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
    '# Phase 3T visual frames — Interrupt Semantics',
    '',
    `Generated: ${new Date().toISOString()}`,
    '',
    'Each scenario renders one of:',
    '  - StatusDot (glyph + theme color for the new `interrupted` status)',
    '  - PipelineBar (current-stage cell tint at `interrupted`)',
    '  - WorkerRow (full row with " — awaiting new direction" suffix)',
    '  - Chat SystemBubble (the synthetic interrupt row markInterrupted pushes)',
    '',
    'Inspect `.plain.txt` for human review; `.ansi.txt` keeps the color',
    'escapes for the skeptical-subagent grep pass.',
    '',
    'Locked palette under review (CLAUDE.md §Symphony palette):',
    '- text light gray `#E0E0E0`  → `\\x1b[38;2;224;224;224m` (body text)',
    '- muted gray      `#888888`  → `\\x1b[38;2;136;136;136m` (interrupted glyph + suffix)',
    '- gold            `#D4A843`  → `\\x1b[38;2;212;168;67m`  (✓ success — reference, not in 3T frames)',
    '- red             `#E06C75`  → `\\x1b[38;2;224;108;117m` (✗ failure — reference, not in 3T frames)',
    '',
    'Invariants to verify:',
    '- StatusDot `interrupted` → `⏸` glyph in muted gray, distinct from `killed` (⊘ same color).',
    '- PipelineBar current-stage cell for `interrupted` is muted gray (same as `killed`).',
    '- WorkerRow at `interrupted` appends " — awaiting new direction" in muted gray.',
    '- WorkerRow at `killed` does NOT show the suffix — confirms conditional is correctly gated.',
    '- SystemBubble for interrupt: `⏸` glyph in muted gray, headline carries the pivot tally.',
    '',
    '| Scenario | Description |',
    '|---|---|',
  ];

  for (const scenario of SCENARIOS) {
    process.stderr.write(`Capturing ${scenario.name}…\n`);
    let captured: { ansi: string; plain: string };
    if (scenario.kind === 'dot') {
      captured = await captureDot(scenario.status);
    } else if (scenario.kind === 'bar') {
      captured = await captureBar(scenario.role, scenario.status);
    } else if (scenario.kind === 'row') {
      captured = await captureRow(scenario.status);
    } else {
      captured = await captureBubble(scenario.headline);
    }
    writeFileSync(
      path.join(OUT_DIR, `3t-${scenario.name}.ansi.txt`),
      captured.ansi,
      'utf8',
    );
    writeFileSync(
      path.join(OUT_DIR, `3t-${scenario.name}.plain.txt`),
      `# ${scenario.name}\n# ${scenario.description}\n\n${captured.plain}\n`,
      'utf8',
    );
    summary.push(`| \`${scenario.name}\` | ${scenario.description} |`);
  }

  writeFileSync(path.join(OUT_DIR, 'INDEX-3t.md'), summary.join('\n') + '\n', 'utf8');
  process.stderr.write(`\n${SCENARIOS.length} frames written to ${OUT_DIR}\n`);
}

void main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
