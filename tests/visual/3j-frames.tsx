/**
 * Phase 3J — visual frame harness for the diff preview view.
 *
 * Captures `<WorkerDiffView>` under canonical states for a SEPARATE
 * skeptical-subagent review. Each scenario uses `stateOverride` so the
 * frames are deterministic without an RPC roundtrip.
 *
 * Output: `.visual-frames/3j-<state>.{ansi,plain}.txt` + `INDEX-3j.md`.
 *
 * Locked diff palette:
 *   - diffAdd green `#98C379`    → `\x1b[38;2;152;195;121m` (additions)
 *   - diffRemove red `#E06C75`   → `\x1b[38;2;224;108;117m` (deletions)
 *   - diffHunk cyan `#56B6C2`    → `\x1b[38;2;86;182;194m` (`@@` headers)
 *   - diffMeta muted `#888888`   → `\x1b[38;2;136;136;136m` (`---/+++` headers)
 *   - diffContext text `#E0E0E0` → `\x1b[38;2;224;224;224m` (unchanged lines)
 *   - accent violet `#7C6FEB`    → `\x1b[38;2;124;111;235m` (header chrome)
 *   - error red                  → error banner
 *   - warning gold               → truncation banner
 */
import React from 'react';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { render } from 'ink-testing-library';
import { Box } from 'ink';
import { ThemeProvider } from '../../src/ui/theme/context.js';
import { FocusProvider, type FocusState } from '../../src/ui/focus/focus.js';
import { KeybindProvider } from '../../src/ui/keybinds/dispatcher.js';
import { ConfigProvider } from '../../src/utils/config-context.js';
import { defaultConfig } from '../../src/utils/config-schema.js';
import { WorkerDiffView } from '../../src/ui/panels/output/WorkerDiffView.js';
import type { ConfigSource } from '../../src/utils/config.js';
import type { TuiRpc } from '../../src/ui/runtime/rpc.js';
import type { WorkersDiffResult } from '../../src/rpc/router-impl.js';
import type { WorkerDiffState } from '../../src/ui/data/useWorkerDiff.js';

const OUT_DIR = path.resolve(process.cwd(), '.visual-frames');

function makeRpc(): TuiRpc {
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
        tail: async () => ({ events: [], total: 0 }),
        diff: async () => {
          throw new Error('unused — stateOverride bypasses the hook');
        },
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
        setModel: async () => ({ modelMode: 'opus' as const, warnings: [] }),
      },
      notifications: {
        flushAwayDigest: async () => {},
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    subscribe: async () => ({ topic: 'noop', unsubscribe: async () => {} }),
    close: async () => {},
  };
}

const FROZEN_NOW = (): number => 1_700_000_010_000;
const FROZEN_FETCHED_AT = 1_700_000_000_000;

function frozenResult(over: Partial<WorkersDiffResult> = {}): WorkersDiffResult {
  return {
    resolvedBase: 'main',
    mergeBaseSha: 'abc1234567890abcdef1234567890abcdef12345',
    branch: 'feature/lru-cache',
    diff: '',
    bytes: 0,
    truncated: false,
    cappedAt: null,
    files: [],
    ...over,
  };
}

interface Scenario {
  readonly name: string;
  readonly description: string;
  readonly state: WorkerDiffState;
}

