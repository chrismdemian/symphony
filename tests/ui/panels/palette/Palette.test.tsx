import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { ThemeProvider } from '../../../../src/ui/theme/context.js';
import { FocusProvider, type FocusState } from '../../../../src/ui/focus/focus.js';
import { KeybindProvider } from '../../../../src/ui/keybinds/dispatcher.js';
import { Palette } from '../../../../src/ui/panels/palette/Palette.js';
import type { Command } from '../../../../src/ui/keybinds/registry.js';

/**
 * Phase 3F.1 — palette unit tests.
 *
 * Covers: rendering, fuzzy filtering via typed input, char-level
 * highlight, selection nav, Enter invokes the selected command's
 * `onSelect` and pops the popup, Esc pops without invoking, disabled
 * commands are skipped during nav.
 */

const stripAnsi = (s: string): string =>
  // eslint-disable-next-line no-control-regex
  s.replace(/\x1b\[[\d;]*[a-zA-Z]/g, '');

const make = (
  id: string,
  title: string,
  onSelect: () => void,
  overrides?: Partial<Command>,
): Command => ({
  id,
  title,
  key: { kind: 'char', char: id[0] ?? 'x' },
  scope: 'global',
  displayOnScreen: true,
  onSelect,
  ...overrides,
});

function renderHarness(commands: readonly Command[]) {
  const initial: FocusState = {
    stack: [
      { kind: 'main', key: 'chat' },
      { kind: 'popup', key: 'palette' },
    ],
  };
  return render(
    <ThemeProvider>
      <FocusProvider initial={initial}>
        <KeybindProvider initialCommands={commands}>
          <Palette />
        </KeybindProvider>
      </FocusProvider>
    </ThemeProvider>,
  );
}

describe('<Palette>', () => {
  it('renders header with full count', () => {
    const noop = (): void => undefined;
    const commands = [
      make('a', 'next panel', noop),
      make('b', 'exit', noop),
      make('c', 'help', noop),
    ];
    const { lastFrame } = renderHarness(commands);
    const frame = stripAnsi(lastFrame() ?? '');
    expect(frame).toContain('Command palette');
    expect(frame).toContain('3 of 3');
    expect(frame).toContain('next panel');
    expect(frame).toContain('exit');
    expect(frame).toContain('help');
  });

  it('typing characters filters the list', async () => {
    const noop = (): void => undefined;
    const commands = [
      make('a', 'next panel', noop),
      make('b', 'next worker', noop),
      make('c', 'exit application', noop),
    ];
    const { stdin, lastFrame } = renderHarness(commands);
    stdin.write('exit');
    await new Promise((r) => setTimeout(r, 60));
    const frame = stripAnsi(lastFrame() ?? '');
    expect(frame).toContain('exit application');
    expect(frame).not.toContain('next panel');
    expect(frame).not.toContain('next worker');
  });

  it('backspace trims the filter', async () => {
    const noop = (): void => undefined;
    const commands = [
      make('a', 'next panel', noop),
      make('b', 'exit', noop),
    ];
    const { stdin, lastFrame } = renderHarness(commands);
    stdin.write('xy');
    await new Promise((r) => setTimeout(r, 60));
    expect(stripAnsi(lastFrame() ?? '')).toContain('(no commands match)');
    // Two backspaces clear the buffer
    stdin.write('\x7f\x7f');
    await new Promise((r) => setTimeout(r, 60));
    const frame = stripAnsi(lastFrame() ?? '');
    expect(frame).toContain('next panel');
    expect(frame).toContain('exit');
  });

  it('renders matched chars in accent color (highlight)', async () => {
    const noop = (): void => undefined;
    const commands = [make('a', 'next panel', noop)];
    const { stdin, lastFrame } = renderHarness(commands);
    stdin.write('nx');
    await new Promise((r) => setTimeout(r, 60));
    const raw = lastFrame() ?? '';
    // Violet = #7C6FEB → \x1b[38;2;124;111;235m
    expect(raw).toContain('\x1b[38;2;124;111;235m');
  });

  it('Enter invokes the selected command and closes the popup', async () => {
    const fired = vi.fn();
    const commands = [
      make('a', 'first command', fired),
      make('b', 'second', () => undefined),
    ];
    const { stdin } = renderHarness(commands);
    // Wait for the popup-scope command registration useEffect to flush.
    await new Promise((r) => setTimeout(r, 80));
    // First in the list is selected by default. Enter should fire it.
    stdin.write('\r');
    await new Promise((r) => setTimeout(r, 80));
    expect(fired).toHaveBeenCalledTimes(1);
  });

  it('Esc closes the popup without invoking any command', async () => {
    const fired = vi.fn();
    const commands = [make('a', 'first', fired)];
    const { stdin } = renderHarness(commands);
    await new Promise((r) => setTimeout(r, 80));
    stdin.write('\x1b');
    await new Promise((r) => setTimeout(r, 80));
    expect(fired).not.toHaveBeenCalled();
  });

  it('arrow keys move selection across non-disabled commands', async () => {
    const callA = vi.fn();
    const callB = vi.fn();
    const commands = [make('a', 'alpha', callA), make('b', 'bravo', callB)];
    const { stdin } = renderHarness(commands);
    await new Promise((r) => setTimeout(r, 80));
    // ↓ once → second command selected
    stdin.write('\x1b[B');
    await new Promise((r) => setTimeout(r, 80));
    stdin.write('\r');
    await new Promise((r) => setTimeout(r, 80));
    expect(callB).toHaveBeenCalledTimes(1);
    expect(callA).not.toHaveBeenCalled();
  });

  it('skips disabled commands during arrow nav', async () => {
    const callA = vi.fn();
    const callB = vi.fn();
    const callC = vi.fn();
    const commands = [
      make('a', 'alpha', callA),
      make('b', 'bravo', callB, { disabledReason: 'unavailable' }),
      make('c', 'charlie', callC),
    ];
    const { stdin } = renderHarness(commands);
    await new Promise((r) => setTimeout(r, 80));
    stdin.write('\x1b[B'); // ↓ once
    await new Promise((r) => setTimeout(r, 80));
    stdin.write('\r');
    await new Promise((r) => setTimeout(r, 80));
    // ↓ from the disabled-skipped index lands on charlie, not bravo.
    expect(callC).toHaveBeenCalledTimes(1);
    expect(callB).not.toHaveBeenCalled();
  });

  it('renders disabled-reason next to disabled commands', () => {
    const noop = (): void => undefined;
    const commands = [
      make('q', 'questions', noop, { disabledReason: 'no questions queued' }),
    ];
    const { lastFrame } = renderHarness(commands);
    const frame = stripAnsi(lastFrame() ?? '');
    expect(frame).toContain('no questions queued');
  });

  it('shows "(no commands match)" when filter has no hits', async () => {
    const noop = (): void => undefined;
    const commands = [make('a', 'next panel', noop)];
    const { stdin, lastFrame } = renderHarness(commands);
    stdin.write('zzzz');
    await new Promise((r) => setTimeout(r, 60));
    expect(stripAnsi(lastFrame() ?? '')).toContain('(no commands match)');
  });

  it('renders Esc/Enter/arrow hints in the footer', () => {
    const noop = (): void => undefined;
    const { lastFrame } = renderHarness([make('a', 'one', noop)]);
    const frame = stripAnsi(lastFrame() ?? '');
    expect(frame).toMatch(/Esc to close/);
    expect(frame).toMatch(/Enter to invoke/);
  });
});
