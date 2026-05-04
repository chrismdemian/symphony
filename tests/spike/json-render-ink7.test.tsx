/**
 * Phase 3D.2 — Path A spike.
 *
 * Verifies that `@json-render/ink@0.18.0` (peer-depped on `ink: ^6.0.0`)
 * renders a minimal `Card{Heading, Text}` spec under Ink 7.0.1 with the
 * pnpm `peerDependencyRules.allowedVersions` override in place.
 *
 * Spike PASS criteria:
 *   - `pnpm typecheck` clean
 *   - This test renders without runtime error
 *   - The rendered frame contains the expected text strings
 *   - No runtime crashes from Ink 6→7 API drift
 *
 * Spike FAIL → fall through to Path B (hand-rolled interpreter). The
 * spike commit is the canonical record either way; the phase review
 * documents the decision with concrete evidence.
 */
import React from 'react';
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { JSONUIProvider, Renderer, type Spec } from '@json-render/ink';

describe('Phase 3D.2 spike: @json-render/ink under Ink 7', () => {
  it('renders Card{Heading, Text} spec without crashing', () => {
    const spec: Spec = {
      root: 'card-1',
      elements: {
        'card-1': {
          type: 'Card',
          props: { title: 'Spike Card' },
          children: ['heading-1', 'text-1'],
        },
        'heading-1': {
          type: 'Heading',
          props: { text: 'Hello Ink 7', level: 'h2' },
        },
        'text-1': {
          type: 'Text',
          props: { text: 'json-render works under Ink 7' },
        },
      },
    };

    const { lastFrame } = render(
      <JSONUIProvider>
        <Renderer spec={spec} />
      </JSONUIProvider>,
    );
    const frame = lastFrame() ?? '';

    // The card renders the heading text + body text. Don't assert on
    // border characters or color escapes — those are theme-dependent
    // (we override them in Path A's registry, not in the spike).
    expect(frame).toContain('Hello Ink 7');
    expect(frame).toContain('json-render works under Ink 7');
  });

  it('renders standalone Text spec', () => {
    const spec: Spec = {
      root: 'text-only',
      elements: {
        'text-only': {
          type: 'Text',
          props: { text: 'minimal spike' },
        },
      },
    };
    const { lastFrame } = render(
      <JSONUIProvider>
        <Renderer spec={spec} />
      </JSONUIProvider>,
    );
    expect(lastFrame() ?? '').toContain('minimal spike');
  });

  it('handles null spec without crashing', () => {
    const { lastFrame } = render(
      <JSONUIProvider>
        <Renderer spec={null} />
      </JSONUIProvider>,
    );
    // Empty render is acceptable; the goal is "doesn't throw".
    expect(typeof (lastFrame() ?? '')).toBe('string');
  });
});