const SCENARIOS: Scenario[] = [
  {
    name: '01-loading-no-previous',
    description:
      'First fetch in flight; nothing rendered yet. Equalizer spinner + "Computing diff…" hint.',
    state: { kind: 'loading' },
  },
  {
    name: '02-empty-clean-tree',
    description:
      'Resolved with empty diff body — worktree matches base. Header still renders, body shows "(no changes vs main@abc1234)".',
    state: {
      kind: 'ready',
      data: frozenResult({ diff: '', bytes: 0, files: [] }),
      fetchedAt: FROZEN_FETCHED_AT,
    },
  },
  {
    name: '03-small-mixed-diff',
    description:
      'One file with adds + removes + a hunk header. Standard unified-diff convention; verify per-line colors against the locked palette.',
    state: {
      kind: 'ready',
      data: frozenResult({
        diff:
          '--- a/src/cache.ts\n' +
          '+++ b/src/cache.ts\n' +
          '@@ -10,6 +10,8 @@\n' +
          ' export class Cache {\n' +
          '-  // old field\n' +
          '-  private store = new Map();\n' +
          '+  // new field\n' +
          '+  private store = new LRU();\n' +
          '+  private hits = 0;\n' +
          '   constructor() {}\n' +
          ' }\n',
        bytes: 220,
        files: [{ path: 'src/cache.ts', status: 'M' }],
      }),
      fetchedAt: FROZEN_FETCHED_AT,
    },
  },
  {
    name: '04-untracked-file',
    description:
      'New file shows up in the file list as `??` and a synthetic untracked block at the bottom of the body. Header summary should include `1??` in the file-status counts.',
    state: {
      kind: 'ready',
      data: frozenResult({
        diff:
          '\n\n=== untracked files (1) ===\n?? src/new-feature.ts\n',
        bytes: 50,
        files: [{ path: 'src/new-feature.ts', status: '??' }],
      }),
      fetchedAt: FROZEN_FETCHED_AT,
    },
  },
  {
    name: '05-truncated',
    description:
      'Diff body capped above the size limit. Truncation banner sits above the body in warning gold; banner shows the cap (256000) and total bytes (600000).',
    state: {
      kind: 'ready',
      data: frozenResult({
        diff:
          '--- a/src/big.ts\n+++ b/src/big.ts\n@@ -1,3 +1,3 @@\n' +
          '-' +
          'x'.repeat(80) +
          '\n+' +
          'y'.repeat(80) +
          '\n',
        bytes: 600_000,
        truncated: true,
        cappedAt: 256_000,
        files: [{ path: 'src/big.ts', status: 'M' }],
      }),
      fetchedAt: FROZEN_FETCHED_AT,
    },
  },
  {
    name: '06-error',
    description:
      'Diff fetch failed; red error banner with retry hint. No previous data so no chrome below.',
    state: {
      kind: 'error',
      error: new Error('git error: merge-base failed: unknown ref'),
    },
  },
  {
    name: '07-error-with-stale',
    description:
      'Refresh failed but a previous successful fetch is still on screen. Error banner above; "(stale)" suffix on the header; previous diff body still readable.',
    state: {
      kind: 'error',
      error: new Error('git error: connection reset'),
      previous: frozenResult({
        diff:
          '--- a/src/auth.ts\n' +
          '+++ b/src/auth.ts\n' +
          '@@ -1 +1 @@\n' +
          '-export const token = "old";\n' +
          '+export const token = "new";\n',
        bytes: 80,
        files: [{ path: 'src/auth.ts', status: 'M' }],
      }),
    },
  },
  {
    name: '08-mixed-statuses',
    description:
      'Multiple files with different statuses (M, A, D, ??). Header summary should sort statuses alphabetically (?, A, D, M).',
    state: {
      kind: 'ready',
      data: frozenResult({
        diff:
          '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n' +
          '--- /dev/null\n+++ b/src/b.ts\n@@ -0,0 +1,2 @@\n+const NEW = 1;\n+export { NEW };\n' +
          '--- a/src/c.ts\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-const OLD = 0;\n-export { OLD };\n' +
          '\n=== untracked files (1) ===\n?? src/scratch.txt\n',
        bytes: 350,
        files: [
          { path: 'src/a.ts', status: 'M' },
          { path: 'src/b.ts', status: 'A' },
          { path: 'src/c.ts', status: 'D' },
          { path: 'src/scratch.txt', status: '??' },
        ],
      }),
      fetchedAt: FROZEN_FETCHED_AT,
    },
  },
];

