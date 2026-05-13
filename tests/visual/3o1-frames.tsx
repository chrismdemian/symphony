/**
 * Phase 3O.1 — visual frame harness for the auto-merge gate.
 *
 * Two surfaces are exercised:
 *   1. The `<SettingsPanel>` autoMerge row at each of the three enum
 *      values (`ask` / `auto` / `never`), with selection on that row so
 *      the description annotation is visible.
 *   2. The chat panel `<Bubble>` (system kind) rendering each of the
 *      five AutoMergeEvent variants surfaced via the `useAutoMergeEvents`
 *      hook's KIND_TO_STATUS mapping:
 *        - merged    → ✓ (success-gold)
 *        - failed    → ✗ (error-red)
 *        - declined  → ⏱ (warning gold-light)
 *        - asked     → ⏱
 *        - ready     → ⏱
 *
 * Output: `.visual-frames/3o1-<state>.{ansi,plain}.txt` + `INDEX-3o1.md`.
 *
 * Locked palette (CLAUDE.md):
 *   - success-gold `#D4A843` → `\x1b[38;2;212;168;67m`
 *   - error-red    `#E06C75` → `\x1b[38;2;224;108;117m`
 *   - text light   `#E0E0E0` → `\x1b[38;2;224;224;224m`
 *   - muted gray   `#888888` → `\x1b[38;2;136;136;136m`
 *
 * Reviewer scope (separate skeptical subagent):
 *   - Settings popup row reads `autoMerge  <value>  (default)` and the
 *     description matches the schema doc-string for autoMerge.
 *   - Each Bubble variant uses the correct status glyph + color.
 *   - The 'merged' row with a `cleanupWarning` shows the warning as a
 *     muted-gray details sub-row, not red.
 *   - The 'declined' row with an `unclearAnswer` shows the raw answer
 *     in the details body so the user knows what was misparsed.
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
import { ConfigProvider } from '../../src/utils/config-context.js';
import { SettingsPanel } from '../../src/ui/panels/settings/SettingsPanel.js';
import { Bubble } from '../../src/ui/panels/chat/Bubble.js';
import { defaultConfig, type SymphonyConfig } from '../../src/utils/config-schema.js';
import type { ConfigSource } from '../../src/utils/config.js';
import type { SystemTurn } from '../../src/ui/data/chatHistoryReducer.js';

const OUT_DIR = path.resolve(process.cwd(), '.visual-frames');

interface Scenario {
  readonly name: string;
  readonly description: string;
  readonly element: React.ReactElement;
  /**
   * Optional keystroke sequence to inject after initial render. Used to
   * navigate selection in the SettingsPanel scenarios so the autoMerge
   * row gets focus + its description is rendered. Each entry is a raw
   * stdin byte string (e.g., `'\x1b[B'` for ↓).
   */
  readonly keystrokes?: readonly string[];
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
      durationMs: null,
      headline: 'placeholder',
      fallback: false,
      ...over,
    },
    ts: 0,
  };
}

function SettingsHarness({ autoMerge }: { autoMerge: SymphonyConfig['autoMerge'] }): React.JSX.Element {
  const initialFocus: FocusState = {
    stack: [
      { kind: 'main', key: 'chat' },
      { kind: 'popup', key: 'settings' },
    ],
  };
  const cfg: SymphonyConfig = { ...defaultConfig(), autoMerge };
  const source: ConfigSource = { kind: 'default' };
  return (
    <ThemeProvider>
      <ToastProvider>
        <ConfigProvider initial={{ config: cfg, source }}>
          <FocusProvider initial={initialFocus}>
            <KeybindProvider initialCommands={[]}>
              <Box width={80} height={30}>
                <SettingsPanel />
              </Box>
            </KeybindProvider>
          </FocusProvider>
        </ConfigProvider>
      </ToastProvider>
    </ThemeProvider>
  );
}

function BubbleHarness({ turn }: { turn: SystemTurn }): React.JSX.Element {
  return (
    <ThemeProvider>
      <Box flexDirection="column" width={80}>
        <Bubble turn={turn} />
      </Box>
    </ThemeProvider>
  );
}

