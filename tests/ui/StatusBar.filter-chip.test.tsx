/**
 * Phase 5F — StatusBar `Filter: <name>` chip.
 *
 * The chip renders ONLY when BOTH:
 *   - tuiProjectFilter === 'active'
 *   - activeProject is set
 *
 * All other combinations suppress the chip — the bar stays clean when
 * the filter is inert.
 */
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { ThemeProvider } from '../../src/ui/theme/context.js';
import { StatusBar } from '../../src/ui/layout/StatusBar.js';

function renderStatusBar(props: React.ComponentProps<typeof StatusBar>) {
  const result = render(
    <ThemeProvider>
      <StatusBar {...props} />
    </ThemeProvider>,
  );
  const stripAnsi = (s: string): string =>
    // eslint-disable-next-line no-control-regex
    s.replace(/\x1b\[[\d;]*[a-zA-Z]/g, '');
  return {
    ...result,
    lastFrame: () => stripAnsi(result.lastFrame() ?? ''),
  };
}

const baseProps = {
  version: '0.0.0',
  mode: 'act' as const,
  projects: [],
  workers: [],
  sessionId: null,
};

describe('<StatusBar> filter chip — Phase 5F', () => {
  it('renders Filter chip when tuiProjectFilter=active AND activeProject is set', () => {
    const { lastFrame } = renderStatusBar({
      ...baseProps,
      activeProject: 'projA',
      tuiProjectFilter: 'active',
    });
    expect(lastFrame()).toContain('Filter:');
    expect(lastFrame()).toContain('projA');
  });

  it('omits Filter chip when tuiProjectFilter=all', () => {
    const { lastFrame } = renderStatusBar({
      ...baseProps,
      activeProject: 'projA',
      tuiProjectFilter: 'all',
    });
    expect(lastFrame()).not.toContain('Filter:');
  });

  it('omits Filter chip when activeProject is null (inert)', () => {
    const { lastFrame } = renderStatusBar({
      ...baseProps,
      activeProject: null,
      tuiProjectFilter: 'active',
    });
    expect(lastFrame()).not.toContain('Filter:');
  });

  it('omits Filter chip when activeProject is undefined', () => {
    const { lastFrame } = renderStatusBar({
      ...baseProps,
      tuiProjectFilter: 'active',
    });
    expect(lastFrame()).not.toContain('Filter:');
  });

  it('Filter chip placement: after Active chip', () => {
    const { lastFrame } = renderStatusBar({
      ...baseProps,
      activeProject: 'projA',
      tuiProjectFilter: 'active',
    });
    const text = lastFrame();
    const activeIdx = text.indexOf('Active:');
    const filterIdx = text.indexOf('Filter:');
    expect(activeIdx).toBeGreaterThanOrEqual(0);
    expect(filterIdx).toBeGreaterThan(activeIdx);
  });
});
