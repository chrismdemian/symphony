import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render } from 'ink-testing-library';

type RenderHandle = ReturnType<typeof render>;
const liveRenders: RenderHandle[] = [];

afterEach(() => {
  while (liveRenders.length > 0) {
    const handle = liveRenders.pop();
    handle?.unmount();
  }
});
import { ThemeProvider } from '../../../../src/ui/theme/context.js';
import {
  FocusProvider,
  type FocusState,
} from '../../../../src/ui/focus/focus.js';
import { KeybindProvider } from '../../../../src/ui/keybinds/dispatcher.js';
import { ToastProvider } from '../../../../src/ui/feedback/ToastProvider.js';
import { ConfigProvider } from '../../../../src/utils/config-context.js';
import { KeybindEditorPopup } from '../../../../src/ui/panels/settings/KeybindEditorPopup.js';
import {
  defaultConfig,
  type SymphonyConfig,
} from '../../../../src/utils/config-schema.js';
import type { ConfigSource } from '../../../../src/utils/config.js';
import type { Command } from '../../../../src/ui/keybinds/registry.js';

/**
 * Phase 3H.4 — KeybindEditorPopup unit tests.
 *
 * Two-mode component (list scope / capture scope). Tests drive scope
 * transitions through real FocusProvider state — Enter on a list row
 * pushes 'keybind-capture' onto the stack; Esc pops it back.
 *
 * `props.initial` ConfigProvider supplies the seed config so writes
 * stay in-memory (the disk path requires SYMPHONY_CONFIG_FILE; tests
 * are pure RAM).
 */

