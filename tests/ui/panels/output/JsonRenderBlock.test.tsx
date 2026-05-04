import React from 'react';
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import stripAnsi from 'strip-ansi';
import { ThemeProvider } from '../../../../src/ui/theme/context.js';
import {
  JsonRenderBlock,
  FallbackPlainText,
} from '../../../../src/ui/panels/output/JsonRenderBlock.js';

function wrap(node: React.ReactNode): React.JSX.Element {
  return <ThemeProvider>{node}</ThemeProvider>;
}

function plainFrame(lastFrame: () => string | undefined): string {
  return stripAnsi(lastFrame() ?? '');
}

describe('JsonRenderBlock', () => {
  it('renders a Card{Heading, Text} spec', () => {
    const spec = {
      root: 'card-1',
      elements: {
        'card-1': {
          type: 'Card',
          props: { title: 'Status' },
          children: ['heading-1', 'text-1'],
        },
        'heading-1': { type: 'Heading', props: { text: 'All good' } },
        'text-1': { type: 'Text', props: { text: 'workers idle' } },
      },
    };
    const { lastFrame } = render(wrap(<JsonRenderBlock spec={spec} />));
    const frame = plainFrame(lastFrame);
    expect(frame).toContain('Status');
    expect(frame).toContain('All good');
    expect(frame).toContain('workers idle');
  });

  it('renders themed violet border for Card (truecolor escape present)', () => {
    const spec = {
      root: 'card-1',
      elements: {
        'card-1': {
          type: 'Card',
          props: { title: 'Border check' },
          children: ['t'],
        },
        t: { type: 'Text', props: { text: 'body' } },
      },
    };
    const { lastFrame } = render(wrap(<JsonRenderBlock spec={spec} />));
    const ansi = lastFrame() ?? '';
    // Violet `#7C6FEB` → `\x1b[38;2;124;111;235m`. The card border resolves
    // to `theme['jsonRenderBorder']` which is a ref to `defs.violet`.
    expect(ansi).toContain('\x1b[38;2;124;111;235m');
  });

  it('renders themed gold heading (truecolor escape present)', () => {
    const spec = {
      root: 'h',
      elements: {
        h: { type: 'Heading', props: { text: 'gold heading' } },
      },
    };
    const { lastFrame } = render(wrap(<JsonRenderBlock spec={spec} />));
    const ansi = lastFrame() ?? '';
    // Gold `#D4A843` → `\x1b[38;2;212;168;67m`.
    expect(ansi).toContain('\x1b[38;2;212;168;67m');
    expect(stripAnsi(ansi)).toContain('gold heading');
  });

  it('renders fallback for non-object spec', () => {
    const { lastFrame } = render(wrap(<JsonRenderBlock spec={'not an object'} />));
    const frame = plainFrame(lastFrame);
    expect(frame).toContain('json-render block failed');
    expect(frame).toContain('spec must be a json object');
  });

  it('renders fallback for spec missing root', () => {
    const { lastFrame } = render(
      wrap(<JsonRenderBlock spec={{ elements: { x: { type: 'Text', props: { text: 'orphan' } } } }} />),
    );
    const frame = plainFrame(lastFrame);
    expect(frame).toContain('spec.root must be a non-empty string');
  });

  it('renders fallback for spec whose root key is missing from elements', () => {
    const { lastFrame } = render(
      wrap(<JsonRenderBlock spec={{ root: 'missing', elements: {} }} />),
    );
    const frame = plainFrame(lastFrame);
    expect(frame).toContain('missing the root element "missing"');
  });

  it('renders fallback for spec with non-object elements', () => {
    const { lastFrame } = render(
      wrap(<JsonRenderBlock spec={{ root: 'x', elements: 'not an object' }} />),
    );
    const frame = plainFrame(lastFrame);
    expect(frame).toContain('spec.elements must be a json object');
  });

  it('truncates long raw spec dumps in fallback to 500 chars + ellipsis', () => {
    const longText = 'x'.repeat(800);
    const { lastFrame } = render(
      wrap(<JsonRenderBlock spec={longText} />),
    );
    const frame = plainFrame(lastFrame);
    // First 500 chars present, plus an ellipsis. The 800-char input
    // becomes JSON.stringify-ed (longer than the input), so the slice
    // includes leading-quote + many x's. Just confirm truncation happened.
    expect(frame).toContain('…');
    expect(frame.length).toBeLessThan(longText.length + 200);
  });
});

describe('FallbackPlainText (direct)', () => {
  it('renders the warning prefix and reason', () => {
    const { lastFrame } = render(
      wrap(<FallbackPlainText reason="oh no" raw="" />),
    );
    expect(plainFrame(lastFrame)).toContain('json-render block failed: oh no');
  });

  it('omits the muted raw line when raw is empty', () => {
    const { lastFrame } = render(
      wrap(<FallbackPlainText reason="r" raw="" />),
    );
    // Single visible line: just the warning.
    const lines = plainFrame(lastFrame).split('\n').filter((l) => l.trim().length > 0);
    expect(lines).toHaveLength(1);
  });

  it('shows raw under 500 chars verbatim', () => {
    const { lastFrame } = render(
      wrap(<FallbackPlainText reason="r" raw="short raw" />),
    );
    const frame = plainFrame(lastFrame);
    expect(frame).toContain('short raw');
    expect(frame).not.toContain('…');
  });
});
