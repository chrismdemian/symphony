/**
 * Phase 7C — visual frame harness for the PluginsPanel popup.
 *
 *   01-empty               no plugins installed, master OFF — empty state +
 *                          master row selected ("off").
 *   02-list-mixed          3 plugins (enabled/disabled mix), master ON, a
 *                          plugin row selected → detail (source/flags/perms).
 *   03-dangerous-flags     plugin with requires:host-browser-control selected
 *                          → warning-toned flag chip.
 *   04-manifest-error      orphaned plugin (manifestError) → "⚠ broken" + error.
 *   05-install-input       install mode with a typed source buffer + cursor.
 *   06-confirm-remove      confirm-remove mode for a selected plugin.
 *   07-master-off-plugins  plugins listed but master OFF (the two-gate model).
 *
 * `.visual-frames/7c-<state>.{ansi,plain}.txt` + `INDEX-7c.md`.
 *
 * Palette references (truecolor):
 *  - accent **violet** (border, selected marker, install buffer) → `\x1b[38;2;124;111;235m`
 *  - success **gold** (enabled glyph / master "on") → `\x1b[38;2;212;168;67m`
 *  - warning **goldLight** (dangerous capability flags) → `\x1b[38;2;229;192;123m`
 *  - error **red** (remove confirm, ⚠ broken, manifest error) → `\x1b[38;2;224;108;117m`
 *  - textMuted **gray** (disabled glyph, descriptions, footer) → `\x1b[38;2;136;136;136m`
 */
import React from 'react';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Box } from 'ink';
import { render } from 'ink-testing-library';
import { ThemeProvider } from '../../src/ui/theme/context.js';
import { FocusProvider, type FocusState } from '../../src/ui/focus/focus.js';
import { KeybindProvider } from '../../src/ui/keybinds/dispatcher.js';
import { ConfigProvider } from '../../src/utils/config-context.js';
import { ToastProvider } from '../../src/ui/feedback/ToastProvider.js';
import { ToastTray } from '../../src/ui/feedback/ToastTray.js';
import { PluginsPanel } from '../../src/ui/panels/plugins/PluginsPanel.js';
import { defaultConfig, type SymphonyConfig } from '../../src/utils/config-schema.js';
import type { PluginListItem } from '../../src/rpc/router-impl.js';
import type { TuiRpc } from '../../src/ui/runtime/rpc.js';

const OUT_DIR = path.resolve(process.cwd(), '.visual-frames');
const DOWN = '\x1b[B';

function item(over: Partial<PluginListItem> = {}): PluginListItem {
  return {
    id: over.id ?? 'echo',
    name: over.name ?? 'Echo',
    version: over.version ?? '1.0.0',
    enabled: over.enabled ?? false,
    source: over.source ?? '/repos/echo',
    installedAt: over.installedAt ?? '2026-06-03T00:00:00.000Z',
    ...over,
  };
}

function fakeRpc(plugins: PluginListItem[]): TuiRpc {
  return {
    call: {
      plugins: {
        list: () => Promise.resolve(plugins.map((p) => ({ ...p }))),
        setEnabled: ({ id, enabled }: { id: string; enabled: boolean }) =>
          Promise.resolve({ id, enabled }),
        install: () => Promise.resolve({ id: 'x', name: 'X', version: '1', reinstall: false }),
        remove: ({ id }: { id: string }) => Promise.resolve({ id, removedRow: true, removedDir: true }),
      },
    },
    subscribe: () => Promise.resolve({ topic: '', unsubscribe: async () => {} }),
    close: () => Promise.resolve(undefined),
  } as unknown as TuiRpc;
}

interface Scenario {
  readonly name: string;
  readonly description: string;
  readonly plugins: PluginListItem[];
  readonly pluginsEnabled: boolean;
  readonly keystrokes?: readonly string[];
}

const MIXED: PluginListItem[] = [
  item({
    id: 'notifier-example',
    name: 'Notifier',
    version: '0.1.0',
    enabled: true,
    source: 'npm:@symphony/notifier',
    description: 'Logs a line on task/worker events.',
    permissions: ['notify:send', 'task:read'],
    capabilityFlags: [],
    events: ['onTaskCreated', 'onTaskCompleted'],
    toolScope: 'both',
  }),
  item({
    id: 'echo',
    name: 'Echo',
    version: '1.0.0',
    enabled: false,
    source: '/repos/echo',
    description: 'A tiny echo tool.',
    permissions: ['task:read'],
    capabilityFlags: ['irreversible'],
  }),
  item({
    id: 'linear',
    name: 'Linear Connector',
    version: '2.3.1',
    enabled: false,
    source: 'git+https://github.com/acme/linear-plugin.git',
    description: 'Pull issues from Linear.',
    permissions: ['net:api.linear.app'],
    capabilityFlags: ['external-visible'],
  }),
];

