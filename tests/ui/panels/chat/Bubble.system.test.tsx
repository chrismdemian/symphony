import React from 'react';
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { ThemeProvider } from '../../../../src/ui/theme/context.js';
import { Bubble } from '../../../../src/ui/panels/chat/Bubble.js';
import { InstrumentNameProvider } from '../../../../src/ui/data/InstrumentNameContext.js';
import type { SystemTurn, Turn } from '../../../../src/ui/data/chatHistoryReducer.js';
import type { CompletionStatusKind } from '../../../../src/orchestrator/completion-summarizer-types.js';

/**
 * Phase 3K — system Bubble visual smoke. Renders each status variant
 * and checks for the expected glyph + theme color escape (truecolor
 * RGB sequences emitted by chalk via ink under the test setup
 * harness, which forces FORCE_COLOR=3).
 */

function makeSystemTurn(overrides: Partial<SystemTurn['summary']> = {}): Turn {
  return {
    kind: 'system',
    id: 'system-0',
    summary: {
      workerId: 'wk-1',
      workerName: 'Violin',
      projectName: 'MathScrabble',
      statusKind: 'completed',
      durationMs: 138_000,
      headline: 'Wired up the friend system endpoints',
      fallback: false,
      ...overrides,
    },
    ts: 0,
  };
}

function renderBubble(turn: Turn): { lastFrame: () => string } {
  const result = render(
    <ThemeProvider>
      <Bubble turn={turn} />
    </ThemeProvider>,
  );
  return { lastFrame: () => result.lastFrame() ?? '' };
}

// Locked palette (CLAUDE.md):
//   success-gold #D4A843 → \x1b[38;2;212;168;67m
//   error-red   #E06C75 → \x1b[38;2;224;108;117m
//   warning     goldLight (used for timeout — also a yellow tone)
//   text-light  #E0E0E0 → \x1b[38;2;224;224;224m
//   muted-gray  #888888 → \x1b[38;2;136;136;136m
const SUCCESS_GOLD_ESCAPE = '\x1b[38;2;212;168;67m';
const ERROR_RED_ESCAPE = '\x1b[38;2;224;108;117m';
const TEXT_LIGHT_ESCAPE = '\x1b[38;2;224;224;224m';
const MUTED_GRAY_ESCAPE = '\x1b[38;2;136;136;136m';

describe('SystemBubble — status variants', () => {
  it('completed → ✓ in success-gold', () => {
    const { lastFrame } = renderBubble(makeSystemTurn({ statusKind: 'completed' }));
    const frame = lastFrame();
    expect(frame).toContain('✓');
    expect(frame).toContain(SUCCESS_GOLD_ESCAPE);
  });

  it('failed → ✗ in error-red', () => {
    const { lastFrame } = renderBubble(makeSystemTurn({ statusKind: 'failed' }));
    const frame = lastFrame();
    expect(frame).toContain('✗');
    expect(frame).toContain(ERROR_RED_ESCAPE);
  });

  it('crashed → ✗ in error-red', () => {
    const { lastFrame } = renderBubble(makeSystemTurn({ statusKind: 'crashed' }));
    const frame = lastFrame();
    expect(frame).toContain('✗');
    expect(frame).toContain(ERROR_RED_ESCAPE);
  });

  it('timeout → ⏱ glyph', () => {
    const { lastFrame } = renderBubble(makeSystemTurn({ statusKind: 'timeout' }));
    const frame = lastFrame();
    expect(frame).toContain('⏱');
  });
});

describe('SystemBubble — header line', () => {
  it('renders "icon name (project) · duration"', () => {
    const { lastFrame } = renderBubble(makeSystemTurn());
    const frame = lastFrame();
    expect(frame).toContain('✓');
    expect(frame).toContain('Violin');
    expect(frame).toContain('(MathScrabble)');
    expect(frame).toContain('2m 18s');
  });

  it('renders "(unknown)" duration when durationMs is null', () => {
    const { lastFrame } = renderBubble(makeSystemTurn({ durationMs: null }));
    expect(lastFrame()).toContain('(unknown)');
  });

  it('Phase 3M — suppresses the entire (project) · duration tail when BOTH empty', () => {
    // Away-mode digest rows: workerName=Symphony, projectName='',
    // durationMs=null. The header must NOT render `() · (unknown)`.
    const { lastFrame } = renderBubble(
      makeSystemTurn({
        workerName: 'Symphony',
        projectName: '',
        durationMs: null,
      }),
    );
    const frame = lastFrame();
    expect(frame).toContain('Symphony');
    expect(frame).not.toContain('()');
    expect(frame).not.toContain('(unknown)');
  });

  it('Phase 3M — keeps tail when project present but duration missing (3K case unchanged)', () => {
    const { lastFrame } = renderBubble(
      makeSystemTurn({ projectName: 'MathScrabble', durationMs: null }),
    );
    const frame = lastFrame();
    expect(frame).toContain('(MathScrabble)');
    expect(frame).toContain('(unknown)');
  });
});

