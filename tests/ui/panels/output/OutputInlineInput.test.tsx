import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { ThemeProvider } from '../../../../src/ui/theme/context.js';
import { OutputInlineInput } from '../../../../src/ui/panels/output/OutputInlineInput.js';

/**
 * Phase 3S — Mission Control inline input. Tests cover:
 *   - Esc cancels via onCancel (parent flips inject mode off).
 *   - Enter on a non-empty buffer triggers onSubmit with trimmed text.
 *   - Enter on an empty buffer is a no-op (avoids submitting whitespace).
 *   - Backspace removes the last typed char.
 *   - Modifier keystrokes (Ctrl/Meta/Tab/arrows) fall through to the
 *     dispatcher so Ctrl+Y, Ctrl+P, etc. still work mid-type.
 */

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[\d;]*[a-zA-Z]/g, '');
}

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await new Promise<void>((r) => setImmediate(r));
  }
}

// Esc disambiguation: Ink's input parser waits ~50ms after a lone
// `\x1b` to decide whether it's the Esc key or a CSI sequence prefix.
// Tests writing Esc need a real-time delay AFTER the keystroke.
async function settleAfterEsc(): Promise<void> {
  await new Promise<void>((r) => setTimeout(r, 100));
}

const ENTER = '\r';
const ESC = '\x1b';
const BACKSPACE = '\x7f';
const TAB = '\t';
const CTRL_Y = '\x19';
const CTRL_P = '\x10';
const ARROW_LEFT = '\x1b[D';
const ARROW_RIGHT = '\x1b[C';

describe('<OutputInlineInput> (3S Mission Control)', () => {
  it('renders the worker name and an empty buffer with cursor', () => {
    const { lastFrame, unmount } = render(
      <ThemeProvider>
        <OutputInlineInput
          workerName="Violin"
          onSubmit={vi.fn()}
          onCancel={vi.fn()}
        />
      </ThemeProvider>,
    );
    const frame = stripAnsi(lastFrame() ?? '');
    expect(frame).toContain('Violin');
    expect(frame).toContain('↪');
    unmount();
  });

  it('accepts typed characters and renders them inline', async () => {
    const { stdin, lastFrame, unmount } = render(
      <ThemeProvider>
        <OutputInlineInput
          workerName="Violin"
          onSubmit={vi.fn()}
          onCancel={vi.fn()}
        />
      </ThemeProvider>,
    );
    stdin.write('hello');
    await settle();
    expect(stripAnsi(lastFrame() ?? '')).toContain('hello');
    unmount();
  });

  it('backspace removes the last character', async () => {
    const { stdin, lastFrame, unmount } = render(
      <ThemeProvider>
        <OutputInlineInput
          workerName="Violin"
          onSubmit={vi.fn()}
          onCancel={vi.fn()}
        />
      </ThemeProvider>,
    );
    stdin.write('hello');
    await settle();
    stdin.write(BACKSPACE);
    await settle();
    expect(stripAnsi(lastFrame() ?? '')).toContain('hell');
    expect(stripAnsi(lastFrame() ?? '')).not.toMatch(/hello/);
    unmount();
  });

  it('Esc calls onCancel (no submit)', async () => {
    const onCancel = vi.fn();
    const onSubmit = vi.fn();
    const { stdin, unmount } = render(
      <ThemeProvider>
        <OutputInlineInput
          workerName="Violin"
          onSubmit={onSubmit}
          onCancel={onCancel}
        />
      </ThemeProvider>,
    );
    stdin.write('hello');
    await settle();
    stdin.write(ESC);
    await settleAfterEsc();
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
    unmount();
  });

  it('Enter submits the trimmed text', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const onCancel = vi.fn();
    const { stdin, unmount } = render(
      <ThemeProvider>
        <OutputInlineInput
          workerName="Violin"
          onSubmit={onSubmit}
          onCancel={onCancel}
        />
      </ThemeProvider>,
    );
    stdin.write('  hello world  ');
    await settle();
    stdin.write(ENTER);
    await settle();
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith('hello world');
    unmount();
  });

  it('Enter on empty buffer is a no-op', async () => {
    const onSubmit = vi.fn();
    const { stdin, unmount } = render(
      <ThemeProvider>
        <OutputInlineInput
          workerName="Violin"
          onSubmit={onSubmit}
          onCancel={vi.fn()}
        />
      </ThemeProvider>,
    );
    stdin.write(ENTER);
    await settle();
    expect(onSubmit).not.toHaveBeenCalled();
    unmount();
  });

  it('Enter on whitespace-only buffer is a no-op', async () => {
    const onSubmit = vi.fn();
    const { stdin, unmount } = render(
      <ThemeProvider>
        <OutputInlineInput
          workerName="Violin"
          onSubmit={onSubmit}
          onCancel={vi.fn()}
        />
      </ThemeProvider>,
    );
    stdin.write('   ');
    await settle();
    stdin.write(ENTER);
    await settle();
    expect(onSubmit).not.toHaveBeenCalled();
    unmount();
  });

  it('locks input while submit is in flight (no double-fire)', async () => {
    let resolveSubmit: (() => void) | undefined;
    const pending = new Promise<void>((r) => {
      resolveSubmit = r;
    });
    const onSubmit = vi.fn().mockReturnValue(pending);
    const { stdin, unmount } = render(
      <ThemeProvider>
        <OutputInlineInput
          workerName="Violin"
          onSubmit={onSubmit}
          onCancel={vi.fn()}
        />
      </ThemeProvider>,
    );
    stdin.write('hello');
    await settle();
    stdin.write(ENTER);
    await settle();
    stdin.write(ENTER);
    await settle();
    expect(onSubmit).toHaveBeenCalledTimes(1);
    resolveSubmit?.();
    await settle();
    unmount();
  });

  it('ignores Ctrl/Meta/Tab/arrow keys so dispatcher still routes them', async () => {
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    const { stdin, lastFrame, unmount } = render(
      <ThemeProvider>
        <OutputInlineInput
          workerName="Violin"
          onSubmit={onSubmit}
          onCancel={onCancel}
        />
      </ThemeProvider>,
    );
    stdin.write(CTRL_Y);
    stdin.write(CTRL_P);
    stdin.write(TAB);
    stdin.write(ARROW_LEFT);
    stdin.write(ARROW_RIGHT);
    await settle();
    const frame = stripAnsi(lastFrame() ?? '');
    expect(frame).not.toContain('y');
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
    unmount();
  });
});
