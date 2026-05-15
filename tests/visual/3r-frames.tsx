/**
 * Phase 3R — visual frame harness for the audit-log popup.
 *
 * Exercises `<LogPanel>` under canonical states: empty, populated
 * multi-kind, type-filtered, project-filtered, day-divider spanning,
 * parse-error row, unknown-project warning, severity-tone mix.
 *
 * Output: `.visual-frames/3r-<state>.{ansi,plain}.txt` + `INDEX-3r.md`.
 *
 * Locked palette (CLAUDE.md §Symphony palette):
 *   - success-gold `#D4A843` (✓ completed/merged)  → `\x1b[38;2;212;168;67m`
 *   - violet/accent `#7C6FEB` (● spawned, title)    → `\x1b[38;2;124;111;235m`
 *   - error-red    `#E06C75` (✗ failed, ⚠ error)    → `\x1b[38;2;224;108;117m`
 *   - text light   `#E0E0E0` (headline body)        → `\x1b[38;2;224;224;224m`
 *   - muted gray   `#888888` (ts, kind col, divider)→ `\x1b[38;2;136;136;136m`
 *   - warn amber is the established theme 'warning' token (= `goldLight`
 *     `#E5C07B` → `\x1b[38;2;229;192;123m`), DISTINCT from success-gold
 *     `#D4A843`. This is the SAME token DepsPanel/StatsPanel/every prior
 *     3x popup uses for the warning tone (see DepsPanel.tsx toneColor +
 *     theme.ts `warning: 'goldLight'`). Not a palette violation — the
 *     CLAUDE.md locked palette is the 5 brand-core colors; `theme.warning`
 *     is a derived semantic token in use codebase-wide since early phases.
 *
 * Reviewer scope (separate skeptical subagent):
 *   - Title "Audit log" accent/violet bold; "· N entries" muted.
 *   - Filter row `filter> <text>█` — prompt muted, text light, inverse
 *     cursor block (`\x1b[7m`).
 *   - Day-divider rows `── <Wkdy Mon D> ──` in muted-gray, emitted once
 *     per date change, before the first row of that day.
 *   - Each entry row: `▸/  ` selection caret (accent when selected),
 *     `HH:MM:SS` muted, glyph+kind in the kind's tone, headline
 *     text-light.
 *   - Severity tone override: a `warn` row reads gold, an `error` row
 *     reads red, regardless of the kind's base tone.
 *   - Parse-error rows: muted `⚠ <message>` lines.
 *   - Unknown-project notice: warning-tone single line.
 *   - Footer: muted "↑↓ scroll · type to filter · Ctrl+U clear · Esc close".
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
import { LogPanel } from '../../src/ui/panels/audit/LogPanel.js';
import type { TuiRpc } from '../../src/ui/runtime/rpc.js';
import type { ProjectSnapshot } from '../../src/projects/types.js';
import type {
  AuditEntry,
  AuditKind,
  AuditSeverity,
} from '../../src/state/audit-store.js';

const OUT_DIR = path.resolve(process.cwd(), '.visual-frames');

let nextId = 1;
function entry(
  kind: AuditKind,
  headline: string,
  ts: string,
  severity: AuditSeverity = 'info',
  extra: Partial<AuditEntry> = {},
): AuditEntry {
  return {
    id: nextId++,
    ts,
    kind,
    severity,
    projectId: null,
    workerId: null,
    taskId: null,
    toolName: null,
    headline,
    payload: {},
    ...extra,
  };
}

function project(id: string, name: string): ProjectSnapshot {
  return { id, name, path: `/tmp/${id}`, createdAt: '2026-05-14T00:00:00.000Z' };
}

function makeStubRpc(
  entries: readonly AuditEntry[],
  projects: readonly ProjectSnapshot[],
): TuiRpc {
  const audit = {
    list: async (): Promise<readonly AuditEntry[]> => entries,
    count: async (): Promise<number> => entries.length,
  };
  const projectsCall = {
    list: async (): Promise<readonly ProjectSnapshot[]> => projects,
  };
  return {
    call: { audit, projects: projectsCall },
    subscribe: async () => ({ unsubscribe: async () => {} }),
  } as unknown as TuiRpc;
}

function LogHarness({
  entries,
  projects,
}: {
  entries: readonly AuditEntry[];
  projects: readonly ProjectSnapshot[];
}): React.JSX.Element {
  const initialFocus: FocusState = {
    stack: [
      { kind: 'main', key: 'chat' },
      { kind: 'popup', key: 'log' },
    ],
  };
  return (
    <ThemeProvider>
      <ToastProvider>
        <FocusProvider initial={initialFocus}>
          <KeybindProvider initialCommands={[]}>
            <Box width={100} height={30}>
              <LogPanel rpc={makeStubRpc(entries, projects)} />
            </Box>
          </KeybindProvider>
        </FocusProvider>
      </ToastProvider>
    </ThemeProvider>
  );
}

const DAY1 = '2026-05-14';
const DAY2 = '2026-05-13';
const PROJECTS = [project('p1', 'MathScrabble'), project('p2', 'Frontend')];

function multiKind(): readonly AuditEntry[] {
  nextId = 1;
  return [
    entry('worker_spawned', 'spawned: add friend-list UI', `${DAY1}T14:23:01.000Z`, 'info', {
      projectId: 'p1',
      workerId: 'w-7a3b9',
    }),
    entry('tool_called', 'tool spawn_worker · tier 2 · ok', `${DAY1}T14:23:02.000Z`, 'info', {
      toolName: 'spawn_worker',
    }),
    entry('question_asked', 'question asked: which DB driver?', `${DAY1}T14:24:10.000Z`),
    entry('question_answered', 'question answered: which DB driver?', `${DAY1}T14:25:55.000Z`),
    entry('tool_denied', 'tool create_worktree · tier 1 · denied (capability policy)', `${DAY1}T14:26:00.000Z`, 'warn', { toolName: 'create_worktree' }),
    entry('worker_completed', 'completed: add friend-list UI', `${DAY1}T14:31:12.000Z`, 'info', {
      projectId: 'p1',
      workerId: 'w-7a3b9',
    }),
    entry('merge_performed', 'merged feature/friend-list → master', `${DAY1}T14:31:40.000Z`, 'info'),
    entry('tier_changed', 'autonomy tier 2 → 1', `${DAY1}T14:33:00.000Z`),
    entry('worker_failed', 'failed: flaky integration test', `${DAY1}T14:40:09.000Z`, 'error', {
      projectId: 'p2',
      workerId: 'w-c4d5e',
    }),
    entry('error', 'dispatcher onError: ECONNRESET in completions broker', `${DAY1}T14:41:00.000Z`, 'error'),
  ];
}

function severityMix(): readonly AuditEntry[] {
  nextId = 1;
  return [
    entry('tool_called', 'tool think · tier 2 · ok', `${DAY1}T10:00:01.000Z`, 'info', { toolName: 'think' }),
    entry('tool_denied', 'tool finalize · tier 1 · denied (capability policy)', `${DAY1}T10:00:02.000Z`, 'warn', { toolName: 'finalize' }),
    entry('tool_error', 'tool review_diff · tier 2 · error (GitOpsError)', `${DAY1}T10:00:03.000Z`, 'error', { toolName: 'review_diff' }),
    // A normally-success kind under warn severity should read gold:
    entry('worker_completed', 'completed (with cleanup warning)', `${DAY1}T10:00:04.000Z`, 'warn'),
    // A normally-muted kind under error severity should read red:
    entry('tool_called', 'tool spawn_worker · tier 3 · error path', `${DAY1}T10:00:05.000Z`, 'error', { toolName: 'spawn_worker' }),
  ];
}

function twoDays(): readonly AuditEntry[] {
  nextId = 1;
  return [
    entry('worker_completed', 'completed: yesterday task', `${DAY2}T23:50:00.000Z`),
    entry('merge_performed', 'merged feature/late-night → master', `${DAY2}T23:55:00.000Z`),
    entry('worker_spawned', 'spawned: today task', `${DAY1}T08:01:00.000Z`),
    entry('worker_completed', 'completed: today task', `${DAY1}T08:30:00.000Z`),
  ];
}

interface Scenario {
  readonly name: string;
  readonly description: string;
  readonly element: React.ReactElement;
  /** Optional keystrokes to type into the filter row after mount. */
  readonly type?: string;
}