describe('SystemBubble — body lines', () => {
  it('renders headline in text color', () => {
    const { lastFrame } = renderBubble(makeSystemTurn());
    const frame = lastFrame();
    expect(frame).toContain('Wired up the friend system endpoints');
    expect(frame).toContain(TEXT_LIGHT_ESCAPE);
  });

  it('omits metrics + details when not provided', () => {
    const { lastFrame } = renderBubble(makeSystemTurn({}));
    const frame = lastFrame();
    expect(frame).not.toContain('12 tests passing');
  });

  it('renders metrics when provided in muted-gray', () => {
    const { lastFrame } = renderBubble(
      makeSystemTurn({ metrics: '12 tests passing' }),
    );
    const frame = lastFrame();
    expect(frame).toContain('12 tests passing');
    expect(frame).toContain(MUTED_GRAY_ESCAPE);
  });

  it('renders details when provided', () => {
    const { lastFrame } = renderBubble(
      makeSystemTurn({ details: 'left TODO in auth.ts:42' }),
    );
    expect(lastFrame()).toContain('left TODO in auth.ts:42');
  });

  it('renders all three body lines together', () => {
    const { lastFrame } = renderBubble(
      makeSystemTurn({
        headline: 'one',
        metrics: 'two',
        details: 'three',
      }),
    );
    const frame = lastFrame();
    expect(frame).toContain('one');
    expect(frame).toContain('two');
    expect(frame).toContain('three');
  });

  it('multi-line headlines split across rows', () => {
    const { lastFrame } = renderBubble(
      makeSystemTurn({ headline: 'line one\nline two' }),
    );
    const frame = lastFrame();
    expect(frame).toContain('line one');
    expect(frame).toContain('line two');
  });
});

describe('SystemBubble — every CompletionStatusKind handled', () => {
  const kinds: CompletionStatusKind[] = ['completed', 'failed', 'crashed', 'timeout'];
  it.each(kinds)('renders without throwing for %s', (kind) => {
    const { lastFrame } = renderBubble(makeSystemTurn({ statusKind: kind }));
    expect(lastFrame().length).toBeGreaterThan(0);
  });
});

describe('SystemBubble — render-time instrument name resolution (audit C1)', () => {
  function renderWithResolver(
    turn: Turn,
    resolver: (workerId: string) => string | undefined,
  ): { lastFrame: () => string } {
    const result = render(
      <ThemeProvider>
        <InstrumentNameProvider value={resolver}>
          <Bubble turn={turn} />
        </InstrumentNameProvider>
      </ThemeProvider>,
    );
    return { lastFrame: () => result.lastFrame() ?? '' };
  }

  it('uses the resolver name when defined for the workerId', () => {
    const { lastFrame } = renderWithResolver(
      makeSystemTurn({ workerId: 'wk-1', workerName: 'worker-fallback' }),
      (id) => (id === 'wk-1' ? 'Cello' : undefined),
    );
    const frame = lastFrame();
    expect(frame).toContain('Cello');
    expect(frame).not.toContain('worker-fallback');
  });

  it('falls back to summary.workerName when resolver returns undefined', () => {
    const { lastFrame } = renderWithResolver(
      makeSystemTurn({ workerId: 'wk-unknown', workerName: 'worker-fallback' }),
      () => undefined,
    );
    expect(lastFrame()).toContain('worker-fallback');
  });

  it('falls back to summary.workerName when resolver returns empty string', () => {
    const { lastFrame } = renderWithResolver(
      makeSystemTurn({ workerId: 'wk-1', workerName: 'worker-fallback' }),
      () => '',
    );
    expect(lastFrame()).toContain('worker-fallback');
  });

  it('uses summary.workerName when no provider in scope (default resolver)', () => {
    // No InstrumentNameProvider — context default is the noop resolver.
    const { lastFrame } = renderBubble(
      makeSystemTurn({ workerId: 'wk-1', workerName: 'fallback-name' }),
    );
    expect(lastFrame()).toContain('fallback-name');
  });
});
