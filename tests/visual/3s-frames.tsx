/**
 * Phase 3S — visual frame harness for Autonomy Dial + Mission Control.
 *
 * Captures four surfaces under canonical states for a SEPARATE
 * skeptical-subagent review:
 *   - StatusBar autonomy tier chip at each of T1 / T2 / T3 (color check)
 *   - WorkerRow without and with the T3 elevation chip
 *   - OutputInlineInput empty (cursor only) and typed (`also check…`)
 *
 * Output: `.visual-frames/3s-<state>.{ansi,plain}.txt` + `INDEX-3s.md`.
 *
 * Locked palette under review (CLAUDE.md):
 *   - violet `#7C6FEB`   → `\x1b[38;2;124;111;235m` (T2 chip + accent)
 *   - gold   `#D4A843`   → `\x1b[38;2;212;168;67m`  (T1 chip + ✓ glyph)
 *   - amber  `#E5C07B`   → `\x1b[38;2;229;192;123m` (T3 chip + worker-row T3)
 *   - text   `#E0E0E0`   → `\x1b[38;2;224;224;224m` (status text + body)
 *   - muted  `#888888`   → `\x1b[38;2;136;136;136m` (labels)
 *
 * Invariants to verify:
 *   - StatusBar tier chip is ALWAYS rendered (every scenario, no
 *     opt-out — unlike awayMode which is conditional).
 *   - Tier chip color matches the table above; reading
 *     `tierColor(theme, n)` in `src/ui/layout/StatusBar.tsx`
 *     directly. Wrong tier → wrong color is a regression.
 *   - WorkerRow T3 chip ABSENT at Tier 1/2; PRESENT at Tier 3 in
 *     amber. Only Tier 3 elevation shows the chip (avoiding noise
 *     on pre-3S Tier-1 recovered workers).
 *   - OutputInlineInput renders the `↪` arrow in accent (violet),
 *     the worker name in muted-gray, the typed text in light-gray,
 *     and an inverse-block cursor (`\x1b[7m`).
 */
import React from 'react';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { render } from 'ink-testing-library';
import { ThemeProvider } from '../../src/ui/theme/context.js';
import { StatusBar } from '../../src/ui/layout/StatusBar.js';
import { WorkerRow } from '../../src/ui/panels/workers/WorkerRow.js';
import { OutputInlineInput } from '../../src/ui/panels/output/OutputInlineInput.js';
import type { ProjectSnapshot } from '../../src/projects/types.js';
import type { WorkerRecordSnapshot } from '../../src/orchestrator/worker-registry.js';
import type { AutonomyTier } from '../../src/orchestrator/types.js';

const OUT_DIR = path.resolve(process.cwd(), '.visual-frames');

function project(over: Partial<ProjectSnapshot>): ProjectSnapshot {
  return {
    id: 'p1',
    name: 'MathScrabble',
    path: '/repos/MathScrabble',
    createdAt: '2026-04-30T00:00:00Z',
    ...over,
  };
}

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

interface BarScenario {
  readonly kind: 'bar';
  readonly name: string;
  readonly description: string;
  readonly tier: AutonomyTier;
}

interface RowScenario {
  readonly kind: 'row';
  readonly name: string;
  readonly description: string;
  readonly workerTier: AutonomyTier;
}

interface InjectScenario {
  readonly kind: 'inject';
  readonly name: string;
  readonly description: string;
  readonly typed: string;
}

type Scenario = BarScenario | RowScenario | InjectScenario;

const SCENARIOS: readonly Scenario[] = [
  {
    kind: 'bar',
    name: '01-bar-tier-1-free',
    description:
      'StatusBar with autonomyTier=1. Chip renders `T1 Free` in gold (`\\x1b[38;2;212;168;67m`). Always-on segment after Session.',
    tier: 1,
  },
  {
    kind: 'bar',
    name: '02-bar-tier-2-notify',
    description:
      'StatusBar with autonomyTier=2 (default). Chip renders `T2 Notify` in violet (`\\x1b[38;2;124;111;235m`).',
    tier: 2,
  },
  {
    kind: 'bar',
    name: '03-bar-tier-3-confirm',
    description:
      'StatusBar with autonomyTier=3. Chip renders `T3 Confirm` in gold-light/amber (`\\x1b[38;2;229;192;123m`).',
    tier: 3,
  },
  {
    kind: 'row',
    name: '04-row-tier-1-no-chip',
    description:
      'WorkerRow with autonomyTier=1 (legacy default). NO T3 chip. Row shows dot + instrument + bar + stage + intent + model + runtime only.',
    workerTier: 1,
  },
  {
    kind: 'row',
    name: '05-row-tier-2-no-chip',
    description:
      'WorkerRow with autonomyTier=2 (orchestrator default). NO T3 chip — only Tier 3 elevation surfaces a chip.',
    workerTier: 2,
  },
  {
    kind: 'row',
    name: '06-row-tier-3-chip',
    description:
      'WorkerRow with autonomyTier=3. T3 chip renders in gold-light/amber (`\\x1b[38;2;229;192;123m`) between feature intent and the model label.',
    workerTier: 3,
  },
  {
    kind: 'inject',
    name: '07-inject-empty',
    description:
      'OutputInlineInput with empty buffer. Renders `↪ Violin ` plus an inverse-block cursor (`\\x1b[7m`). `↪` in accent/violet; `Violin` in muted-gray.',
    typed: '',
  },
  {
    kind: 'inject',
    name: '08-inject-typed',
    description:
      'OutputInlineInput after user types "also check the audit.log path". Text renders in light-gray (`\\x1b[38;2;224;224;224m`) following the worker name. Cursor still at the end.',
    typed: 'also check the audit.log path',
  },
];

