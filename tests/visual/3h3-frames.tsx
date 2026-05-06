/**
 * Phase 3H.3 — visual frame harness for the notifications + awayMode
 * settings rows.
 *
 * Captures the canonical states added by 3H.3:
 *
 *   01-notifications-on-default  notifications.enabled = true, awayMode = false
 *   02-awayMode-on-default       notifications.enabled = false, awayMode = true
 *   03-both-on                   both flags on (most active state)
 *   04-both-on-16color           same as #3 but resolved against
 *                                SYMPHONY_THEME_16 (covers VR-Minor2
 *                                from 3H.2 review: primary token in
 *                                16-color via active row + footer)
 *   05-default-baseline          everything default for diff-vs-3h2
 *
 * `.visual-frames/3h3-<state>.{ansi,plain}.txt` + `INDEX-3h3.md`.
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
  readonly keystrokes?: readonly string[];
  readonly themeOverride?: ReturnType<typeof resolveTheme>;
}

const SCENARIOS: readonly Scenario[] = [
  {
    name: '01-notifications-on-default',
    description:
      'notifications.enabled = true, awayMode = false. Source is a saved file (so the (from file) annotation appears next to enabled). Selection navigated DOWN 4× to land on notifications.enabled so the new restraint-policy description is rendered (visual review Major-4).',
    config: { ...defaultConfig(), notifications: { enabled: true } },
    source: { kind: 'file', path: HOME_CFG, warnings: [] },
    // Navigate from modelMode (index 1 in the flat list) through the 4
    // value rows above notifications.enabled: maxConcurrentWorkers,
    // theme.name, theme.autoFallback16Color → notifications.enabled.
    keystrokes: ['\x1b[B', '\x1b[B', '\x1b[B', '\x1b[B'],
  },
  {
    name: '02-awayMode-on-default',
    description:
      'awayMode = true with notifications.enabled = false. The awayMode row shows true; user understands suppression is in effect even though notifications are off (defensive — UI surfaces the truth).',
    config: { ...defaultConfig(), awayMode: true },
    source: { kind: 'file', path: HOME_CFG, warnings: [] },
  },
  {
    name: '03-both-on',
    description:
      'notifications.enabled = true AND awayMode = true. Most active state — toggling awayMode off would dispatch the digest. Selection navigated to the awayMode row to exercise the highlighted-bool render path.',
    config: {
      ...defaultConfig(),
      notifications: { enabled: true },
      awayMode: true,
    },
    source: { kind: 'file', path: HOME_CFG, warnings: [] },
    // Navigate from modelMode (index 1) down through value rows to land
    // on awayMode (the 6th value row). 5 down arrows: maxConcurrentWorkers,
    // theme.name, theme.autoFallback16Color, notifications.enabled, awayMode.
    keystrokes: ['\x1b[B', '\x1b[B', '\x1b[B', '\x1b[B', '\x1b[B'],
  },
  {
    name: '04-both-on-16color',
    description:
      '#3 rendered against SYMPHONY_THEME_16 (legacy conhost). Active row + footer hint exercise primary (yellow → \\x1b[33m) and accent (magenta → \\x1b[35m) tokens. Covers VR-Minor2 from the 3H.2 review.',
    config: {
      ...defaultConfig(),
      notifications: { enabled: true },
      awayMode: true,
    },
    source: { kind: 'file', path: HOME_CFG, warnings: [] },
    keystrokes: ['\x1b[B', '\x1b[B', '\x1b[B', '\x1b[B', '\x1b[B'],
    themeOverride: resolveTheme(SYMPHONY_THEME_16),
  },
  {
    name: '05-default-baseline',
    description:
      'Both flags default (false). Idle mode, no file on disk. Captures the read-only baseline so the diff vs. 3h2 frames is purely "two new rows + minor description tweaks".',
    config: defaultConfig(),
    source: { kind: 'default' },
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
    '# Phase 3H.3 visual frames',
    '',
    `Generated: ${new Date().toISOString()}`,
    '',
    'Captures the `<SettingsPanel>` popup with the new 3H.3 rows: `notifications.enabled` (description updated to advertise the restraint policy) and the new `awayMode` boolean.',
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
    '- Both new rows visible (no truncation/cutoff).',
    '- Description text accurate (notifications row mentions failures + ask_user, awayMode row mentions digest).',
    '- Active row (#03 / #04) renders the highlight + token correctly per 16-color theme.',
    '- (from file) annotation only appears when source.kind = "file".',
    '',
    '| Scenario | Description |',
    '|---|---|',
  ];

  for (const scenario of SCENARIOS) {
    process.stderr.write(`Capturing ${scenario.name}…\n`);
    const { ansi, plain } = await captureScenario(scenario);
    writeFileSync(path.join(OUT_DIR, `3h3-${scenario.name}.ansi.txt`), ansi, 'utf8');
    writeFileSync(
      path.join(OUT_DIR, `3h3-${scenario.name}.plain.txt`),
      `# ${scenario.name}\n# ${scenario.description}\n\n${plain}\n`,
      'utf8',
    );
    summary.push(`| \`${scenario.name}\` | ${scenario.description} |`);
  }

  writeFileSync(path.join(OUT_DIR, 'INDEX-3h3.md'), summary.join('\n') + '\n', 'utf8');
  process.stderr.write(`\n${SCENARIOS.length} frames written to ${OUT_DIR}\n`);
}

void main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
