import React from 'react';
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { ThemeProvider } from '../../../../src/ui/theme/context.js';
import { ThinkingBubble } from '../../../../src/ui/panels/chat/ThinkingBubble.js';
import type { Block } from '../../../../src/ui/data/chatHistoryReducer.js';

function thinkingBlock(text: string): Extract<Block, { kind: 'thinking' }> {
  return { kind: 'thinking', blockId: 'assistant-0::b0', text };
}

describe('ThinkingBubble', () => {
  it('renders the bare `thinking` label and the body text', () => {
    const { lastFrame, unmount } = render(
      <ThemeProvider>
        <ThinkingBubble block={thinkingBlock('what if the cache is stale')} />
      </ThemeProvider>,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('thinking');
    expect(frame).toContain('what if the cache is stale');
    // No glyph or colon — project no-emoji rule.
    expect(frame).not.toContain('⚡');
    expect(frame).not.toContain('Thinking:');
    unmount();
  });

  it('preserves multi-line thinking content', () => {
    const { lastFrame, unmount } = render(
      <ThemeProvider>
        <ThinkingBubble block={thinkingBlock('first line\nsecond line\nthird')} />
      </ThemeProvider>,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('first line');
    expect(frame).toContain('second line');
    expect(frame).toContain('third');
    unmount();
  });

  it('renders an empty body line as a single space (no collapse)', () => {
    const { lastFrame, unmount } = render(
      <ThemeProvider>
        <ThinkingBubble block={thinkingBlock('a\n\nb')} />
      </ThemeProvider>,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('a');
    expect(frame).toContain('b');
    unmount();
  });
});