const SCENARIOS: Scenario[] = [
  {
    name: '01-settings-autoMerge-ask',
    description:
      "SettingsPanel with autoMerge='ask' (default). Selection on the autoMerge row (idx 2) so the description annotation is visible. Two ↓ from the default modelMode selection.",
    element: <SettingsHarness autoMerge="ask" />,
    keystrokes: ['\x1b[B', '\x1b[B'],
  },
  {
    name: '02-settings-autoMerge-auto',
    description:
      "SettingsPanel with autoMerge='auto'. Same row + description, different value.",
    element: <SettingsHarness autoMerge="auto" />,
    keystrokes: ['\x1b[B', '\x1b[B'],
  },
  {
    name: '03-settings-autoMerge-never',
    description:
      "SettingsPanel with autoMerge='never'. Same row + description, different value.",
    element: <SettingsHarness autoMerge="never" />,
    keystrokes: ['\x1b[B', '\x1b[B'],
  },
  {
    name: '04-chat-merged-clean',
    description:
      "Chat system row for a 'merged' event (mapped to statusKind='completed'). " +
      "Gold ✓ glyph + worker name in gold-bold. Headline carries the server-formatted merge message with a 7-char sha.",
    element: (
      <BubbleHarness
        turn={makeSystemTurn({
          statusKind: 'completed',
          headline: "Merged 'feature/friend-system' into master (abc1234)",
        })}
      />
    ),
  },
  {
    name: '05-chat-merged-with-cleanup-warning',
    description:
      "Chat system row for 'merged' where worktree cleanup failed AFTER the merge succeeded. " +
      "Gold ✓ (merge wins). Details body shows the cleanup-warning string in muted-gray, indented.",
    element: (
      <BubbleHarness
        turn={makeSystemTurn({
          statusKind: 'completed',
          headline: "Merged 'feature/friend-system' into master (abc1234)",
          details: 'cleanup warning: WorktreeSafetyError: not-linked path',
        })}
      />
    ),
  },
  {
    name: '06-chat-declined-clean',
    description:
      "Chat system row for a 'declined' event (mapped to statusKind='timeout' → ⏱ warning glyph). " +
      "User answered 'n' to the merge prompt; branch left for manual review.",
    element: (
      <BubbleHarness
        turn={makeSystemTurn({
          statusKind: 'timeout',
          headline: "Left 'feature/friend-system' for manual review",
        })}
      />
    ),
  },
  {
    name: '07-chat-declined-unclear-answer',
    description:
      "Chat system row for 'declined' with an unparsed user answer. Headline names the raw input " +
      "(e.g., 'maybe'); details body shows `raw answer: 'maybe'` so the user knows what was misparsed.",
    element: (
      <BubbleHarness
        turn={makeSystemTurn({
          statusKind: 'timeout',
          headline:
            "Couldn't parse 'maybe' as y/n — left 'feature/friend-system' for manual review",
          details: "raw answer: 'maybe'",
        })}
      />
    ),
  },
  {
    name: '08-chat-asked',
    description:
      "Chat system row for an 'asked' event. ⏱ warning glyph. Headline tells the user to open the " +
      "question popup with Ctrl+Q and reply y/n.",
    element: (
      <BubbleHarness
        turn={makeSystemTurn({
          statusKind: 'timeout',
          headline:
            "Worker on 'feature/friend-system' is ready. Merge into master? (open question popup with Ctrl+Q · reply y / n)",
        })}
      />
    ),
  },
  {
    name: '09-chat-ready-never-mode',
    description:
      "Chat system row for a 'ready' event (autoMerge='never' mode). ⏱ warning glyph. Headline " +
      "tells the user the branch is ready for manual merge.",
    element: (
      <BubbleHarness
        turn={makeSystemTurn({
          statusKind: 'timeout',
          headline: "Worker on 'feature/friend-system' is ready for manual merge",
        })}
      />
    ),
  },
  {
    name: '10-chat-failed-merge-conflict',
    description:
      "Chat system row for a 'failed' event from MergeConflictError. ✗ error-red glyph. Details body " +
      "carries the typed error name + stderr tail, truncated to 120 chars.",
    element: (
      <BubbleHarness
        turn={makeSystemTurn({
          statusKind: 'failed',
          headline:
            "Merge of 'feature/friend-system' into master failed: MergeConflictError: conflict · branch left for review",
          details: 'MergeConflictError: conflict',
        })}
      />
    ),
  },
];

