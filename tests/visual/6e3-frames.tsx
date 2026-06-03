/**
 * Phase 6E.3 — visual frame harness for the Voice settings section + the
 * threshold sliders. Mirrors the 3H.2 settings harness; navigates the popup
 * into the Voice section before capture (the section scrolls past the fold
 * with the full row list).
 *
 *   01-voice-defaults        Voice section in view, default config — all 6
 *                            rows with (default), both sliders at 0.50.
 *   02-voice-all-enabled     enabled/always/autoSend/wakeWordEnabled all on,
 *                            (from file) — exercises every toggle's truthy
 *                            render + non-default slider values.
 *   03-vad-slider-selected   voice.vadThreshold selected → violet filled bar,
 *                            description line, footer "←→ adjust (0.05)".
 *   04-vad-slider-min        vadThreshold 0.00 → empty bar [░░░░░░░░░░].
 *   05-vad-slider-max        vadThreshold 1.00 → full bar [██████████].
 *   06-wake-slider-selected  voice.wakeWordThreshold 0.65 (from file) selected.
 *
 * Value-row indices (Voice section after awayMode @6):
 *   7 voice.enabled · 8 voice.mode · 9 voice.autoSend · 10 voice.wakeWordEnabled
 *   11 voice.vadThreshold · 12 voice.wakeWordThreshold
 *
 * `.visual-frames/6e3-<state>.{ansi,plain}.txt` + `INDEX-6e3.md`.
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
const HOME = os.homedir();
const HOME_CFG = path.join(HOME, '.symphony', 'config.json');

const DOWN = '\x1b[B';
/** Build a run of N down-arrow presses to reach a value-row index. */
const downTo = (valueIndex: number): readonly string[] =>
  Array.from({ length: valueIndex }, () => DOWN);

interface Scenario {
  readonly name: string;
  readonly description: string;
  readonly config: SymphonyConfig;
  readonly source: ConfigSource;
  readonly keystrokes?: readonly string[];
}

function voiceConfig(overrides: Partial<SymphonyConfig['voice']>): SymphonyConfig {
  const base = defaultConfig();
  return { ...base, voice: { ...base.voice, ...overrides } };
}

const SCENARIOS: readonly Scenario[] = [
  {
    name: '01-voice-defaults',
    description:
      'Voice section scrolled into view (selection on voice.enabled). Default config — every voice row shows (default); both sliders render [█████░░░░░] 0.50 in violet.',
    config: defaultConfig(),
    source: { kind: 'default' },
    keystrokes: downTo(7), // → voice.enabled
  },
  {
    name: '02-voice-all-enabled',
    description:
      'enabled=true, mode=always, autoSend=true, wakeWordEnabled=true, vadThreshold=0.70, wakeWordThreshold=0.60 — all (from file). Exercises every toggle truthy + non-default sliders. Selection on voice.mode.',
    config: voiceConfig({
      enabled: true,
      mode: 'always',
      autoSend: true,
      wakeWordEnabled: true,
      vadThreshold: 0.7,
      wakeWordThreshold: 0.6,
    }),
    source: { kind: 'file', path: HOME_CFG, warnings: [] },
    keystrokes: downTo(8), // → voice.mode
  },
  {
    name: '03-vad-slider-selected',
    description:
      'voice.vadThreshold SELECTED (default 0.50). Violet filled bar [█████░░░░░], description line visible, footer hint switches to "↑↓ navigate · ←→ adjust (0.05) · Esc close".',
    config: defaultConfig(),
    source: { kind: 'default' },
    keystrokes: downTo(11), // → voice.vadThreshold
  },
  {
    name: '04-vad-slider-min',
    description:
      'voice.vadThreshold = 0.00 selected — empty bar [░░░░░░░░░░] (all muted, no violet cells) and value 0.00. (from file)',
    config: voiceConfig({ vadThreshold: 0 }),
    source: { kind: 'file', path: HOME_CFG, warnings: [] },
    keystrokes: downTo(11),
  },
  {
    name: '05-vad-slider-max',
    description:
      'voice.vadThreshold = 1.00 selected — full bar [██████████] (all violet) and value 1.00. (from file)',
    config: voiceConfig({ vadThreshold: 1 }),
    source: { kind: 'file', path: HOME_CFG, warnings: [] },
    keystrokes: downTo(11),
  },
  {
    name: '06-wake-slider-selected',
    description:
      'voice.wakeWordThreshold = 0.65 selected (from file) — violet bar [███████░░░] 0.65, description mentions openWakeWord. Confirms it is a separate slider from VAD.',
    config: voiceConfig({ wakeWordThreshold: 0.65 }),
    source: { kind: 'file', path: HOME_CFG, warnings: [] },
    keystrokes: downTo(12), // → voice.wakeWordThreshold
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
  await new Promise((r) => setTimeout(r, 60));
  if (scenario.keystrokes !== undefined) {
    for (const k of scenario.keystrokes) {
      result.stdin.write(k);
      await new Promise((r) => setTimeout(r, 25));
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
    '# Phase 6E.3 visual frames',
    '',
    `Generated: ${new Date().toISOString()}`,
    '',
    'Captures the new Voice section of `<SettingsPanel>` + the VAD / wake-word threshold sliders.',
    '',
    'Palette references (truecolor):',
    '- accent **violet** (slider FILLED cells, popup border, (from file) value) → `\\x1b[38;2;124;111;235m`',
    '- textMuted **gray** (slider EMPTY cells, brackets, (default) tag, descriptions) → `\\x1b[38;2;136;136;136m`',
    '- text **light gray** (labels, (default) value) → `\\x1b[38;2;224;224;224m`',
    '- primary **gold** is NOT used by the slider — do not expect `\\x1b[38;2;212;168;67m` on the bar',
    '',
    'Slider bar contract: `[` + N violet `█` + (10−N) muted `░` + `]`, where N = round(value×10).',
    'Expected fills: 0.00→0 · 0.50→5 · 0.65→7 (6.5 rounds up) · 0.70→7 · 1.00→10.',
    '',
    '| Scenario | Description |',
    '|---|---|',
  ];

  for (const scenario of SCENARIOS) {
    process.stderr.write(`Capturing ${scenario.name}…\n`);
    const { ansi, plain } = await captureScenario(scenario);
    writeFileSync(path.join(OUT_DIR, `6e3-${scenario.name}.ansi.txt`), ansi, 'utf8');
    writeFileSync(
      path.join(OUT_DIR, `6e3-${scenario.name}.plain.txt`),
      `# ${scenario.name}\n# ${scenario.description}\n\n${plain}\n`,
      'utf8',
    );
    summary.push(`| \`${scenario.name}\` | ${scenario.description} |`);
  }

  writeFileSync(path.join(OUT_DIR, 'INDEX-6e3.md'), summary.join('\n') + '\n', 'utf8');
  process.stderr.write(`\n${SCENARIOS.length} frames written to ${OUT_DIR}\n`);
}

void main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
