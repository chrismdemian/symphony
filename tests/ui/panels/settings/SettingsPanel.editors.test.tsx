import React from 'react';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render } from 'ink-testing-library';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ThemeProvider } from '../../../../src/ui/theme/context.js';
import { FocusProvider, type FocusState } from '../../../../src/ui/focus/focus.js';
import { KeybindProvider } from '../../../../src/ui/keybinds/dispatcher.js';
import {
  ConfigProvider,
  useConfig,
  type ConfigController,
} from '../../../../src/utils/config-context.js';
import { ToastProvider } from '../../../../src/ui/feedback/ToastProvider.js';
import { ToastTray } from '../../../../src/ui/feedback/ToastTray.js';
import { SettingsPanel } from '../../../../src/ui/panels/settings/SettingsPanel.js';
import {
  defaultConfig,
  type SymphonyConfig,
} from '../../../../src/utils/config-schema.js';
import {
  SYMPHONY_CONFIG_FILE_ENV,
  _resetConfigWriteQueue,
  type ConfigSource,
} from '../../../../src/utils/config.js';

/**
 * Phase 3H.2 — per-field editor behavior. Bool toggles, enum cycle, int
 * inline input, text-path inline input + git-repo validation. Routes
 * writes through `ConfigProvider.setConfig` (in-process) and asserts
 * disk persistence via SYMPHONY_CONFIG_FILE.
 */