async function captureScenario(scenario: Scenario): Promise<{ ansi: string; plain: string }> {
  const result = render(scenario.element);
  await new Promise((r) => setImmediate(r));
  // Inject keystrokes (e.g., ↓↓ to focus the autoMerge settings row).
  // Settle between keystrokes so the dispatcher's command runs to
  // completion before the next byte arrives.
  if (scenario.keystrokes !== undefined) {
    for (const stroke of scenario.keystrokes) {
      result.stdin.write(stroke);
      await new Promise((r) => setImmediate(r));
    }
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
    '# Phase 3O.1 visual frames — Auto-Merge Workflow (gate + system Bubble)',
    '',
    `Generated: ${new Date().toISOString()}`,
    '',
    'Each scenario renders a single surface (SettingsPanel row OR chat-panel ',
    'system Bubble) under canonical states for the skeptical-subagent review. ',
    'Inspect `.plain.txt` for human review; `.ansi.txt` keeps the color ',
    'escapes (grep `\\x1b[38;2;…m` for hex codes).',
    '',
    'Locked palette under review (CLAUDE.md §Symphony palette):',
    '- success-gold `#D4A843` (`✓` + merged worker name) → `\\x1b[38;2;212;168;67m`',
    '- error-red    `#E06C75` (`✗` + failed worker name) → `\\x1b[38;2;224;108;117m`',
    '- warning gold-light (⏱ for declined / asked / ready, mapped from timeout)',
    '- text light   `#E0E0E0` (headline body) → `\\x1b[38;2;224;224;224m`',
    '- muted gray   `#888888` (project parens · duration · details) → `\\x1b[38;2;136;136;136m`',
    '',
    'AutoMergeKind → CompletionStatusKind mapping (drives Bubble glyph + color):',
    '- `merged`   → `completed` (✓ success-gold)',
    '- `failed`   → `failed`    (✗ error-red)',
    '- `declined` → `timeout`   (⏱ warning gold-light)',
    '- `asked`    → `timeout`   (⏱ warning gold-light)',
    '- `ready`    → `timeout`   (⏱ warning gold-light)',
    '',
    'Settings invariants to verify:',
    '- autoMerge row label reads "autoMerge" with value rendered in accent gold ' +
      'when source is "file", default text-light when from defaults',
    '- annotation "(from file)" or "(default)" trails the value',
    '- description matches the schema doc: "After finalize succeeds: ask = chat prompt · auto = merge + cleanup · never = leave branch"',
    '- row positioned under the "Workers" header (after maxConcurrentWorkers)',
    '',
    'Chat Bubble invariants to verify:',
    '- header line: `<icon> <workerName> (<projectName>) · <duration|(unknown)>`',
    '- icon + workerName carry the status color, bold',
    '- project parens + duration in muted-gray (NOT colored by status)',
    '- headline indented 2 spaces, text-light',
    '- details (cleanupWarning / unclearAnswer / reason) indented 2 spaces, muted-gray',
    '- multi-line headlines wrap with consistent 2-space indent (3K audit Major)',
    '- NO bordered bubble (distinct from user `❯` prefix and assistant blocks)',
    '',
    '| Scenario | Description |',
    '|---|---|',
  ];

  for (const scenario of SCENARIOS) {
    process.stderr.write(`Capturing ${scenario.name}…\n`);
    const { ansi, plain } = await captureScenario(scenario);
    writeFileSync(path.join(OUT_DIR, `3o1-${scenario.name}.ansi.txt`), ansi, 'utf8');
    writeFileSync(
      path.join(OUT_DIR, `3o1-${scenario.name}.plain.txt`),
      `# ${scenario.name}\n# ${scenario.description}\n\n${plain}\n`,
      'utf8',
    );
    summary.push(`| \`${scenario.name}\` | ${scenario.description} |`);
  }

  writeFileSync(path.join(OUT_DIR, 'INDEX-3o1.md'), summary.join('\n') + '\n', 'utf8');
  process.stderr.write(`\n${SCENARIOS.length} frames written to ${OUT_DIR}\n`);
}

void main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