const SCENARIOS: Scenario[] = [
  {
    name: '01-empty-no-filter',
    description:
      'LogPanel with zero entries and no filter. Empty-state hint reads "No audit entries yet. Actions are logged here as they happen." Filter row shows empty `filter> █`.',
    element: <LogHarness entries={[]} projects={PROJECTS} />,
  },
  {
    name: '02-populated-multi-kind',
    description:
      'Ten entries across one day spanning every category: spawned (● accent), tool_called (· muted), question_asked (? accent), question_answered (✓ gold), tool_denied (⊘ warn-gold), completed (✓ gold), merged (✓ gold), tier_changed (⚙ muted), failed (✗ red), error (⚠ red). One day-divider at top. First row selected (▸ accent caret).',
    element: <LogHarness entries={multiKind()} projects={PROJECTS} />,
  },
  {
    name: '03-severity-tone-override',
    description:
      'Five rows proving severity overrides the kind base tone: info tool_called (muted ·), warn tool_denied (gold ⊘), error tool_error (red ✗), worker_completed under WARN (gold ✓ — not its usual success-gold-by-base but warning tone), tool_called under ERROR (red · — muted base overridden).',
    element: <LogHarness entries={severityMix()} projects={PROJECTS} />,
  },
  {
    name: '04-day-divider-spanning',
    description:
      'Four entries spanning two calendar days. TWO day-divider rows: "── <DAY2 label> ──" before the first two rows, "── <DAY1 label> ──" before the last two. Dividers muted-gray, emitted exactly once per date change.',
    element: <LogHarness entries={twoDays()} projects={PROJECTS} />,
  },
  {
    name: '05-type-filter-merge',
    description:
      'Multi-kind dataset, filter row typed `--type merge`. The filter row shows the typed text; the stub returns the full set (panel does not re-filter client-side — RPC does), so this frame verifies the FILTER ROW rendering + that `--type merge` produces NO parse-error row (valid alias).',
    element: <LogHarness entries={multiKind()} projects={PROJECTS} />,
    type: '--type merge',
  },
  {
    name: '06-parse-error-row',
    description:
      'Filter typed `--last bogus`. A muted "⚠ invalid --last duration: \\"bogus\\"" row renders between the filter row and the entries. Entries still display (parse error is non-fatal).',
    element: <LogHarness entries={multiKind()} projects={PROJECTS} />,
    type: '--last bogus',
  },
  {
    name: '07-unknown-project',
    description:
      'Filter typed `--project Nonexistent`. A warning-tone "Unknown project \\"Nonexistent\\" — no rows match." line renders; entry list is empty (the hook short-circuits to [] for an unresolved project name).',
    element: <LogHarness entries={multiKind()} projects={PROJECTS} />,
    type: '--project Nonexistent',
  },
  {
    name: '08-filter-with-valid-flags',
    description:
      'Filter typed `--type tool,merge --severity warn`. No parse-error rows (all valid). Verifies the filter row renders a longer composite filter string without overflow and the cursor block trails it.',
    element: <LogHarness entries={multiKind()} projects={PROJECTS} />,
    type: '--type tool,merge --severity warn',
  },
];

