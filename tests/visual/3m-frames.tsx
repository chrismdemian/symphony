/**
 * Phase 3M — visual frame harness for Away Mode.
 *
 * Captures three surfaces under canonical states for a SEPARATE
 * skeptical-subagent review:
 *   - StatusBar with awayMode=false (no segment present)
 *   - StatusBar with awayMode=true + non-zero counts (muted-gray
 *     segment between Project and Session)
 *   - SystemBubble rendering the "While you were away: …" digest row
 *     (workerName='Symphony', empty project, null duration → no
 *     `(project) · duration` tail)
 *
 * Output: `.visual-frames/3m-<state>.{ansi,plain}.txt` + `INDEX-3m.md`.
 *
 * Locked palette under review (CLAUDE.md):
 *   - violet `#7C6FEB`  → `\x1b[38;2;124;111;235m` (status bar accent)
 *   - gold   `#D4A843`  → `\x1b[38;2;212;168;67m`  (success ✓ glyph + bold worker name)
 *   - text   `#E0E0E0`  → `\x1b[38;2;224;224;224m` (status text + headline)
 *   - muted  `#888888`  → `\x1b[38;2;136;136;136m` (Away Mode segment, labels, parens)
 */
import React from 'react';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { render } from 'ink-testing-library';
import { ThemeProvider } from '../../src/ui/theme/context.js';
import { StatusBar } from '../../src/ui/layout/StatusBar.js';
import { Bubble } from '../../src/ui/panels/chat/Bubble.js';
import type { ProjectSnapshot } from '../../src/projects/types.js';
import type { WorkerRecordSnapshot } from '../../src/orchestrator/worker-registry.js';
import type { SystemTurn } from '../../src/ui/data/chatHistoryReducer.js';

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
    featureIntent: 'do thing',
    taskDescription: 'do thing',
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
  readonly props: React.ComponentProps<typeof StatusBar>;
}

interface BubbleScenario {
  readonly kind: 'bubble';
  readonly name: string;
  readonly description: string;
  readonly turn: SystemTurn;
}

type Scenario = BarScenario | BubbleScenario;

const SCENARIOS: readonly Scenario[] = [
  {
    kind: 'bar',
    name: '01-bar-away-off',
    description:
      'awayMode=false. StatusBar shows Mode / Workers / Q / Project / Session ONLY. No Away Mode segment.',
    props: {
      version: '0.0.0',
      mode: 'act',
      projects: [project({})],
      workers: [worker({}), worker({ id: 'wk-2', status: 'completed' })],
      sessionId: 'a1b2c3d4-aaaa-bbbb-cccc-dddddddddddd',
      questionsCount: 1,
      blockingCount: 0,
      awayMode: false,
      pendingQueueCount: 2,
    },
  },
  {
    kind: 'bar',
    name: '02-bar-away-on-zero-counts',
    description:
      'awayMode=true, all counts zero. Muted-gray "Away Mode — 0 done, 0 pending, 0 questions queued" segment between Project and Session.',
    props: {
      version: '0.0.0',
      mode: 'act',
      projects: [project({})],
      workers: [],
      sessionId: 'a1b2c3d4-aaaa-bbbb-cccc-dddddddddddd',
      questionsCount: 0,
      blockingCount: 0,
      awayMode: true,
      pendingQueueCount: 0,
    },
  },
  {
    kind: 'bar',
    name: '03-bar-away-on-with-counts',
    description:
      'awayMode=true, mixed counts. 4 completed + 1 running + 1 failed worker; 2 pending queued; 3 questions (1 blocking). Away segment: "4 done, 2 pending, 3 questions queued". Q-cell colored red (blocking).',
    props: {
      version: '0.0.0',
      mode: 'act',
      projects: [project({})],
      workers: [
        worker({ id: 'wk-1', status: 'completed' }),
        worker({ id: 'wk-2', status: 'completed' }),
        worker({ id: 'wk-3', status: 'completed' }),
        worker({ id: 'wk-4', status: 'completed' }),
        worker({ id: 'wk-5', status: 'running' }),
        worker({ id: 'wk-6', status: 'failed' }),
      ],
      sessionId: 'a1b2c3d4-aaaa-bbbb-cccc-dddddddddddd',
      questionsCount: 3,
      blockingCount: 1,
      awayMode: true,
      pendingQueueCount: 2,
    },
  },
  {
    kind: 'bar',
    name: '04-bar-away-on-singular-question',
    description:
      'awayMode=true, 1 question queued. Singular grammar: "1 question queued" (not "1 questions queued").',
    props: {
      version: '0.0.0',
      mode: 'act',
      projects: [project({})],
      workers: [],
      sessionId: null,
      questionsCount: 1,
      blockingCount: 0,
      awayMode: true,
      pendingQueueCount: 0,
    },
  },
  {
    kind: 'bubble',
    name: '05-bubble-away-digest',
    description:
      'SystemBubble for the on-return digest row. workerName=Symphony, projectName="", durationMs=null → NO `(project) · duration` tail. Gold ✓ glyph + bold Symphony header. "While you were away: 2 completed, 1 failed, 3 questions" headline in text-light.',
    turn: {
      kind: 'system',
      id: 'turn-1',
      ts: Date.now(),
      summary: {
        workerId: 'away-digest-1',
        workerName: 'Symphony',
        projectName: '',
        statusKind: 'completed',
        durationMs: null,
        headline: 'While you were away: 2 completed, 1 failed, 3 questions',
        fallback: false,
      },
    },
  },
  {
    kind: 'bubble',
    name: '06-bubble-away-digest-singular',
    description:
      'On-return digest with singular counts. Headline reads "While you were away: 1 completed, 1 question" — verifies formatTallyBody pluralization survives the round-trip through RPC.',
    turn: {
      kind: 'system',
      id: 'turn-2',
      ts: Date.now(),
      summary: {
        workerId: 'away-digest-2',
        workerName: 'Symphony',
        projectName: '',
        statusKind: 'completed',
        durationMs: null,
        headline: 'While you were away: 1 completed, 1 question',
        fallback: false,
      },
    },
  },
];

