import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { ThemeProvider } from '../../../../src/ui/theme/context.js';
import { InputBar } from '../../../../src/ui/panels/chat/InputBar.js';

function flush(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}

interface InputHarness {
  readonly stdin: { write: (data: string) => void };
  readonly lastFrame: () => string | undefined;
  readonly unmount: () => void;
}

function renderInput(onSubmit: (text: string) => void = () => {}): InputHarness {
  const result = render(
    <ThemeProvider>
      <InputBar onSubmit={onSubmit} />
    </ThemeProvider>,
  );
  return result as unknown as InputHarness;
}

const ENTER = '\r';
const CTRL_J = '\x0a';
const BACKSPACE = '\x7f';
const ESC = '\x1b';
const ARROW_LEFT = '\x1b[D';
const CTRL_A = '\x01';
const CTRL_E = '\x05';
const CTRL_K = '\x0b';
const CTRL_U = '\x15';
const CTRL_W = '\x17';

describe('InputBar', () => {
  it('shows the placeholder when empty', async () => {
    const { lastFrame, unmount } = renderInput();
    await flush();
    expect(lastFrame() ?? '').toContain('Tell Maestro what to do');
    unmount();
  });

  it('inserts typed characters and renders them', async () => {
    const { stdin, lastFrame, unmount } = renderInput();
    await flush();
    stdin.write('hi');
    await flush();
    expect(lastFrame() ?? '').toContain('hi');
    unmount();
  });

  it('submits on Enter and clears the buffer', async () => {
    const onSubmit = vi.fn<(text: string) => void>();
    const { stdin, lastFrame, unmount } = renderInput(onSubmit);
    await flush();
    stdin.write('hello');
    await flush();
    stdin.write(ENTER);
    await flush();
    expect(onSubmit).toHaveBeenCalledWith('hello');
    expect(lastFrame() ?? '').toContain('Tell Maestro what to do');
    unmount();
  });

  it('does NOT submit when buffer is whitespace-only', async () => {
    const onSubmit = vi.fn<(text: string) => void>();
    const { stdin, unmount } = renderInput(onSubmit);
    await flush();
    stdin.write('   ');
    await flush();
    stdin.write(ENTER);
    await flush();
    expect(onSubmit).not.toHaveBeenCalled();
    unmount();
  });

  it('Ctrl+J inserts a newline (universal fallback)', async () => {
    const onSubmit = vi.fn<(text: string) => void>();
    const { stdin, unmount } = renderInput(onSubmit);
    await flush();
    stdin.write('a');
    await flush();
    stdin.write(CTRL_J);
    await flush();
    stdin.write('b');
    await flush();
    stdin.write(ENTER);
    await flush();
    expect(onSubmit).toHaveBeenCalledWith('a\nb');
    unmount();
  });

  it('Backspace removes the previous character', async () => {
    const { stdin, lastFrame, unmount } = renderInput();
    await flush();
    stdin.write('abc');
    await flush();
    stdin.write(BACKSPACE);
    await flush();
    expect(lastFrame() ?? '').toContain('ab');
    unmount();
  });

  it('arrow keys move the cursor', async () => {
    const onSubmit = vi.fn<(text: string) => void>();
    const { stdin, unmount } = renderInput(onSubmit);
    await flush();
    stdin.write('abc');
    await flush();
    stdin.write(ARROW_LEFT);
    stdin.write(ARROW_LEFT);
    await flush();
    stdin.write('X');
    await flush();
    stdin.write(ENTER);
    await flush();
    expect(onSubmit).toHaveBeenCalledWith('aXbc');
    unmount();
  });

  it('Ctrl+A and Ctrl+E jump to line start/end', async () => {
    const onSubmit = vi.fn<(text: string) => void>();
    const { stdin, unmount } = renderInput(onSubmit);
    await flush();
    stdin.write('abc');
    await flush();
    stdin.write(CTRL_A);
    stdin.write('X');
    await flush();
    stdin.write(CTRL_E);
    stdin.write('Y');
    await flush();
    stdin.write(ENTER);
    await flush();
    expect(onSubmit).toHaveBeenCalledWith('XabcY');
    unmount();
  });

  it('Ctrl+K kills to end of line', async () => {
    const onSubmit = vi.fn<(text: string) => void>();
    const { stdin, unmount } = renderInput(onSubmit);
    await flush();
    stdin.write('abcdef');
    await flush();
    stdin.write(ARROW_LEFT);
    stdin.write(ARROW_LEFT);
    stdin.write(ARROW_LEFT);
    await flush();
    stdin.write(CTRL_K);
    await flush();
    stdin.write(ENTER);
    await flush();
    expect(onSubmit).toHaveBeenCalledWith('abc');
    unmount();
  });

  it('Ctrl+U kills to start of line', async () => {
    const onSubmit = vi.fn<(text: string) => void>();
    const { stdin, unmount } = renderInput(onSubmit);
    await flush();
    stdin.write('abcdef');
    await flush();
    stdin.write(ARROW_LEFT);
    stdin.write(ARROW_LEFT);
    stdin.write(ARROW_LEFT);
    await flush();
    stdin.write(CTRL_U);
    await flush();
    stdin.write(ENTER);
    await flush();
    expect(onSubmit).toHaveBeenCalledWith('def');
    unmount();
  });

  it('Ctrl+W kills the word before the cursor (bash readline semantics)', async () => {
    const onSubmit = vi.fn<(text: string) => void>();
    const { stdin, unmount } = renderInput(onSubmit);
    await flush();
    stdin.write('hello world');
    await flush();
    stdin.write(CTRL_W);
    await flush();
    stdin.write(ENTER);
    await flush();
    // bash `Ctrl+W` (unix-werase) removes the word, leaving the
    // whitespace between previous-word and cursor. Mirrors emdash's
    // terminal-keybindings behavior.
    expect(onSubmit).toHaveBeenCalledWith('hello ');
    unmount();
  });

  it('does NOT consume Tab or Escape (dispatcher handles those)', async () => {
    const onSubmit = vi.fn<(text: string) => void>();
    const { stdin, lastFrame, unmount } = renderInput(onSubmit);
    await flush();
    stdin.write('a');
    await flush();
    stdin.write('\t');
    await flush();
    stdin.write(ESC);
    await flush();
    expect(lastFrame() ?? '').toContain('a');
    unmount();
  });

  it('renders the error message below the input when provided', async () => {
    const { lastFrame, unmount } = render(
      <ThemeProvider>
        <InputBar onSubmit={() => {}} errorMessage="Wait for the previous turn to finish" />
      </ThemeProvider>,
    );
    await flush();
    expect(lastFrame() ?? '').toContain('Wait for the previous turn to finish');
    unmount();
  });

  it('does not handle keys when isActive is false', async () => {
    const onSubmit = vi.fn<(text: string) => void>();
    const result = render(
      <ThemeProvider>
        <InputBar onSubmit={onSubmit} isActive={false} />
      </ThemeProvider>,
    );
    const { stdin, unmount } = result as unknown as InputHarness;
    await flush();
    stdin.write('hello');
    await flush();
    stdin.write(ENTER);
    await flush();
    expect(onSubmit).not.toHaveBeenCalled();
    unmount();
  });
});
