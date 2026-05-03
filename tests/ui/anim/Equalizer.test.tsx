import React from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { Equalizer, EQUALIZER_GLYPHS, renderBars } from '../../../src/ui/anim/Equalizer.js';
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

describe('renderBars (pure)', () => {
  test('returns 4 glyphs from the EQ glyph set at any time', () => {
    for (const t of [0, 90, 180, 360, 1234, 9999]) {
      const bars = renderBars(t);
      expect(bars).toHaveLength(4);
      for (const ch of bars) {
        expect(EQUALIZER_GLYPHS).toContain(ch);
      }
    }
  });

  test('columns are not all the same glyph (phase staggered)', () => {
    // At t=0, sin(0)=0, sin(π/2)=1, sin(π)=0, sin(3π/2)=-1.
    // Normalized: 0.5, 1.0, 0.5, 0.0 → distinct glyph indices.
    const bars = renderBars(0);
    const set = new Set(bars);
    expect(set.size).toBeGreaterThan(1);
  });

  test('different times produce different bar patterns', () => {
    expect(renderBars(0)).not.toBe(renderBars(180));
  });
});

describe('<Equalizer/>', () => {
  test('renders a flat baseline when isActive=false', () => {
    const result = render(
      <ThemeProvider>
        <Equalizer isActive={false} />
      </ThemeProvider>,
    );
    const frame = result.lastFrame() ?? '';
    expect(frame).toContain('▁▁▁▁');
    result.unmount();
  });

  test('animates across fake-timer ticks', async () => {
    const result = render(
      <ThemeProvider>
        <Equalizer isActive />
      </ThemeProvider>,
    );
    await flush();

    const frame0 = result.lastFrame() ?? '';

    // Advance ~5 ticks at 90ms each.
    await vi.advanceTimersByTimeAsync(450);
    await flush();
    const frame5 = result.lastFrame() ?? '';

    // The captured frames must contain a 4-glyph bar pattern.
    // eslint-disable-next-line no-control-regex
    const stripAnsi = (s: string): string => s.replace(/\x1b\[[\d;]*[a-zA-Z]/g, '');
    const bars0 = stripAnsi(frame0);
    const bars5 = stripAnsi(frame5);

    // The animation must have progressed — at least one bar height differs.
    expect(bars0).not.toBe(bars5);
    result.unmount();
  });
});