const SCENARIOS: readonly Scenario[] = [
  {
    name: '01-empty',
    description:
      'No plugins installed, master switch OFF. Master row selected → "off" + description; empty-state line "No plugins installed. Press i to install one."',
    plugins: [],
    pluginsEnabled: false,
  },
  {
    name: '02-list-mixed',
    description:
      'Three plugins (Notifier enabled, Echo + Linear disabled), master ON. Selection on the Echo row → detail (source, irreversible flag, task:read permission).',
    plugins: MIXED,
    pluginsEnabled: true,
    keystrokes: [DOWN, DOWN], // master → Notifier → Echo
  },
  {
    name: '03-dangerous-flags',
    description:
      'A browser-control plugin selected → its requires:host-browser-control flag renders in the warning tone (goldLight), distinct from the muted source/permissions.',
    plugins: [
      item({
        id: 'chrome-devtools',
        name: 'Chrome DevTools',
        version: '0.9.0',
        enabled: false,
        source: 'npm:chrome-devtools-mcp',
        description: 'Drive the user live Chrome via CDP.',
        permissions: ['net:localhost'],
        capabilityFlags: ['requires:host-browser-control', 'irreversible'],
      }),
    ],
    pluginsEnabled: true,
    keystrokes: [DOWN], // → the plugin row
  },
  {
    name: '04-manifest-error',
    description:
      'An orphaned install (manifestError set) → "⚠ broken" tag on the row + a red "manifest error:" line in the detail. Still removable.',
    plugins: [
      item({
        id: 'orphan',
        name: 'orphan',
        version: '0.0.0',
        enabled: false,
        source: '/repos/orphan',
        manifestError: 'no plugin.json in /home/.symphony/plugins/orphan',
      }),
    ],
    pluginsEnabled: true,
    keystrokes: [DOWN],
  },
  {
    name: '05-install-input',
    description:
      'Install mode: "i" opened a source input; the buffer shows a typed npm spec with the inverse cursor; footer switches to "Type source · Enter install · Esc cancel".',
    plugins: MIXED,
    pluginsEnabled: true,
    keystrokes: ['i', '@', 'a', 'c', 'm', 'e', '/', 'p', 'l', 'u', 'g', 'i', 'n'],
  },
  {
    name: '06-confirm-remove',
    description:
      'Confirm-remove mode: navigated to the Echo row, pressed "x" → red "Remove plugin \'echo\'? This deletes it from disk." + footer "Enter confirm remove · Esc cancel".',
    plugins: MIXED,
    pluginsEnabled: true,
    keystrokes: [DOWN, DOWN, 'x'], // → Echo → confirm
  },
  {
    name: '07-master-off-plugins',
    description:
      'Plugins installed but master switch OFF (the two-gate model). Master row selected shows "off"; the plugin rows still list their individual enabled state.',
    plugins: MIXED,
    pluginsEnabled: false,
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

function focusState(): FocusState {
  return {
    stack: [
      { kind: 'main', key: 'chat' },
      { kind: 'popup', key: 'plugins' },
    ],
  };
}

async function captureScenario(scenario: Scenario): Promise<CapturedFrame> {
  const config: SymphonyConfig = { ...defaultConfig(), pluginsEnabled: scenario.pluginsEnabled };
  const result = render(
    <Box flexDirection="column" height={30} width={110}>
      <ThemeProvider>
        <ToastProvider>
          <ConfigProvider initial={{ config, source: { kind: 'default' } }}>
            <FocusProvider initial={focusState()}>
              <KeybindProvider initialCommands={[]}>
                <PluginsPanel rpc={fakeRpc(scenario.plugins)} />
                <ToastTray />
              </KeybindProvider>
            </FocusProvider>
          </ConfigProvider>
        </ToastProvider>
      </ThemeProvider>
    </Box>,
  );
  await flushAll();
  await new Promise((r) => setTimeout(r, 80));
  if (scenario.keystrokes !== undefined) {
    for (const k of scenario.keystrokes) {
      result.stdin.write(k);
      await new Promise((r) => setTimeout(r, 25));
    }
    await new Promise((r) => setTimeout(r, 80));
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
    '# Phase 7C visual frames',
    '',
    `Generated: ${new Date().toISOString()}`,
    '',
    'Captures the PluginsPanel popup: master switch, plugin rows (enabled/disabled),',
    'capability-flag chips (warning tone for dangerous flags), manifest-error rows,',
    'the install-source input mode, and the remove-confirm mode.',
    '',
    'Palette references (truecolor):',
    '- accent **violet** (border, selected ▸ marker, install buffer) → `\\x1b[38;2;124;111;235m`',
    '- success **gold** (✓ enabled glyph, master "on") → `\\x1b[38;2;212;168;67m`',
    '- warning **goldLight** (dangerous capability flags) → `\\x1b[38;2;229;192;123m`',
    '- error **red** (remove confirm, ⚠ broken, manifest error) → `\\x1b[38;2;224;108;117m`',
    '- textMuted **gray** (○ disabled, descriptions, footer, source) → `\\x1b[38;2;136;136;136m`',
    '',
    '| Scenario | Description |',
    '|---|---|',
  ];

  for (const scenario of SCENARIOS) {
    process.stderr.write(`Capturing ${scenario.name}…\n`);
    const { ansi, plain } = await captureScenario(scenario);
    writeFileSync(path.join(OUT_DIR, `7c-${scenario.name}.ansi.txt`), ansi, 'utf8');
    writeFileSync(
      path.join(OUT_DIR, `7c-${scenario.name}.plain.txt`),
      `# ${scenario.name}\n# ${scenario.description}\n\n${plain}\n`,
      'utf8',
    );
    summary.push(`| \`${scenario.name}\` | ${scenario.description} |`);
  }

  writeFileSync(path.join(OUT_DIR, 'INDEX-7c.md'), summary.join('\n') + '\n', 'utf8');
  process.stderr.write(`\n${SCENARIOS.length} frames written to ${OUT_DIR}\n`);
}

void main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
