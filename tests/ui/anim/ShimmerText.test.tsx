import React from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { ShimmerText } from '../../../src/ui/anim/ShimmerText.js';
import { ThemeProvider } from '../../../src/ui/theme/context.js';

const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

beforeEach(() => {
  vi.useFakeTimers({
    toFake: [
      'setTimeout',
      'clearTimeout',
      'setInterval',
      'clearInterval',
      'performance',
      'Date',
    ],
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('<ShimmerText/>', () => {
  test('renders plain accent text when isActive=false', () => {
    const result = render(
      <ThemeProvider>
        <ShimmerText text="Listening" isActive={false} />
      </ThemeProvider>,
    );
    const frame = result.lastFrame() ?? '';
    // eslint-disable-next-line no-control-regex
    const stripAnsi = (s: string): string => s.replace(/\x1b\[[\d;]*[a-zA-Z]/g, '');
    expect(stripAnsi(frame)).toContain('Listening');
    result.unmount();
  });

  test('emits ANSI 24-bit color escapes when active', async () => {
    const result = render(
      <ThemeProvider>
        <ShimmerText text="Conducting" isActive />
      </ThemeProvider>,
    );
    await flush();
    const frame = result.lastFrame() ?? '';
    // eslint-disable-next-line no-control-regex
    expect(frame).toMatch(/\x1b\[38;2;\d+;\d+;\d+m/);
    result.unmount();
  });

  test('frame 0 vs frame 5 produce different gradient runs', async () => {
    const result = render(
      <ThemeProvider>
        <ShimmerText text="Conducting Now" isActive />
      </ThemeProvider>,
    );
    await flush();
    const frame0 = result.lastFrame() ?? '';

    await vi.advanceTimersByTimeAsync(500);
    await flush();
    const frame5 = result.lastFrame() ?? '';

    expect(frame0).not.toBe(frame5);
    result.unmount();
  });

  test('renders empty fragment for empty text', () => {
    const result = render(
      <ThemeProvider>
        <ShimmerText text="" isActive />
      </ThemeProvider>,
    );
    const frame = result.lastFrame() ?? '';
    // eslint-disable-next-line no-control-regex
    const stripAnsi = (s: string): string => s.replace(/\x1b\[[\d;]*[a-zA-Z]/g, '');
    expect(stripAnsi(frame).trim()).toBe('');
    result.unmount();
  });

  test('respects NO_COLOR env (plain accent fallback emits ONE color escape, not per-char)', () => {
    const previous = process.env['NO_COLOR'];
    process.env['NO_COLOR'] = '1';
    try {
      const result = render(
        <ThemeProvider>
          <ShimmerText text="Resolving" isActive />
        </ThemeProvider>,
      );
      const frame = result.lastFrame() ?? '';
      // eslint-disable-next-line no-control-regex
      const escapes = [...frame.matchAll(/\x1b\[38;2;\d+;\d+;\d+m/g)];
      // Plain accent fallback wraps the whole label in a single Ink
      // <Text color> tag → exactly one truecolor escape. The gradient
      // path emits one per character (≥ "Resolving".length escapes).
      expect(escapes.length).toBe(1);
      result.unmount();
    } finally {
      if (previous === undefined) {
        delete process.env['NO_COLOR'];
      } else {
        process.env['NO_COLOR'] = previous;
      }
    }
  });
});
