import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render } from 'ink-testing-library';
import stripAnsi from 'strip-ansi';
import { ThemeProvider } from '../../../../src/ui/theme/context.js';
import {
  JsonRenderBlock,
  FallbackPlainText,
  JsonRenderErrorBoundary,
  NoopFocusProvider,
} from '../../../../src/ui/panels/output/JsonRenderBlock.js';
import { symphonyTheme } from '../../../../src/ui/theme/theme.js';

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

// Audit M1: the boundary's componentDidCatch path was unexercised by
// the JsonRenderBlock cases above (which only trip the structural
// validator). Test it directly so a future Ink/json-render
// API drift that throws inside Renderer surfaces as a fallback row
// rather than a panel-killing crash.
describe('JsonRenderErrorBoundary (direct)', () => {
  function Throw({ message }: { readonly message: string }): React.JSX.Element {
    throw new Error(message);
  }

  it('renders FallbackPlainText with the thrown error message', () => {
    const theme = symphonyTheme();
    // Suppress React's "Uncaught error" + componentStack noise in test
    // output — the boundary is doing its job, the noise is just chatter.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const { lastFrame } = render(
        wrap(
          <JsonRenderErrorBoundary raw="<spec body>" theme={theme}>
            <Throw message="boom from renderer" />
          </JsonRenderErrorBoundary>,
        ),
      );
      const frame = plainFrame(lastFrame);
      expect(frame).toContain('json-render block failed: boom from renderer');
      expect(frame).toContain('<spec body>');
    } finally {
      errSpy.mockRestore();
    }
  });

  it('renders children unchanged when nothing throws', () => {
    const theme = symphonyTheme();
    const { lastFrame } = render(
      wrap(
        <JsonRenderErrorBoundary raw="<spec body>" theme={theme}>
          <FallbackPlainText reason="(this is the child rendering normally)" raw="x" />
        </JsonRenderErrorBoundary>,
      ),
    );
    const frame = plainFrame(lastFrame);
    expect(frame).toContain('this is the child rendering normally');
  });
});

// Phase 4E focus shim: json-render's `<JSONUIProvider>` hardwires an
// internal `<FocusProvider>` that registers an Ink `useInput` Tab
// handler. The output panel can mount N `<JsonRenderBlock>` at once
// (one per worker completion `display`); Ink fans every keypress to
// every mounted handler, so N FocusProviders would rival Symphony's
// `KeybindProvider` Tab cycle. We substitute `<NoopFocusProvider>` and
// compose the other four providers by hand. The definitive observable
// proof — Tab still drives Symphony's panel cycle with display blocks
// mounted — is `pnpm smoke:4e` (real PTY; keystroke/focus behavior is
// mock-fragile under ink-testing-library + React 19 per the 3J/3E
// gotchas). These unit tests lock the structural invariant.
describe('NoopFocusProvider / focus shim (Phase 4E)', () => {
  it('is a transparent passthrough (renders children verbatim)', () => {
    const { lastFrame } = render(
      wrap(
        <NoopFocusProvider>
          <FallbackPlainText reason="child renders" raw="" />
        </NoopFocusProvider>,
      ),
    );
    expect(plainFrame(lastFrame)).toContain('child renders');
  });

  it('renders multiple concurrent JsonRenderBlock instances without error', () => {
    // The multi-instance case 4E introduces (one display per completed
    // worker). With json-render's FocusProvider this mounted N rival
    // Tab `useInput` handlers; with the shim it mounts zero.
    const mk = (n: number) => ({
      root: `c${n}`,
      elements: {
        [`c${n}`]: {
          type: 'Card',
          props: { title: `Worker ${n}` },
          children: [`t${n}`],
        },
        [`t${n}`]: { type: 'Text', props: { text: `did ${n} things` } },
      },
    });
    const { lastFrame } = render(
      wrap(
        <>
          <JsonRenderBlock spec={mk(1)} />
          <JsonRenderBlock spec={mk(2)} />
          <JsonRenderBlock spec={mk(3)} />
        </>,
      ),
    );
    const frame = plainFrame(lastFrame);
    expect(frame).toContain('Worker 1');
    expect(frame).toContain('did 1 things');
    expect(frame).toContain('Worker 3');
    expect(frame).toContain('did 3 things');
  });

  it('a Tab keypress with display blocks mounted neither throws nor mutates output', () => {
    const spec = {
      root: 'c',
      elements: {
        c: { type: 'Card', props: { title: 'Inert' }, children: ['t'] },
        t: { type: 'Text', props: { text: 'no focus ring' } },
      },
    };
    const { lastFrame, stdin } = render(
      wrap(
        <>
          <JsonRenderBlock spec={spec} />
          <JsonRenderBlock spec={spec} />
        </>,
      ),
    );
    const before = plainFrame(lastFrame);
    stdin.write('\t');
    const after = plainFrame(lastFrame);
    expect(after).toBe(before);
    expect(after).toContain('no focus ring');
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
