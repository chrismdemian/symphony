/**
 * Phase 3H.4 — visual frame harness for the keybind override editor.
 *
 * Captures the canonical states added by 3H.4:
 *
 *   01-list-default         editor list with no overrides — every row
 *                           tagged "(default)".
 *   02-list-with-overrides  editor list with two overrides applied —
 *                           tagged "(override)" + chord shows new key.
 *   03-capture-armed        capture popup, "Press a key…" hint visible.
 *   04-capture-conflict     capture popup with inline conflict error
 *                           after attempting a same-scope chord.
 *   05-capture-modifier-only-rejected  capture popup showing the
 *                           modifier-only rejection error.
 *   06-list-16color         #2 rendered against SYMPHONY_THEME_16 to
 *                           exercise the alt palette on (override)
 *                           tags + active-row chrome.
 *
 * `.visual-frames/3h4-<state>.{ansi,plain}.txt` + `INDEX-3h4.md`.
 */
import React, { useEffect } from 'react';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Box } from 'ink';
import { render } from 'ink-testing-library';
import { ThemeProvider } from '../../src/ui/theme/context.js';
import { FocusProvider, type FocusState } from '../../src/ui/focus/focus.js';
import { KeybindProvider } from '../../src/ui/keybinds/dispatcher.js';
import { ConfigProvider } from '../../src/utils/config-context.js';
import { ToastProvider, useToast } from '../../src/ui/feedback/ToastProvider.js';
import { ToastTray } from '../../src/ui/feedback/ToastTray.js';
import { KeybindEditorPopup } from '../../src/ui/panels/settings/KeybindEditorPopup.js';
import { defaultConfig, type SymphonyConfig } from '../../src/utils/config-schema.js';
import type { ConfigSource } from '../../src/utils/config.js';
import { SYMPHONY_THEME_16, resolveTheme } from '../../src/ui/theme/theme.js';
import type { Command } from '../../src/ui/keybinds/registry.js';
import { applyKeybindOverrides } from '../../src/ui/keybinds/overrides.js';
import { useConfig } from '../../src/utils/config-context.js';
import { useMemo } from 'react';

const OUT_DIR = path.resolve(process.cwd(), '.visual-frames');

interface Scenario {
  readonly name: string;
  readonly description: string;
  readonly config: SymphonyConfig;
  readonly source: ConfigSource;
  /**
   * The popup scope to mount under. List vs. capture mode is driven by
   * focus.currentScope — the same component renders both.
   */
  readonly popupKey: 'keybind-list' | 'keybind-capture';
  /**
   * Optional initial commands seeded into the dispatcher. Mirrors what
   * the editor would see in production (App.tsx + panels register).
   */
  readonly commands: readonly Command[];
  /**
   * Optional pre-typed keystrokes. For capture-mode scenarios, drive
   * the local useInput to surface the captured chord's error path.
   */
  readonly keystrokes?: readonly string[];
  readonly themeOverride?: ReturnType<typeof resolveTheme>;
}

const noop = (): void => undefined;

const sampleCommands: readonly Command[] = [
  {
    id: 'focus.cycle',
    title: 'next panel',
    key: { kind: 'tab' },
    scope: 'global',
    displayOnScreen: true,
    onSelect: noop,
  },
  {
    id: 'app.exit',
    title: 'exit',
    key: { kind: 'ctrl', char: 'c' },
    scope: 'global',
    displayOnScreen: true,
    onSelect: noop,
  },
  {
    id: 'palette.open',
    title: 'command palette',
    key: { kind: 'ctrl', char: 'p' },
    scope: 'global',
    displayOnScreen: true,
    onSelect: noop,
  },
  {
    id: 'app.help',
    title: 'help',
    key: { kind: 'char', char: '?' },
    scope: 'main',
    displayOnScreen: true,
    onSelect: noop,
  },
  {
    id: 'questions.open',
    title: 'questions',
    key: { kind: 'ctrl', char: 'q' },
    scope: 'main',
    displayOnScreen: true,
    onSelect: noop,
  },
  {
    id: 'app.config',
    title: 'settings',
    key: { kind: 'ctrl', char: ',' },
    scope: 'global',
    displayOnScreen: true,
    onSelect: noop,
  },
];

const overriddenCommands: readonly Command[] = sampleCommands.map((cmd) => {
  if (cmd.id === 'app.help') return { ...cmd, key: { kind: 'char', char: 'F' } };
  if (cmd.id === 'palette.open')
    return { ...cmd, key: { kind: 'ctrl', char: 'k' } };
  return cmd;
});

