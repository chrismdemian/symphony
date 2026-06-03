import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render as inkRender } from 'ink-testing-library';
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

// 3H.4 gotcha — unmount prior renders so leftover `useInput` listeners don't
// intercept the arrow-key navigation added in 6E.3 (see editors test file).
const liveRenders: Array<{ readonly unmount: () => void }> = [];
const render = (el: React.JSX.Element): ReturnType<typeof inkRender> => {
  const r = inkRender(el);
  liveRenders.push(r);
  return r;
};
afterEach(() => {
  for (const r of liveRenders.splice(0)) r.unmount();
});

describe('<SettingsPanel> (3H.1 read-only popup)', () => {
  it('renders all section headers with default config', async () => {
    const { lastFrame } = render(<Harness />);
    await settle();
    const frame = stripAnsi(lastFrame() ?? '');
    expect(frame).toContain('Settings');
    // Match loosely on the major version: 6E.3 bumped this to "Phase 6E.3";
    // future phases will too.
    expect(frame).toMatch(/Phase \d/);
    // 6E.3 — the Voice section (6 rows) pushes total rows past VISIBLE_ROWS,
    // so the popup now scrolls. The default top-of-list view shows Model →
    // Voice; Project/Advanced scroll into view on navigation (covered by the
    // keybindOverrides / leaderTimeoutMs navigation tests). Assert the
    // always-visible top sections here, including the new Voice header.
    expect(frame).toContain('Model');
    expect(frame).toContain('Workers');
    expect(frame).toContain('Appearance');
    expect(frame).toContain('Notifications');
    expect(frame).toContain('Voice');
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
    const { stdin, lastFrame } = render(<Harness />);
    await settle();
    // 6E.3 — defaultProjectPath is the 14th value row (index 13) now that the
    // Voice section's 6 rows precede Project. Navigate down so it's in view.
    for (let i = 0; i < 13; i += 1) stdin.write('\x1b[B');
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
    const { stdin, lastFrame } = render(<Harness config={config} source={source} />);
    await settle();
    for (let i = 0; i < 13; i += 1) stdin.write('\x1b[B'); // → defaultProjectPath
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
    const { stdin, lastFrame } = render(<Harness config={config} source={source} />);
    await settle();
    // 6E.3 — keybindOverrides is the last (17th) value row (index 16).
    for (let i = 0; i < 16; i += 1) stdin.write('\x1b[B');
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

  it('Enter on a readonly row (theme.name) shows an explanatory toast', async () => {
    const { stdin, lastFrame } = render(<Harness />);
    await settle();
    // Default selection is the first value row (modelMode). Navigate down
    // to theme.name (3rd value row).
    stdin.write('\x1b[B'); // ↓ to maxConcurrentWorkers
    stdin.write('\x1b[B'); // ↓ to theme.name
    await settle();
    stdin.write('\r');
    await settle();
    const frame = stripAnsi(lastFrame() ?? '');
    expect(frame).toMatch(/intrinsic|not editable|theme\.name/);
  });

  it('Enter on the keybindOverrides row surfaces the 3H.4 deferral toast', async () => {
    const { stdin, lastFrame } = render(<Harness />);
    await settle();
    // Navigate down to keybindOverrides (last value row). 6E.3 inserted the
    // Voice section's 6 rows before Project/Advanced, bumping keybindOverrides
    // from index 10 → 16. From the default selection (modelMode at index 0)
    // that's 16 ↓ presses.
    for (let i = 0; i < 16; i += 1) stdin.write('\x1b[B');
    await settle();
    stdin.write('\r');
    await settle();
    const frame = stripAnsi(lastFrame() ?? '');
    expect(frame).toMatch(/3H\.4/);
  });
});