const stripAnsi = (s: string): string =>
  // eslint-disable-next-line no-control-regex
  s.replace(/\x1b\[[\d;]*[a-zA-Z]/g, '');

const noop = (): void => undefined;

function harness(opts: {
  readonly commands: readonly Command[];
  readonly config?: SymphonyConfig;
  readonly initialPopup?: 'keybind-list' | 'keybind-capture';
}) {
  const initialFocus: FocusState = {
    stack: [
      { kind: 'main', key: 'chat' },
      { kind: 'popup', key: opts.initialPopup ?? 'keybind-list' },
    ],
  };
  const initialConfig: SymphonyConfig = opts.config ?? defaultConfig();
  const initialSource: ConfigSource = {
    kind: 'file',
    path: '/fake/config.json',
    warnings: [],
  };
  const handle = render(
    <ThemeProvider>
      <ToastProvider>
        <ConfigProvider initial={{ config: initialConfig, source: initialSource }}>
          <FocusProvider initial={initialFocus}>
            <KeybindProvider initialCommands={opts.commands}>
              <KeybindEditorPopup />
            </KeybindProvider>
          </FocusProvider>
        </ConfigProvider>
      </ToastProvider>
    </ThemeProvider>,
  );
  liveRenders.push(handle);
  return handle;
}

const cmd = (
  id: string,
  title: string,
  key: Command['key'],
  scope: Command['scope'] = 'global',
  internal = false,
): Command => ({
  id,
  title,
  key,
  scope,
  displayOnScreen: false,
  onSelect: noop,
  ...(internal ? { internal: true } : {}),
});

describe('<KeybindEditorPopup>', () => {
  describe('list mode', () => {
    it('renders the editor header + command count', () => {
      const { lastFrame } = harness({
        commands: [
          cmd('a', 'first', { kind: 'char', char: 'a' }),
          cmd('b', 'second', { kind: 'char', char: 'b' }),
        ],
      });
      const frame = stripAnsi(lastFrame() ?? '');
      expect(frame).toContain('Keybind editor');
      expect(frame).toContain('2 commands');
    });

    it('renders each non-internal command with its current chord', () => {
      const { lastFrame } = harness({
        commands: [
          cmd('app.help', 'help', { kind: 'char', char: '?' }),
          cmd('app.exit', 'exit', { kind: 'ctrl', char: 'c' }),
        ],
      });
      const frame = stripAnsi(lastFrame() ?? '');
      expect(frame).toContain('help');
      expect(frame).toContain('?');
      expect(frame).toContain('exit');
      expect(frame).toContain('Ctrl+C');
    });

    it('excludes internal commands from the list', () => {
      const { lastFrame } = harness({
        commands: [
          cmd('app.help', 'help', { kind: 'char', char: '?' }),
          cmd(
            'palette.dismiss',
            'close palette',
            { kind: 'escape' },
            'palette',
            true,
          ),
        ],
      });
      const frame = stripAnsi(lastFrame() ?? '');
      expect(frame).toContain('help');
      expect(frame).not.toContain('close palette');
      expect(frame).toContain('1 commands');
    });

    it('renders (default) tag for un-overridden rows', () => {
      const { lastFrame } = harness({
        commands: [cmd('app.help', 'help', { kind: 'char', char: '?' })],
      });
      const frame = stripAnsi(lastFrame() ?? '');
      expect(frame).toContain('(default)');
    });

    it('renders (override) tag for overridden rows', () => {
      const config: SymphonyConfig = {
        ...defaultConfig(),
        keybindOverrides: { 'app.help': { kind: 'char', char: 'F' } },
      };
      const { lastFrame } = harness({
        commands: [cmd('app.help', 'help', { kind: 'char', char: 'F' })],
        config,
      });
      const frame = stripAnsi(lastFrame() ?? '');
      expect(frame).toContain('(override)');
    });

    it('shows footer hint with all four key actions', () => {
      const { lastFrame } = harness({
        commands: [cmd('a', 'first', { kind: 'char', char: 'a' })],
      });
      const frame = stripAnsi(lastFrame() ?? '');
      expect(frame).toContain('navigate');
      expect(frame).toContain('capture');
      expect(frame).toContain('reset');
      expect(frame).toContain('close');
    });

    it('renders empty-state copy when no commands are listable', () => {
      const { lastFrame } = harness({
        commands: [
          cmd(
            'palette.dismiss',
            'close',
            { kind: 'escape' },
            'palette',
            true,
          ),
        ],
      });
      const frame = stripAnsi(lastFrame() ?? '');
      expect(frame).toContain('(no overridable commands)');
    });
  });

  describe('capture mode (initial popup keybind-capture)', () => {
    it('renders capture header when scope is keybind-capture', () => {
      const { lastFrame } = harness({
        commands: [cmd('a', 'first', { kind: 'char', char: 'a' })],
        initialPopup: 'keybind-capture',
      });
      const frame = stripAnsi(lastFrame() ?? '');
      expect(frame).toContain('Capture key');
      expect(frame).toContain('Press a key');
      expect(frame).toContain('Esc to cancel');
    });
  });

  describe('list-mode keystroke handling', () => {
    it('Enter pushes keybind-capture scope (popup transition)', async () => {
      const { stdin, lastFrame } = harness({
        commands: [cmd('app.help', 'help', { kind: 'char', char: '?' })],
      });
      // Wait for command-registration effect to flush. Longer pause
      // under parallel pressure (3E known gotcha: 32 microtask drains
      // + 1 macrotask hop).
      await flushAsync();
      stdin.write('\r');
      await flushAsync();
      const frame = stripAnsi(lastFrame() ?? '');
      expect(frame).toContain('Capture key');
      expect(frame).toContain('help');
    });

    it('Enter on a leader-chord row stays in list mode (deferred notice)', async () => {
      const { stdin, lastFrame } = harness({
        commands: [
          cmd('leader.x', 'switch model', {
            kind: 'leader',
            lead: { kind: 'ctrl', char: 'x' },
            second: { kind: 'char', char: 'm' },
          }),
        ],
      });
      await flushAsync();
      stdin.write('\r');
      await flushAsync();
      const frame = stripAnsi(lastFrame() ?? '');
      // Should still be in list mode, NOT capture mode
      expect(frame).toContain('Keybind editor');
      expect(frame).not.toContain('Capture key');
    });

    it('Enter on an unbindable command stays in list mode (audit Major-1)', async () => {
      const unbindableCmd: Command = {
        id: 'app.exit',
        title: 'exit',
        key: { kind: 'ctrl', char: 'c' },
        scope: 'global',
        displayOnScreen: true,
        onSelect: noop,
        unbindable: true,
      };
      const { stdin, lastFrame } = harness({
        commands: [unbindableCmd],
      });
      await flushAsync();
      stdin.write('\r');
      await flushAsync();
      const frame = stripAnsi(lastFrame() ?? '');
      expect(frame).toContain('Keybind editor');
      expect(frame).not.toContain('Capture key');
      // The (reserved) tag renders for unbindable rows
      expect(frame).toContain('(reserved)');
    });
  });
});

/**
 * 32 microtask drains + 1 macrotask hop. Mirrors the 3E known gotcha:
 * setImmediate alone is too slow under parallel pressure when several
 * test files run concurrently.
 */
async function flushAsync(): Promise<void> {
  for (let i = 0; i < 32; i += 1) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
  for (let i = 0; i < 32; i += 1) await Promise.resolve();
}
