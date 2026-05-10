import React from 'react';
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { ThemeProvider } from '../../../../src/ui/theme/context.js';
import { QueueHeader } from '../../../../src/ui/panels/workers/QueueHeader.js';

/**
 * Phase 3L — QueueHeader render tests. Verifies count formatting,
 * collapse glyph, and inverse-on-selected behavior.
 */

const ANSI = {
  violet: '\x1b[38;2;124;111;235m',
  muted: '\x1b[38;2;136;136;136m',
  inverse: '\x1b[7m',
  bold: '\x1b[1m',
} as const;

function frame(props: { count: number; collapsed: boolean; selected: boolean }): string {
  const { lastFrame, unmount } = render(
    <ThemeProvider>
      <QueueHeader {...props} />
    </ThemeProvider>,
  );
  const out = lastFrame() ?? '';
  unmount();
  return out;
}

describe('QueueHeader', () => {
  it('renders "1 pending" for a single entry (singular)', () => {
    const out = frame({ count: 1, collapsed: false, selected: false });
    expect(out).toContain('Queue');
    expect(out).toContain('(1 pending)');
  });

  it('renders "N pending" for multi entries (plural)', () => {
    const out = frame({ count: 4, collapsed: false, selected: false });
    expect(out).toContain('(4 pending)');
  });

  it('shows ▾ when expanded and ▸ when collapsed', () => {
    const expanded = frame({ count: 2, collapsed: false, selected: false });
    expect(expanded).toContain('▾');
    expect(expanded).not.toContain('▸');
    const collapsed = frame({ count: 2, collapsed: true, selected: false });
    expect(collapsed).toContain('▸');
    expect(collapsed).not.toContain('▾');
  });

  it('label renders in violet accent color', () => {
    const out = frame({ count: 1, collapsed: false, selected: false });
    expect(out).toContain(ANSI.violet);
    expect(out).toContain(ANSI.muted); // for the parenthesized count
  });

  it('selected row carries the inverse bit on the label', () => {
    const unselected = frame({ count: 1, collapsed: false, selected: false });
    const selected = frame({ count: 1, collapsed: false, selected: true });
    expect(unselected).not.toContain(ANSI.inverse);
    expect(selected).toContain(ANSI.inverse);
    // Selected row also renders the bar glyph in the leading gutter.
    expect(selected).toContain('▌');
  });
});