const initialFocus: FocusState = { stack: [{ kind: 'main', key: 'output' }] };
const initialSource: ConfigSource = { kind: 'file', path: '/x', warnings: [] };

async function captureScenario(scenario: Scenario): Promise<{ ansi: string; plain: string }> {
  const tree = (
    <ConfigProvider initial={{ config: defaultConfig(), source: initialSource }}>
      <ThemeProvider>
        <FocusProvider initial={initialFocus}>
          <KeybindProvider initialCommands={[]}>
            <Box flexDirection="column" width={70} height={24}>
              <WorkerDiffView
                rpc={makeRpc()}
                workerId="wk-1"
                isFocused={false}
                now={FROZEN_NOW}
                stateOverride={scenario.state}
              />
            </Box>
          </KeybindProvider>
        </FocusProvider>
      </ThemeProvider>
    </ConfigProvider>
  );

  const result = render(tree);
  await new Promise((r) => setImmediate(r));
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
    '# Phase 3J visual frames — Diff Preview',
    '',
    `Generated: ${new Date().toISOString()}`,
    '',
    'Each scenario renders `<WorkerDiffView>` with a pinned state override so',
    'the harness exercises the rendering branches without an RPC roundtrip.',
    'Inspect `.plain.txt` for human review; `.ansi.txt` keeps the color',
    'escapes (grep `\\x1b[38;2;…m` for hex codes).',
    '',
    'Locked diff palette under review:',
    '- diffAdd green `#98C379` (additions, `+lines`) → `\\x1b[38;2;152;195;121m`',
    '- diffRemove red `#E06C75` (deletions, `-lines`) → `\\x1b[38;2;224;108;117m`',
    '- diffHunk cyan `#56B6C2` (`@@ ... @@` hunk headers) → `\\x1b[38;2;86;182;194m`',
    '- diffMeta muted `#888888` (`---`/`+++` file headers, `\\ No newline`) → `\\x1b[38;2;136;136;136m`',
    '- diffContext text `#E0E0E0` (unchanged lines) → `\\x1b[38;2;224;224;224m`',
    '- accent violet `#7C6FEB` (header chrome `Diff vs main@…`) → `\\x1b[38;2;124;111;235m`',
    '- warning gold (truncation banner) → ANSI gold',
    '- error red (error banner) → ANSI red',
    '',
    'Layout invariants to verify:',
    '- header line `Diff vs <branch>@<sha7> · N file(s): <counts> · <bytes> · captured Ns ago` renders in violet',
    '- truncated state has the gold `⚠ Diff truncated …` banner ABOVE the body',
    '- error banner has `✗ <message> — press r to retry` in red',
    '- error-with-stale state shows BOTH the red banner AND the stale header (`(stale)` suffix) AND the previous diff body',
    '- empty body shows `(no changes vs <branch>@<sha7>)` in muted gray',
    '- diff body lines colored per the palette (greens for `+`, reds for `-`, cyan for `@@`, muted for file headers)',
    '',
    '| Scenario | Description |',
    '|---|---|',
  ];

  for (const scenario of SCENARIOS) {
    process.stderr.write(`Capturing ${scenario.name}…\n`);
    const { ansi, plain } = await captureScenario(scenario);
    writeFileSync(path.join(OUT_DIR, `3j-${scenario.name}.ansi.txt`), ansi, 'utf8');
    writeFileSync(
      path.join(OUT_DIR, `3j-${scenario.name}.plain.txt`),
      `# ${scenario.name}\n# ${scenario.description}\n\n${plain}\n`,
      'utf8',
    );
    summary.push(`| \`${scenario.name}\` | ${scenario.description} |`);
  }

  writeFileSync(path.join(OUT_DIR, 'INDEX-3j.md'), summary.join('\n') + '\n', 'utf8');
  process.stderr.write(`\n${SCENARIOS.length} frames written to ${OUT_DIR}\n`);
}

void main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