const SCENARIOS: readonly Scenario[] = [
  {
    name: '01-list-default',
    description:
      'Editor list with no overrides. Six commands surfaced; every row tagged (default). Selection on first row.',
    config: defaultConfig(),
    source: { kind: 'default' },
    popupKey: 'keybind-list',
    commands: sampleCommands,
  },
  {
    name: '02-list-with-overrides',
    description:
      'Two overrides applied: app.help → F, palette.open → Ctrl+K. Both rows tagged (override) in accent color. Other rows still (default).',
    config: {
      ...defaultConfig(),
      keybindOverrides: {
        'app.help': { kind: 'char', char: 'F' },
        'palette.open': { kind: 'ctrl', char: 'k' },
      },
    },
    source: { kind: 'file', path: '/fake/.symphony/config.json', warnings: [] },
    popupKey: 'keybind-list',
    commands: overriddenCommands,
  },
  {
    name: '03-capture-armed',
    description:
      'Capture popup armed via list → Enter on the first row (selection 0). Header shows the target command name; "Press a key…" hint in accent.',
    config: defaultConfig(),
    source: { kind: 'default' },
    popupKey: 'keybind-list',
    commands: sampleCommands,
    // Single Enter on the default-selected row pushes capture mode.
    keystrokes: ['\r'],
  },
  {
    name: '04-capture-conflict',
    description:
      'Capture flow: navigate to questions row, Enter, then press `?` (bound to app.help in main scope → conflict). Error inline in capture view: `Conflicts with "help"`.',
    config: defaultConfig(),
    source: { kind: 'default' },
    popupKey: 'keybind-list',
    commands: sampleCommands,
    // Navigate to the questions row. Sort order: scope (global, main,
    // specific) then title. Globals: command palette, exit, next
    // panel, settings. Then main: help, questions. So 'questions' is
    // the 6th row (index 5). Default selection is 0; 5 down arrows
    // lands on it. Then Enter to capture, then '?' to trigger the
    // conflict against `app.help`.
    keystrokes: ['\x1b[B', '\x1b[B', '\x1b[B', '\x1b[B', '\x1b[B', '\r', '?'],
  },
  {
    name: '05-list-after-commit',
    description:
      'Capture flow with a successful commit: navigate to first row (command palette), Enter, press `m` (no conflict). Capture pops back to list; the row now shows `m (override)`. Tests the post-commit return state.',
    config: defaultConfig(),
    source: { kind: 'default' },
    popupKey: 'keybind-list',
    commands: sampleCommands,
    // Default selection is row 0 (command palette). Enter → capture →
    // press 'm' → no other command bound to 'm' in seed → commit + pop
    // back to list. The (override) tag should now appear on row 0.
    keystrokes: ['\r', 'm'],
  },
  {
    name: '06-list-16color',
    description:
      'List with two overrides rendered against SYMPHONY_THEME_16. Active-row marker + (override) tag exercise primary (yellow → \\x1b[33m) and accent (magenta → \\x1b[35m). Covers VR-Minor2 carry-forward direction from 3H.2/3.',
    config: {
      ...defaultConfig(),
      keybindOverrides: {
        'app.help': { kind: 'char', char: 'F' },
        'palette.open': { kind: 'ctrl', char: 'k' },
      },
    },
    source: { kind: 'file', path: '/fake/.symphony/config.json', warnings: [] },
    popupKey: 'keybind-list',
    commands: overriddenCommands,
    themeOverride: resolveTheme(SYMPHONY_THEME_16),
  },
];

interface CapturedFrame {
  readonly ansi: string;
  readonly plain: string;
}

async function flushAll(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await Promise.resolve();
    await new Promise((r) => setImmediate(r));
  }
}

function focusFor(popupKey: 'keybind-list' | 'keybind-capture'): FocusState {
  return {
    stack: [
      { kind: 'main', key: 'chat' },
      // Underlying popup scope (settings) — present in production when
      // the user opens settings then opens the editor; included here
      // so the focus stack matches reality even though only the top
      // scope drives the dispatcher.
      { kind: 'popup', key: 'settings' },
      { kind: 'popup', key: popupKey },
    ],
  };
}

/**
 * Inner consumer — reads config from context and pipes raw commands
 * through `applyKeybindOverrides`. Mirrors what App.tsx does in
 * production so dynamic overrides committed via the editor reflect
 * in the popup's command list immediately.
 */