async function captureBar(tier: AutonomyTier): Promise<{ ansi: string; plain: string }> {
  const tree = (
    <ThemeProvider>
      <StatusBar
        version="0.1.0"
        mode="act"
        projects={[project({})]}
        workers={[worker({})]}
        sessionId="a1b2c3d4-aaaa-bbbb-cccc-dddddddddddd"
        questionsCount={0}
        blockingCount={0}
        awayMode={false}
        pendingQueueCount={0}
        autonomyTier={tier}
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

async function captureRow(workerTier: AutonomyTier): Promise<{ ansi: string; plain: string }> {
  const tree = (
    <ThemeProvider>
      <WorkerRow
        worker={worker({ autonomyTier: workerTier, model: 'claude-opus-4-7' })}
        instrument="Violin"
        selected={false}
        featureIntentDisplay="wire-payments"
        runtimeDisplay="1m"
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

async function captureInject(typed: string): Promise<{ ansi: string; plain: string }> {
  const tree = (
    <ThemeProvider>
      <OutputInlineInput
        workerName="Violin"
        onSubmit={async () => {}}
        onCancel={() => {}}
      />
    </ThemeProvider>
  );
  const result = render(tree);
  await flush();
  if (typed.length > 0) {
    (result.stdin as unknown as { write: (s: string) => void }).write(typed);
    await flush();
    await flush();
  }
  const ansi = result.lastFrame() ?? '';
  const plain = stripAnsi(ansi);
  result.unmount();
  return { ansi, plain };
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  const summary: string[] = [
    '# Phase 3S visual frames — Autonomy Dial + Mission Control',
    '',
    `Generated: ${new Date().toISOString()}`,
    '',
    'Each scenario renders one of:',
    '  - StatusBar (with autonomyTier prop)',
    '  - WorkerRow (with worker.autonomyTier varying)',
    '  - OutputInlineInput (empty + typed)',
    '',
    'Inspect `.plain.txt` for human review; `.ansi.txt` keeps the color',
    'escapes for the skeptical-subagent grep pass.',
    '',
    'Locked palette under review (CLAUDE.md §Symphony palette):',
    '- violet `#7C6FEB`  → `\\x1b[38;2;124;111;235m` (T2 chip + InlineInput arrow)',
    '- gold   `#D4A843`  → `\\x1b[38;2;212;168;67m`  (T1 chip)',
    '- amber  `#E5C07B`  → `\\x1b[38;2;229;192;123m` (T3 chips on bar + worker row)',
    '- text   `#E0E0E0`  → `\\x1b[38;2;224;224;224m` (status text + typed text)',
    '- muted  `#888888`  → `\\x1b[38;2;136;136;136m` (labels)',
    '',
    'Invariants to verify:',
    '- Tier chip ALWAYS rendered in StatusBar — every scenario, no conditional.',
    '- Tier chip COLOR matches tier: T1 gold, T2 violet, T3 amber.',
    '- WorkerRow T3 chip ABSENT at Tier 1 + Tier 2; PRESENT at Tier 3 in amber.',
    '- OutputInlineInput renders `↪` arrow in accent (violet), worker name in muted-gray, typed text in light-gray.',
    '- Inverse-block cursor present (`\\x1b[7m`) when not submitting.',
    '',
    '| Scenario | Description |',
    '|---|---|',
  ];

  for (const scenario of SCENARIOS) {
    process.stderr.write(`Capturing ${scenario.name}…\n`);
    let captured: { ansi: string; plain: string };
    if (scenario.kind === 'bar') {
      captured = await captureBar(scenario.tier);
    } else if (scenario.kind === 'row') {
      captured = await captureRow(scenario.workerTier);
    } else {
      captured = await captureInject(scenario.typed);
    }
    writeFileSync(
      path.join(OUT_DIR, `3s-${scenario.name}.ansi.txt`),
      captured.ansi,
      'utf8',
    );
    writeFileSync(
      path.join(OUT_DIR, `3s-${scenario.name}.plain.txt`),
      `# ${scenario.name}\n# ${scenario.description}\n\n${captured.plain}\n`,
      'utf8',
    );
    summary.push(`| \`${scenario.name}\` | ${scenario.description} |`);
  }

  writeFileSync(path.join(OUT_DIR, 'INDEX-3s.md'), summary.join('\n') + '\n', 'utf8');
  process.stderr.write(`\n${SCENARIOS.length} frames written to ${OUT_DIR}\n`);
}

void main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
