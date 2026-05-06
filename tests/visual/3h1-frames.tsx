/**
 * Phase 3H.1 — visual frame harness for the read-only settings popup.
 *
 * Captures canonical states across the source/value matrix:
 *   01-default-no-file        no config.json on disk → defaults + (default) tags
 *   02-from-file-customized   file exists with all fields customized → (from file) tags
 *   03-long-default-project   defaultProjectPath set to a typical long Win32 path
 *   04-many-keybinds          keybindOverrides with several entries → counter
 *   05-load-warning           ConfigSource has warnings → toast tray surfaces them
 *   06-source-line            confirms the bottom source-line variant
 *
 * `.visual-frames/3h1-<state>.{ansi,plain}.txt` + `INDEX-3h1.md`.
 */
import React from 'react';
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

const OUT_DIR = path.resolve(process.cwd(), '.visual-frames');
// Use the harness process's actual home so the SettingsPanel's
// `displayPath` collapses the source-line correctly across platforms
// (Win32 `C:\Users\chris\...` ↔ POSIX `/home/<user>/...`).
const HOME = os.homedir();
const HOME_CFG = path.join(HOME, '.symphony', 'config.json');

interface Scenario {
  readonly name: string;
  readonly description: string;
  readonly config: SymphonyConfig;
  readonly source: ConfigSource;
}

const SCENARIOS: readonly Scenario[] = [
  {
    name: '01-default-no-file',
    description:
      'No config.json on disk — all values rendered with the (default) annotation. Source line shows "(no file — using defaults)".',
    config: defaultConfig(),
    source: { kind: 'default' },
  },
  {
    name: '02-from-file-customized',
    description:
      'config.json exists with every field customized (including keybindOverrides) — values rendered with the (from file) annotation in violet. Source line shows the home-relative path.',
    config: {
      ...defaultConfig(),
      modelMode: 'opus',
      maxConcurrentWorkers: 12,
      notifications: { enabled: true },
      theme: { name: 'symphony', autoFallback16Color: false },
      defaultProjectPath: path.join(HOME, 'projects', 'laurus'),
      leaderTimeoutMs: 500,
      keybindOverrides: {
        'palette.open': { kind: 'ctrl', char: 'o' },
        'app.help': { kind: 'char', char: 'h' },
      },
    },
    source: {
      kind: 'file',
      path: HOME_CFG,
      warnings: [],
    },
  },
  {
    name: '03-long-default-project',
    description:
      'Default project path is a long path. Renders single-line; the row extends past the popup\'s natural width as a documented ragged-border quirk (Palette frames show the same pattern).',
    config: {
      ...defaultConfig(),
      defaultProjectPath: 'C:\\Users\\chris\\projects\\very-long-project-name-that-could-wrap',
    },
    source: { kind: 'file', path: HOME_CFG, warnings: [] },
  },
  {
    name: '04-many-keybinds',
    description:
      'keybindOverrides record with multiple entries — counter shows entry count rather than expanding inline.',
    config: {
      ...defaultConfig(),
      keybindOverrides: {
        'palette.open': { kind: 'ctrl', char: 'o' },
        'app.help': { kind: 'char', char: 'h' },
        'app.config': { kind: 'ctrl', char: ',' },
        'leader.modeSwitch': {
          kind: 'leader',
          lead: { kind: 'ctrl', char: 'x' },
          second: { kind: 'char', char: 'm' },
        },
      },
    },
    source: { kind: 'file', path: HOME_CFG, warnings: [] },
  },
  {
    name: '05-load-warning',
    description:
      'ConfigSource carries warnings — the ToastBoundConfigProvider surfaces them via the toast tray (gold-light goldLight token, not the locked gold; per theme.ts:58 warning maps to goldLight which is a project-defined secondary token). SettingsPanel body does NOT repeat warnings.',
    config: defaultConfig(),
    source: {
      kind: 'file',
      path: HOME_CFG,
      warnings: [
        'config.json field "maxConcurrentWorkers": Number must be greater than or equal to 1 — using default',
      ],
    },
  },
  {
    name: '06-source-line-explicit-path',
    description:
      'Source line variant — absolute path that does NOT live under $HOME, so the home-collapse falls through.',
    config: defaultConfig(),
    source: {
      kind: 'file',
      path: process.platform === 'win32' ? 'C:\\ProgramData\\symphony\\config.json' : '/etc/symphony/config.json',
      warnings: [],
    },
  },
];

interface CapturedFrame {
  readonly ansi: string;
  readonly plain: string;
}

async function flushAll(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
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

/**
 * In production the App's `ToastBoundConfigProvider` wires
 * `<ConfigProvider onWarning>` → `useToast().showToast`. Tests have to
 * compose the same bridge manually so the warnings flow into the toast
 * tray for the visual harness.
 */
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

async function captureScenario(scenario: Scenario): Promise<CapturedFrame> {
  const rows = 32;
  const columns = 110;
  const result = render(
    <Box flexDirection="column" height={rows} width={columns}>
      <ThemeProvider>
        <ToastProvider>
          <HarnessBody config={scenario.config} source={scenario.source} />
        </ToastProvider>
      </ThemeProvider>
    </Box>,
  );
  await flushAll();
  // Wait for the warning toast to render after the ConfigProvider mount-effect.
  await new Promise((r) => setTimeout(r, 60));
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
    '# Phase 3H.1 visual frames',
    '',
    `Generated: ${new Date().toISOString()}`,
    '',
    'Each scenario captures the read-only `<SettingsPanel>` popup under canonical states.',
    'Inspect `.plain.txt` for human-readable review; `.ansi.txt` keeps escapes for hex-code grep.',
    '',
    'Palette referenced (locked, do not change):',
    '- `accent` (border, header, "(from file)" values) → violet `#7C6FEB` → `\\x1b[38;2;124;111;235m`',
    '- `text` (default value column, labels) → light gray `#E0E0E0` → `\\x1b[38;2;224;224;224m`',
    '- `textMuted` (section headers, source line, hints, "(default)" tag) → muted `#888888` → `\\x1b[38;2;136;136;136m`',
    '- `warning` (toast tray when warnings present) → gold `#D4A843` → `\\x1b[38;2;212;168;67m`',
    '',
    'Popup scope: `settings`. Internal nav commands (Esc/↑↓/Enter) registered with `internal: true` so the command palette does not list them.',
    '',
    '| Scenario | Description |',
    '|---|---|',
  ];

  for (const scenario of SCENARIOS) {
    process.stderr.write(`Capturing ${scenario.name}…\n`);
    const { ansi, plain } = await captureScenario(scenario);
    writeFileSync(path.join(OUT_DIR, `3h1-${scenario.name}.ansi.txt`), ansi, 'utf8');
    writeFileSync(
      path.join(OUT_DIR, `3h1-${scenario.name}.plain.txt`),
      `# ${scenario.name}\n# ${scenario.description}\n\n${plain}\n`,
      'utf8',
    );
    summary.push(`| \`${scenario.name}\` | ${scenario.description} |`);
  }

  writeFileSync(path.join(OUT_DIR, 'INDEX-3h1.md'), summary.join('\n') + '\n', 'utf8');
  process.stderr.write(`\n${SCENARIOS.length} frames written to ${OUT_DIR}\n`);
}

void main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