async function captureBar(props: React.ComponentProps<typeof StatusBar>): Promise<{ ansi: string; plain: string }> {
  const tree = (
    <ThemeProvider>
      <StatusBar {...props} />
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

async function captureBubble(turn: SystemTurn): Promise<{ ansi: string; plain: string }> {
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
    '# Phase 3M visual frames — Away Mode',
    '',
    `Generated: ${new Date().toISOString()}`,
    '',
    'Each scenario renders either the StatusBar (with awayMode prop) or',
    'a SystemBubble (with the on-return digest summary shape).',
    'Inspect `.plain.txt` for human review; `.ansi.txt` keeps the color escapes.',
    '',
    'Locked palette under review (CLAUDE.md §Symphony palette):',
    '- violet `#7C6FEB` (Symphony brand)         → `\\x1b[38;2;124;111;235m`',
    '- gold   `#D4A843` (success ✓ glyph + name) → `\\x1b[38;2;212;168;67m`',
    '- text   `#E0E0E0` (mode value, headline)   → `\\x1b[38;2;224;224;224m`',
    '- muted  `#888888` (Away segment + labels)  → `\\x1b[38;2;136;136;136m`',
    '- red    `#E06C75` (blocking Q-cell)        → `\\x1b[38;2;224;108;117m`',
    '',
    'Invariants to verify:',
    '- Away Mode segment ABSENT when awayMode=false (scenario 01)',
    '- Away Mode segment PRESENT when awayMode=true (scenarios 02-04)',
    '- Segment text is in muted-gray (`\\x1b[38;2;136;136;136m`) — NO accent color on counts',
    '- Segment sits AFTER `Project:` and BEFORE `Session:` (when session present)',
    '- "1 question queued" (singular) when count===1; "N questions queued" otherwise',
    '- Digest SystemBubble: gold ✓ + bold "Symphony" header, NO `(project) · duration` tail',
    '- Digest headline rendered in text-light, paddingLeft=2 for wrap stability (3K precedent)',
    '',
    '| Scenario | Description |',
    '|---|---|',
  ];

  for (const scenario of SCENARIOS) {
    process.stderr.write(`Capturing ${scenario.name}…\n`);
    const { ansi, plain } =
      scenario.kind === 'bar'
        ? await captureBar(scenario.props)
        : await captureBubble(scenario.turn);
    writeFileSync(path.join(OUT_DIR, `3m-${scenario.name}.ansi.txt`), ansi, 'utf8');
    writeFileSync(
      path.join(OUT_DIR, `3m-${scenario.name}.plain.txt`),
      `# ${scenario.name}\n# ${scenario.description}\n\n${plain}\n`,
      'utf8',
    );
    summary.push(`| \`${scenario.name}\` | ${scenario.description} |`);
  }

  writeFileSync(path.join(OUT_DIR, 'INDEX-3m.md'), summary.join('\n') + '\n', 'utf8');
  process.stderr.write(`\n${SCENARIOS.length} frames written to ${OUT_DIR}\n`);
}

void main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
