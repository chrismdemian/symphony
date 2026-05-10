import React from 'react';
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { ThemeProvider } from '../../../../src/ui/theme/context.js';
import { QueueRow } from '../../../../src/ui/panels/workers/QueueRow.js';

/**
 * Phase 3L — QueueRow render tests. Verifies prefix formatting,
 * project parenthesization, and selected-state inversion.
 */

const ANSI = {
  text: '\x1b[38;2;224;224;224m',
  muted: '\x1b[38;2;136;136;136m',
  violet: '\x1b[38;2;124;111;235m',
  inverse: '\x1b[7m',
} as const;

function frame(props: {
  ordinal: number;
  featureIntentDisplay: string;
  projectDisplayName: string;
  selected: boolean;
}): string {
  const { lastFrame, unmount } = render(
    <ThemeProvider>
      <QueueRow {...props} />
    </ThemeProvider>,
  );
  const out = lastFrame() ?? '';
  unmount();
  return out;
}

describe('QueueRow', () => {
  it('renders "Next →" prefix for ordinal === 1', () => {
    const out = frame({
      ordinal: 1,
      featureIntentDisplay: 'Add search filters',
      projectDisplayName: 'MathScrabble',
      selected: false,
    });
    expect(out).toContain('Next →');
    expect(out).toContain('Add search filters');
    expect(out).toContain('(MathScrabble)');
  });

  it('renders right-aligned numeric prefix for ordinals 2..9', () => {
    const out = frame({
      ordinal: 2,
      featureIntentDisplay: 'Fix scraper timeout',
      projectDisplayName: 'CRE Pipeline',
      selected: false,
    });
    expect(out).toContain(' 2.');
    expect(out).toContain('Fix scraper timeout');
    expect(out).toContain('(CRE Pipeline)');
    // Critically: should NOT also contain "Next →"
    expect(out).not.toContain('Next →');
  });

  it('renders double-digit ordinal without leading space pad', () => {
    const out = frame({
      ordinal: 10,
      featureIntentDisplay: 'Task ten',
      projectDisplayName: 'P',
      selected: false,
    });
    expect(out).toContain('10.');
  });

  it('feature intent renders in text color, parens in muted', () => {
    const out = frame({
      ordinal: 2,
      featureIntentDisplay: 'task',
      projectDisplayName: 'P',
      selected: false,
    });
    expect(out).toContain(ANSI.text);
    expect(out).toContain(ANSI.muted);
  });

  it('selected row carries inverse and the accent gutter bar', () => {
    const unselected = frame({
      ordinal: 1,
      featureIntentDisplay: 'task',
      projectDisplayName: 'P',
      selected: false,
    });
    const selected = frame({
      ordinal: 1,
      featureIntentDisplay: 'task',
      projectDisplayName: 'P',
      selected: true,
    });
    expect(unselected).not.toContain(ANSI.inverse);
    expect(selected).toContain(ANSI.inverse);
    expect(selected).toContain('▌');
    expect(selected).toContain(ANSI.violet);
  });
});