function stripAnsi(input: string): string {
  // eslint-disable-next-line no-control-regex
  return input.replace(/\x1b\[[\d;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
}

async function captureScenario(
  scenario: Scenario,
): Promise<{ ansi: string; plain: string }> {
  const result = render(scenario.element);
  for (let i = 0; i < 8; i += 1) await new Promise((r) => setImmediate(r));
  await new Promise((r) => setTimeout(r, 0));
  for (let i = 0; i < 8; i += 1) await new Promise((r) => setImmediate(r));
  if (scenario.type !== undefined) {
    // Type the filter one char at a time (ink-testing-library delivers
    // each write as an input event; the panel's local useInput appends).
    for (const ch of scenario.type) {
      result.stdin.write(ch);
      await new Promise((r) => setImmediate(r));
    }
    for (let i = 0; i < 8; i += 1) await new Promise((r) => setImmediate(r));
    await new Promise((r) => setTimeout(r, 0));
    for (let i = 0; i < 8; i += 1) await new Promise((r) => setImmediate(r));
  }
  const ansi = result.lastFrame() ?? '';
  const plain = stripAnsi(ansi);
  result.unmount();
  return { ansi, plain };
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  const summary: string[] = [
    '# Phase 3R visual frames — Audit Log',
    '',
    `Generated: ${new Date().toISOString()}`,
    '',
    'Each scenario renders `<LogPanel>` under a canonical state for the ',
    'skeptical-subagent review. `.plain.txt` for human review; `.ansi.txt` ',
    'keeps escapes (grep `\\x1b[38;2;…m` for hex codes; `\\x1b[7m` = inverse ',
    'cursor block).',
    '',
    'Locked palette under review:',
    '- success-gold `#D4A843` → `\\x1b[38;2;212;168;67m`',
    '- violet/accent `#7C6FEB` → `\\x1b[38;2;124;111;235m`',
    '- error-red `#E06C75` → `\\x1b[38;2;224;108;117m`',
    '- text light `#E0E0E0` → `\\x1b[38;2;224;224;224m`',
    '- muted gray `#888888` → `\\x1b[38;2;136;136;136m`',
    '',
    'LogPanel invariants to verify:',
    '- title "Audit log" accent/violet + bold; "· N entries" muted',
    '- filter row: `filter> ` muted, typed text light, inverse cursor `\\x1b[7m`',
    '- day-divider `── <label> ──` muted, once per date change',
    '- row: caret (▸ accent when selected / 2 spaces else), HH:MM:SS muted,',
    '  glyph+kind in the kind tone, headline text-light',
    '- severity override: warn→theme.warning amber `#E5C07B` (NOT',
    '  success-gold `#D4A843`; same token DepsPanel uses), error→red,',
    '  regardless of kind base tone',
    '- parse-error rows muted `⚠ <msg>`; unknown-project warning-tone line',
    '- footer muted "↑↓ scroll · type to filter · Ctrl+U clear · Esc close"',
    '',
    '| Scenario | Description |',
    '|---|---|',
  ];

  for (const scenario of SCENARIOS) {
    process.stderr.write(`Capturing ${scenario.name}…\n`);
    const { ansi, plain } = await captureScenario(scenario);
    writeFileSync(path.join(OUT_DIR, `3r-${scenario.name}.ansi.txt`), ansi, 'utf8');
    writeFileSync(
      path.join(OUT_DIR, `3r-${scenario.name}.plain.txt`),
      `# ${scenario.name}\n# ${scenario.description}\n\n${plain}\n`,
      'utf8',
    );
    summary.push(`| \`${scenario.name}\` | ${scenario.description} |`);
  }

  writeFileSync(path.join(OUT_DIR, 'INDEX-3r.md'), summary.join('\n') + '\n', 'utf8');
  process.stderr.write(`\n${SCENARIOS.length} frames written to ${OUT_DIR}\n`);
}

void main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
