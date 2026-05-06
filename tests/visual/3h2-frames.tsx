/**
 * Phase 3H.2 — visual frame harness for the editable settings popup.
 *
 * Captures canonical edit states. The 3H.1 harness covers the read-only
 * variants; this one focuses on the new editor sub-states + 16-color
 * fallback variant introduced in commit 2:
 *
 *   01-idle-default            idle mode, default config (no file)
 *   02-editing-int-max-workers Enter-mode int editor active on
 *                              maxConcurrentWorkers, buffer "16"
 *   03-editing-text-path       Enter-mode text editor active on
 *                              defaultProjectPath, buffer "/home/x/proj"
 *   04-editing-int-leader      Enter-mode int editor active on
 *                              leaderTimeoutMs, buffer "500"
 *   05-16color-variant         resolved 16-color fallback theme
 *                              (verifies brand → magenta/yellow ANSI
 *                              named colors render as expected)
 *   06-cap-reached             Workers cap status (3H.2 commit 4):
 *                              maxConcurrentWorkers row at the cap
 *                              with non-default value
 *
 * `.visual-frames/3h2-<state>.{ansi,plain}.txt` + `INDEX-3h2.md`.
 */
import React, { useEffect } from 'react';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Box } from 'ink';
import { render } from 'ink-testing-library';
import { ThemeProvider } from '../../src/ui/theme/context.js';
import { FocusProvider, type FocusState } from '../../src/ui/focus/focus.js';
import { KeybindProvider } from '../../src/ui/keybinds/dispatcher.js';
import { ConfigProvider } from '../../src/utils/config-context.js';
import { ToastProvider, useToast } from '../../src/ui/feedback/ToastProvider.js';
import { ToastTray } from '../../src/ui/feedback/ToastTray.js';
import { SettingsPanel } from '../../src/ui/panels/settings/SettingsPanel.js';
import { defaultConfig, type SymphonyConfig } from '../../src/utils/config-schema.js';
import type { ConfigSource } from '../../src/utils/config.js';
import { SYMPHONY_THEME_16, resolveTheme } from '../../src/ui/theme/theme.js';

const OUT_DIR = path.resolve(process.cwd(), '.visual-frames');
const HOME = os.homedir();
const HOME_CFG = path.join(HOME, '.symphony', 'config.json');

interface Scenario {
  readonly name: string;
  readonly description: string;
  readonly config: SymphonyConfig;
  readonly source: ConfigSource;
  /**
   * Keystroke sequence to drive the popup before capture. Each entry is
   * a stdin write. The harness writes them with small settles between
   * so the editor state machine can advance.
   */
  readonly keystrokes?: readonly string[];
  /**
   * Override the resolved theme — used by the 16-color variant to
   * bypass the default truecolor SYMPHONY_THEME.
   */
  readonly themeOverride?: ReturnType<typeof resolveTheme>;
}

