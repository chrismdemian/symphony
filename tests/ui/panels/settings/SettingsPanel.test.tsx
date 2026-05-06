import React from 'react';
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { ThemeProvider } from '../../../../src/ui/theme/context.js';
import { FocusProvider, type FocusState } from '../../../../src/ui/focus/focus.js';
import { KeybindProvider } from '../../../../src/ui/keybinds/dispatcher.js';
import { ConfigProvider } from '../../../../src/utils/config-context.js';
import { ToastProvider } from '../../../../src/ui/feedback/ToastProvider.js';
import { ToastTray } from '../../../../src/ui/feedback/ToastTray.js';
import { SettingsPanel } from '../../../../src/ui/panels/settings/SettingsPanel.js';
import { defaultConfig, type SymphonyConfig } from '../../../../src/utils/config-schema.js';
import type { ConfigSource } from '../../../../src/utils/config.js';

const stripAnsi = (s: string): string =>
  // eslint-disable-next-line no-control-regex
  s.replace(/\x1b\[[\d;]*[a-zA-Z]/g, '');

interface HarnessProps {
  readonly config?: SymphonyConfig;
  readonly source?: ConfigSource;
}

function Harness({ config, source }: HarnessProps): React.JSX.Element {
  const initial: FocusState = {
    stack: [
      { kind: 'main', key: 'chat' },
      { kind: 'popup', key: 'settings' },
    ],
  };
  const initialConfig = config ?? defaultConfig();
  const initialSource: ConfigSource = source ?? { kind: 'default' };
  return (
    <ThemeProvider>
      <ToastProvider>
        <ConfigProvider initial={{ config: initialConfig, source: initialSource }}>
          <FocusProvider initial={initial}>
            <KeybindProvider initialCommands={[]}>
              <SettingsPanel />
              <ToastTray />
            </KeybindProvider>
          </FocusProvider>
        </ConfigProvider>
      </ToastProvider>
    </ThemeProvider>
  );
}

async function settle(ms = 80): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

describe('<SettingsPanel> (3H.1 read-only popup)', () => {
  it('renders all 6 section headers with default config', async () => {
    const { lastFrame } = render(<Harness />);
    await settle();
    const frame = stripAnsi(lastFrame() ?? '');
    expect(frame).toContain('Settings');
    expect(frame).toContain('Phase 3H.1 (read-only)');
    expect(frame).toContain('Model');
    expect(frame).toContain('Workers');
    expect(frame).toContain('Appearance');
    expect(frame).toContain('Notifications');
    expect(frame).toContain('Project');
    expect(frame).toContain('Advanced');
  });

  it('renders default values with (default) annotations', async () => {
    const { lastFrame } = render(<Harness />);
    await settle();
    const frame = stripAnsi(lastFrame() ?? '');
    expect(frame).toContain('modelMode');
    expect(frame).toContain('mixed');
    expect(frame).toContain('(default)');
    expect(frame).toContain('maxConcurrentWorkers');
    expect(frame).toContain('4');
  });

  it('renders customized values with (from file) annotations', async () => {
    const config: SymphonyConfig = {
      ...defaultConfig(),
      modelMode: 'opus',
      maxConcurrentWorkers: 8,
    };
    const source: ConfigSource = {
      kind: 'file',
      path: '/home/chris/.symphony/config.json',
      warnings: [],
    };
    const { lastFrame } = render(<Harness config={config} source={source} />);
    await settle();
    const frame = stripAnsi(lastFrame() ?? '');
    expect(frame).toContain('opus');
    expect(frame).toContain('8');
    expect(frame).toContain('(from file)');
  });

  it('renders the source line with the file path when present', async () => {
    const source: ConfigSource = {
      kind: 'file',
      path: '/home/chris/.symphony/config.json',
      warnings: [],
    };
    const { lastFrame } = render(<Harness source={source} />);
    await settle();
    const frame = stripAnsi(lastFrame() ?? '');
    expect(frame).toContain('Source:');
    expect(frame).toContain('config.json');
  });

  it('renders "(no file — using defaults)" when source.kind=default', async () => {
    const { lastFrame } = render(<Harness />);
    await settle();
    const frame = stripAnsi(lastFrame() ?? '');
    expect(frame).toContain('(no file');
  });

  it('renders defaultProjectPath as "(none)" when undefined', async () => {
    const { lastFrame } = render(<Harness />);
    await settle();
    const frame = stripAnsi(lastFrame() ?? '');
    expect(frame).toContain('defaultProjectPath');
    expect(frame).toContain('(none)');
  });

  it('renders a long defaultProjectPath value when set', async () => {
    const config: SymphonyConfig = {
      ...defaultConfig(),
      defaultProjectPath: '/home/chris/projects/symphony',
    };
    const source: ConfigSource = { kind: 'file', path: '/x', warnings: [] };
    const { lastFrame } = render(<Harness config={config} source={source} />);
    await settle();
    const frame = stripAnsi(lastFrame() ?? '');
    expect(frame).toContain('/home/chris/projects/symphony');
  });

  it('shows the keybindOverrides count', async () => {
    const config: SymphonyConfig = {
      ...defaultConfig(),
      keybindOverrides: {
        'palette.open': { kind: 'ctrl', char: 'o' },
        'app.help': { kind: 'char', char: 'h' },
      },
    };
    const source: ConfigSource = { kind: 'file', path: '/x', warnings: [] };
    const { lastFrame } = render(<Harness config={config} source={source} />);
    await settle();
    const frame = stripAnsi(lastFrame() ?? '');
    expect(frame).toContain('keybindOverrides');
    expect(frame).toContain('2 entries');
  });

  it('footer advertises Esc/Enter/arrow keys', async () => {
    const { lastFrame } = render(<Harness />);
    await settle();
    const frame = stripAnsi(lastFrame() ?? '');
    expect(frame).toMatch(/Esc/);
    expect(frame).toMatch(/Enter/);
    expect(frame).toMatch(/navigate/);
  });

  it('Enter on a value row surfaces a "ships in 3H.2" toast', async () => {
    const { stdin, lastFrame } = render(<Harness />);
    await settle();
    stdin.write('\r');
    await settle();
    const frame = stripAnsi(lastFrame() ?? '');
    expect(frame).toContain('Editing ships in Phase 3H.2');
  });
});