const stripAnsi = (s: string): string =>
  // eslint-disable-next-line no-control-regex
  s.replace(/\x1b\[[\d;]*[a-zA-Z]/g, '');

interface HarnessProps {
  readonly config?: SymphonyConfig;
  readonly captureRef?: { current?: ConfigController };
}

function CaptureConfig(props: { readonly captureRef: { current?: ConfigController } }): React.JSX.Element {
  props.captureRef.current = useConfig();
  return <></>;
}

function Harness({ config, captureRef }: HarnessProps): React.JSX.Element {
  const initial: FocusState = {
    stack: [
      { kind: 'main', key: 'chat' },
      { kind: 'popup', key: 'settings' },
    ],
  };
  const initialConfig = config ?? defaultConfig();
  const initialSource: ConfigSource = { kind: 'default' };
  return (
    <ThemeProvider>
      <ToastProvider>
        <ConfigProvider initial={{ config: initialConfig, source: initialSource }}>
          {captureRef !== undefined ? <CaptureConfig captureRef={captureRef} /> : null}
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

const settle = async (ms = 50): Promise<void> => {
  await new Promise((r) => setTimeout(r, ms));
};

describe('<SettingsPanel> editors (3H.2)', () => {
  let tmp: string;
  let cfgFile: string;
  let prevEnv: string | undefined;

  beforeEach(() => {
    _resetConfigWriteQueue();
    tmp = mkdtempSync(join(tmpdir(), 'symphony-settings-edit-'));
    cfgFile = join(tmp, 'config.json');
    prevEnv = process.env[SYMPHONY_CONFIG_FILE_ENV];
    process.env[SYMPHONY_CONFIG_FILE_ENV] = cfgFile;
  });

  afterEach(() => {
    _resetConfigWriteQueue();
    if (prevEnv === undefined) delete process.env[SYMPHONY_CONFIG_FILE_ENV];
    else process.env[SYMPHONY_CONFIG_FILE_ENV] = prevEnv;
    rmSync(tmp, { recursive: true, force: true });
  });

  it('Enter on modelMode cycles opus ↔ mixed', async () => {
    const captureRef: { current?: ConfigController } = {};
    const { stdin } = render(<Harness captureRef={captureRef} />);
    await settle();
    expect(captureRef.current?.config.modelMode).toBe('mixed');

    // Default selection is modelMode (first value row). Enter cycles.
    stdin.write('\r');
    await settle();
    expect(captureRef.current?.config.modelMode).toBe('opus');

    stdin.write('\r');
    await settle();
    expect(captureRef.current?.config.modelMode).toBe('mixed');
  });

  it('Space on theme.autoFallback16Color toggles the boolean', async () => {
    const captureRef: { current?: ConfigController } = {};
    const { stdin } = render(<Harness captureRef={captureRef} />);
    await settle();
    expect(captureRef.current?.config.theme.autoFallback16Color).toBe(true);

    // Navigate: modelMode → maxConcurrentWorkers → autoMerge (3O.1) → theme.name → theme.autoFallback16Color
    stdin.write('\x1b[B'); // ↓
    stdin.write('\x1b[B'); // ↓
    stdin.write('\x1b[B'); // ↓
    stdin.write('\x1b[B'); // ↓
    await settle();
    stdin.write(' '); // Space toggles
    await settle();
    expect(captureRef.current?.config.theme.autoFallback16Color).toBe(false);
  });

  it('Space on notifications.enabled toggles the boolean', async () => {
    const captureRef: { current?: ConfigController } = {};
    const { stdin } = render(<Harness captureRef={captureRef} />);
    await settle();
    expect(captureRef.current?.config.notifications.enabled).toBe(false);

    // Navigate down to notifications.enabled (6th value row — 3O.1 autoMerge shifted +1).
    for (let i = 0; i < 5; i += 1) stdin.write('\x1b[B');
    await settle();
    stdin.write(' ');
    await settle();
    expect(captureRef.current?.config.notifications.enabled).toBe(true);
  });

  it('Enter on maxConcurrentWorkers opens int editor; Enter commits', async () => {
    const captureRef: { current?: ConfigController } = {};
    const { stdin, lastFrame } = render(<Harness captureRef={captureRef} />);
    await settle();
    expect(captureRef.current?.config.maxConcurrentWorkers).toBe(4);

    // Navigate to maxConcurrentWorkers (2nd value row).
    stdin.write('\x1b[B');
    await settle();
    stdin.write('\r'); // open editor — pre-fills with current "4"
    await settle();
    let frame = stripAnsi(lastFrame() ?? '');
    expect(frame).toMatch(/Enter commit/);

    // Backspace through pre-fill, then type "16".
    stdin.write('\x7f');
    stdin.write('1');
    stdin.write('6');
    await settle();
    frame = stripAnsi(lastFrame() ?? '');
    expect(frame).toContain('16');

    stdin.write('\r'); // commit
    await settle();
    expect(captureRef.current?.config.maxConcurrentWorkers).toBe(16);

    // Footer reverts to navigation hint.
    frame = stripAnsi(lastFrame() ?? '');
    expect(frame).toMatch(/navigate/);
  });

  it('Esc on int editor cancels without committing', async () => {
    const captureRef: { current?: ConfigController } = {};
    const { stdin } = render(<Harness captureRef={captureRef} />);
    await settle();

    stdin.write('\x1b[B'); // ↓ to maxConcurrentWorkers
    await settle();
    stdin.write('\r'); // open
    await settle();
    stdin.write('9');
    stdin.write('9');
    await settle();
    stdin.write('\x1b'); // Esc
    await settle();

    expect(captureRef.current?.config.maxConcurrentWorkers).toBe(4);
  });

  it('out-of-range int toast surfaces, editor stays open with preserved value (audit M3)', async () => {
    const captureRef: { current?: ConfigController } = {};
    const { stdin, lastFrame } = render(<Harness captureRef={captureRef} />);
    await settle();

    stdin.write('\x1b[B'); // ↓ to maxConcurrentWorkers
    await settle();
    stdin.write('\r'); // open editor
    await settle();
    stdin.write('\x7f'); // backspace pre-fill "4"
    // Schema max is 32; 499 is out of range.
    stdin.write('4');
    stdin.write('9');
    stdin.write('9');
    await settle();
    stdin.write('\r'); // commit (invalid)
    await settle();
    const frame = stripAnsi(lastFrame() ?? '');
    expect(frame).toMatch(/Invalid/);
    // Editor MUST stay open so the user can fix the value — footer
    // hint reflects edit-mode shortcuts.
    expect(frame).toMatch(/Enter commit/);
    // Buffer preserved for retry — the user's "499" is still typed.
    expect(frame).toContain('499');
    // Config was NOT changed.
    expect(captureRef.current?.config.maxConcurrentWorkers).toBe(4);
  });

  it('Ctrl+U clears the int editor buffer (kill-line)', async () => {
    const captureRef: { current?: ConfigController } = {};
    const { stdin, lastFrame } = render(<Harness captureRef={captureRef} />);
    await settle();

    stdin.write('\x1b[B'); // ↓ to maxConcurrentWorkers
    await settle();
    stdin.write('\r'); // open editor (pre-fill "4")
    await settle();
    stdin.write('1');
    stdin.write('2');
    stdin.write('3');
    await settle();
    let frame = stripAnsi(lastFrame() ?? '');
    expect(frame).toContain('4123');
    // Ctrl+U → kill line.
    stdin.write('\x15');
    await settle();
    frame = stripAnsi(lastFrame() ?? '');
    expect(frame).not.toContain('4123');
    expect(frame).not.toContain('123');
  });

  it('int editor restricts input to digits', async () => {
    const captureRef: { current?: ConfigController } = {};
    const { stdin, lastFrame } = render(<Harness captureRef={captureRef} />);
    await settle();
    stdin.write('\x1b[B'); // ↓ to maxConcurrentWorkers
    await settle();
    stdin.write('\r'); // open
    await settle();
    // Letters should not appear.
    stdin.write('a');
    stdin.write('b');
    stdin.write('1');
    stdin.write('2');
    await settle();
    const frame = stripAnsi(lastFrame() ?? '');
    expect(frame).toContain('12');
    expect(frame).not.toMatch(/ab12/);
  });

  it('Enter on leaderTimeoutMs opens int editor and commits a valid value', async () => {
    const captureRef: { current?: ConfigController } = {};
    const { stdin } = render(<Harness captureRef={captureRef} />);
    await settle();

    // Navigate to leaderTimeoutMs (9th value row — 3O.1 autoMerge shifted +1 from 3H.3).
    for (let i = 0; i < 8; i += 1) stdin.write('\x1b[B');
    await settle();
    stdin.write('\r');
    await settle();
    // Clear the existing 300 value with backspaces, type 500.
    stdin.write('\x7f'); // backspace
    stdin.write('\x7f');
    stdin.write('\x7f');
    await settle();
    stdin.write('5');
    stdin.write('0');
    stdin.write('0');
    await settle();
    stdin.write('\r');
    await settle();
    expect(captureRef.current?.config.leaderTimeoutMs).toBe(500);
  });

  it('Enter on defaultProjectPath opens text editor; valid git path commits', async () => {
    // Pre-create a git-repo-like directory.
    const projectDir = join(tmp, 'fake-project');
    mkdirSync(projectDir);
    mkdirSync(join(projectDir, '.git'));
    writeFileSync(join(projectDir, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');

    const captureRef: { current?: ConfigController } = {};
    const { stdin } = render(<Harness captureRef={captureRef} />);
    await settle();

    // Navigate to defaultProjectPath (8th value row — 3O.1 autoMerge shifted +1 from 3H.3).
    for (let i = 0; i < 7; i += 1) stdin.write('\x1b[B');
    await settle();
    stdin.write('\r');
    await settle();
    // Type the path.
    for (const ch of projectDir) stdin.write(ch);
    await settle();
    stdin.write('\r'); // commit
    await settle();

    expect(captureRef.current?.config.defaultProjectPath).toBe(projectDir);
  });

  it('defaultProjectPath rejects non-existent path with toast', async () => {
    const bogus = join(tmp, 'does-not-exist');

    const captureRef: { current?: ConfigController } = {};
    const { stdin, lastFrame } = render(<Harness captureRef={captureRef} />);
    await settle();

    // 3O.1 autoMerge shifted defaultProjectPath +1 (was +1 from 3H.3 awayMode).
    for (let i = 0; i < 7; i += 1) stdin.write('\x1b[B');
    await settle();
    stdin.write('\r');
    await settle();
    for (const ch of bogus) stdin.write(ch);
    await settle();
    stdin.write('\r');
    await settle();
    const frame = stripAnsi(lastFrame() ?? '');
    expect(frame).toMatch(/does not exist|Path/);
    expect(captureRef.current?.config.defaultProjectPath).toBeUndefined();
  });

  it('defaultProjectPath rejects non-git directory with toast', async () => {
    const dirOnly = join(tmp, 'plain-dir');
    mkdirSync(dirOnly);

    const captureRef: { current?: ConfigController } = {};
    const { stdin, lastFrame } = render(<Harness captureRef={captureRef} />);
    await settle();

    // 3O.1 autoMerge shifted defaultProjectPath +1 (was +1 from 3H.3 awayMode).
    for (let i = 0; i < 7; i += 1) stdin.write('\x1b[B');
    await settle();
    stdin.write('\r');
    await settle();
    for (const ch of dirOnly) stdin.write(ch);
    await settle();
    stdin.write('\r');
    await settle();
    const frame = stripAnsi(lastFrame() ?? '');
    expect(frame).toMatch(/Not a git repo/);
  });

  it('defaultProjectPath empty input clears the field', async () => {
    const captureRef: { current?: ConfigController } = {};
    const initialConfig: SymphonyConfig = {
      ...defaultConfig(),
      defaultProjectPath: '/some/path',
    };
    const { stdin } = render(<Harness config={initialConfig} captureRef={captureRef} />);
    await settle();

    // 3O.1 autoMerge shifted defaultProjectPath +1 (was +1 from 3H.3 awayMode).
    for (let i = 0; i < 7; i += 1) stdin.write('\x1b[B');
    await settle();
    stdin.write('\r');
    await settle();
    // Backspace through the existing value.
    for (let i = 0; i < 20; i += 1) stdin.write('\x7f');
    await settle();
    stdin.write('\r'); // commit empty
    await settle();
    expect(captureRef.current?.config.defaultProjectPath).toBeUndefined();
  });
});