function OverriddenKeybindProvider({
  rawCommands,
  popupKey,
  children,
}: {
  readonly rawCommands: readonly Command[];
  readonly popupKey: 'keybind-list' | 'keybind-capture';
  readonly children: React.ReactNode;
}): React.JSX.Element {
  const { config } = useConfig();
  const commands = useMemo(
    () => applyKeybindOverrides(rawCommands, config.keybindOverrides),
    [rawCommands, config.keybindOverrides],
  );
  return (
    <FocusProvider initial={focusFor(popupKey)}>
      <KeybindProvider initialCommands={commands}>{children}</KeybindProvider>
    </FocusProvider>
  );
}

function HarnessBody({
  config,
  source,
  popupKey,
  commands,
}: {
  readonly config: SymphonyConfig;
  readonly source: ConfigSource;
  readonly popupKey: 'keybind-list' | 'keybind-capture';
  readonly commands: readonly Command[];
}): React.JSX.Element {
  const { showToast } = useToast();
  return (
    <ConfigProvider
      initial={{ config, source }}
      onWarning={(message) => showToast(message, { tone: 'warning', ttlMs: 6_000 })}
    >
      <OverriddenKeybindProvider rawCommands={commands} popupKey={popupKey}>
        <KeybindEditorPopup />
        <ToastTray />
      </OverriddenKeybindProvider>
    </ConfigProvider>
  );
}

function MountReporter({ onMount }: { readonly onMount: () => void }): React.JSX.Element {
  useEffect(() => {
    onMount();
  }, [onMount]);
  return <></>;
}

async function captureScenario(scenario: Scenario): Promise<CapturedFrame> {
  const rows = 36;
  const columns = 110;
  const result = render(
    <Box flexDirection="column" height={rows} width={columns}>
      <ThemeProvider
        {...(scenario.themeOverride !== undefined ? { theme: scenario.themeOverride } : {})}
      >
        <ToastProvider>
          <MountReporter onMount={() => {}} />
          <HarnessBody
            config={scenario.config}
            source={scenario.source}
            popupKey={scenario.popupKey}
            commands={scenario.commands}
          />
        </ToastProvider>
      </ThemeProvider>
    </Box>,
  );
  await flushAll();
  await new Promise((r) => setTimeout(r, 60));
  if (scenario.keystrokes !== undefined) {
    for (const k of scenario.keystrokes) {
      result.stdin.write(k);
      await new Promise((r) => setTimeout(r, 30));
    }
    await new Promise((r) => setTimeout(r, 60));
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
    '# Phase 3H.4 visual frames',
    '',
    `Generated: ${new Date().toISOString()}`,
    '',
    'Captures the `<KeybindEditorPopup>` in both list and capture modes, with and without overrides applied.',
    '',
    'Palette references (must match exactly — locked):',
    '- truecolor accent (violet) → `\\x1b[38;2;124;111;235m`',
    '- truecolor primary (gold) → `\\x1b[38;2;212;168;67m`',
    '- truecolor text → `\\x1b[38;2;224;224;224m`',
    '- truecolor textMuted → `\\x1b[38;2;136;136;136m`',
    '- 16-color accent (magenta) → `\\x1b[35m`',
    '- 16-color primary (yellow) → `\\x1b[33m`',
    '- 16-color text/textMuted (white) → `\\x1b[37m`',
    '- 16-color border (gray) → `\\x1b[90m`',
    '',
    'Skeptical reviewer focus areas:',
    '- List header reads "Keybind editor · N commands".',
    '- Each command row shows: marker (▸ when selected), title, optional [scope] badge, chord, source tag.',
    '- (override) tag renders in accent color for overridden rows; (default) in muted-gray.',
    '- Capture view shows the target command name in the header and "Press a key…" in accent.',
    '- Footer hint copy in muted-gray.',
    '- Borders use accent color.',
    '',
    '| Scenario | Description |',
    '|---|---|',
  ];

  for (const scenario of SCENARIOS) {
    process.stderr.write(`Capturing ${scenario.name}…\n`);
    const { ansi, plain } = await captureScenario(scenario);
    writeFileSync(path.join(OUT_DIR, `3h4-${scenario.name}.ansi.txt`), ansi, 'utf8');
    writeFileSync(
      path.join(OUT_DIR, `3h4-${scenario.name}.plain.txt`),
      `# ${scenario.name}\n# ${scenario.description}\n\n${plain}\n`,
      'utf8',
    );
    summary.push(`| \`${scenario.name}\` | ${scenario.description} |`);
  }

  writeFileSync(path.join(OUT_DIR, 'INDEX-3h4.md'), summary.join('\n') + '\n', 'utf8');
  process.stderr.write(`\n${SCENARIOS.length} frames written to ${OUT_DIR}\n`);
}

void main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