const SCENARIOS: readonly Scenario[] = [
  {
    name: '01-idle-default',
    description:
      'Idle mode, no config file on disk — values shown with (default), Phase 3H.2 footer hint advertises Space/Enter/navigate/close.',
    config: defaultConfig(),
    source: { kind: 'default' },
  },
  {
    name: '02-editing-int-max-workers',
    description:
      'Int editor active on maxConcurrentWorkers. Default selection on mount is modelMode (first value row); navigate down once, then Enter to open the editor; backspace clears the pre-fill "4"; type "16". Footer hint switches to "Enter commit · Esc cancel · Backspace delete".',
    config: defaultConfig(),
    source: { kind: 'default' },
    keystrokes: ['\x1b[B', '\r', '\x7f', '1', '6'],
  },
  {
    name: '03-editing-text-path',
    description:
      'Text editor active on defaultProjectPath. Navigate down 5 rows from modelMode, Enter to open, type a sample path. The cursor block is rendered inverse (\\x1b[7m).',
    config: defaultConfig(),
    source: { kind: 'default' },
    keystrokes: [
      '\x1b[B',
      '\x1b[B',
      '\x1b[B',
      '\x1b[B',
      '\x1b[B',
      '\r',
      '/',
      'h',
      'o',
      'm',
      'e',
      '/',
      'x',
      '/',
      'p',
      'r',
      'o',
      'j',
    ],
  },
  {
    name: '04-editing-int-leader',
    description:
      'Int editor active on leaderTimeoutMs (Advanced section). Navigate down 6 rows, Enter, clear the pre-fill "300", type "500".',
    config: defaultConfig(),
    source: { kind: 'default' },
    keystrokes: [
      '\x1b[B',
      '\x1b[B',
      '\x1b[B',
      '\x1b[B',
      '\x1b[B',
      '\x1b[B',
      '\r',
      '\x7f',
      '\x7f',
      '\x7f',
      '5',
      '0',
      '0',
    ],
  },
  {
    name: '05-16color-variant',
    description:
      'Theme switched to SYMPHONY_THEME_16 (audit C2 from commit 2). Brand tokens render as ANSI named colors: magenta (accent), yellow (primary), white (text + textMuted), gray (border). This is the legacy-conhost rendering path.',
    config: defaultConfig(),
    source: { kind: 'default' },
    themeOverride: resolveTheme(SYMPHONY_THEME_16),
  },
  {
    name: '06-cap-reached',
    description:
      'Workers cap status with a customized maxConcurrentWorkers value (12) — exercises the (from file) annotation path with a value that diverges from the schema default.',
    config: {
      ...defaultConfig(),
      maxConcurrentWorkers: 12,
    },
    source: { kind: 'file', path: HOME_CFG, warnings: [] },
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

const SETTINGS_FOCUS: FocusState = {
  stack: [
    { kind: 'main', key: 'chat' },
    { kind: 'popup', key: 'settings' },
  ],
};

function HarnessBody({
  config,
  source,
}: {
  readonly config: SymphonyConfig;
  readonly source: ConfigSource;
}): React.JSX.Element {
  const { showToast } = useToast();
  return (
    <ConfigProvider
      initial={{ config, source }}
      onWarning={(message) => showToast(message, { tone: 'warning', ttlMs: 6_000 })}
    >
      <FocusProvider initial={SETTINGS_FOCUS}>
        <KeybindProvider initialCommands={[]}>
          <SettingsPanel />
          <ToastTray />
        </KeybindProvider>
      </FocusProvider>
    </ConfigProvider>
  );
}

/**
 * Some scenarios drive the editor by writing keystrokes through ink-
 * testing-library's stdin. We need to settle between each write so the
 * dispatcher commits the state transition before the next key arrives.
 */
function MountReporter({ onMount }: { readonly onMount: () => void }): React.JSX.Element {
  useEffect(() => {
    onMount();
  }, [onMount]);
  return <></>;
}

async function captureScenario(scenario: Scenario): Promise<CapturedFrame> {
  const rows = 32;
  const columns = 110;
  const result = render(
    <Box flexDirection="column" height={rows} width={columns}>
      <ThemeProvider {...(scenario.themeOverride !== undefined ? { theme: scenario.themeOverride } : {})}>
        <ToastProvider>
          <MountReporter onMount={() => {}} />
          <HarnessBody config={scenario.config} source={scenario.source} />
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
    '# Phase 3H.2 visual frames',
    '',
    `Generated: ${new Date().toISOString()}`,
    '',
    'Captures the editable `<SettingsPanel>` popup across edit-state transitions plus the 16-color fallback variant.',
    '',
    'Palette references:',
    '- truecolor accent (violet) → `\\x1b[38;2;124;111;235m`',
    '- truecolor primary (gold) → `\\x1b[38;2;212;168;67m`',
    '- truecolor text → `\\x1b[38;2;224;224;224m`',
    '- truecolor textMuted → `\\x1b[38;2;136;136;136m`',
    '- 16-color accent (magenta) → `\\x1b[35m`',
    '- 16-color primary (yellow) → `\\x1b[33m`',
    '- 16-color text/textMuted (white) → `\\x1b[37m`',
    '- 16-color border (gray) → `\\x1b[90m`',
    '- inline-edit cursor → `\\x1b[7m` (inverse)',
    '',
    '| Scenario | Description |',
    '|---|---|',
  ];

  for (const scenario of SCENARIOS) {
    process.stderr.write(`Capturing ${scenario.name}…\n`);
    const { ansi, plain } = await captureScenario(scenario);
    writeFileSync(path.join(OUT_DIR, `3h2-${scenario.name}.ansi.txt`), ansi, 'utf8');
    writeFileSync(
      path.join(OUT_DIR, `3h2-${scenario.name}.plain.txt`),
      `# ${scenario.name}\n# ${scenario.description}\n\n${plain}\n`,
      'utf8',
    );
    summary.push(`| \`${scenario.name}\` | ${scenario.description} |`);
  }

  writeFileSync(path.join(OUT_DIR, 'INDEX-3h2.md'), summary.join('\n') + '\n', 'utf8');
  process.stderr.write(`\n${SCENARIOS.length} frames written to ${OUT_DIR}\n`);
}

void main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
