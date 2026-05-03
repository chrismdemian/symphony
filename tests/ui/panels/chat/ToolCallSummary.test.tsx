import React from 'react';
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { ThemeProvider } from '../../../../src/ui/theme/context.js';
import { ToolCallSummary } from '../../../../src/ui/panels/chat/ToolCallSummary.js';
import type { Block } from '../../../../src/ui/data/chatHistoryReducer.js';

function toolBlock(
  partial: Partial<Extract<Block, { kind: 'tool' }>>,
): Extract<Block, { kind: 'tool' }> {
  return {
    kind: 'tool',
    callId: partial.callId ?? 'c1',
    name: partial.name ?? 'unknown_tool',
    input: partial.input ?? {},
    result: partial.result ?? null,
  };
}

function mount(block: Extract<Block, { kind: 'tool' }>) {
  return render(
    <ThemeProvider>
      <ToolCallSummary block={block} />
    </ThemeProvider>,
  );
}

describe('ToolCallSummary', () => {
  it('renders the pending state with … glyph', () => {
    const { lastFrame, unmount } = mount(toolBlock({ name: 'spawn_worker' }));
    const frame = lastFrame() ?? '';
    expect(frame).toContain('▸ spawn_worker');
    expect(frame).toContain('…');
    unmount();
  });

  it('renders the success state with ✓ and result body', () => {
    const { lastFrame, unmount } = mount(
      toolBlock({
        name: 'list_workers',
        result: { content: '3 workers', isError: false },
      }),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('▸ list_workers');
    expect(frame).toContain('✓');
    expect(frame).toContain('3 workers');
    unmount();
  });

  it('renders the error state with ✗ and ANSI-stripped result body', () => {
    const ansi = '\x1b[31mboom\x1b[0m: failure';
    const { lastFrame, unmount } = mount(
      toolBlock({
        name: 'finalize',
        result: { content: ansi, isError: true },
      }),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('▸ finalize');
    expect(frame).toContain('✗');
    expect(frame).toContain('boom: failure');
    expect(frame).not.toContain('\x1b[31m');
    unmount();
  });

  it('renders an extracted summary inline (file_path)', () => {
    const { lastFrame, unmount } = mount(
      toolBlock({
        name: 'Read',
        input: { file_path: '/tmp/example.txt' },
        result: { content: 'ok', isError: false },
      }),
    );
    expect(lastFrame() ?? '').toContain('▸ Read /tmp/example.txt');
    unmount();
  });

  it('skips the inline summary slot when input has no canonical field', () => {
    const { lastFrame, unmount } = mount(
      toolBlock({
        name: 'list_workers',
        input: {}, // empty
      }),
    );
    const frame = lastFrame() ?? '';
    // No double-space after the name when summary is empty.
    expect(frame).toContain('▸ list_workers …');
    unmount();
  });

  it('indents result body lines (multi-line preservation)', () => {
    const { lastFrame, unmount } = mount(
      toolBlock({
        name: 'Bash',
        input: { command: 'ls' },
        result: { content: 'a\nb\nc', isError: false },
      }),
    );
    const frame = lastFrame() ?? '';
    // Each line indented with two spaces.
    expect(frame).toMatch(/ {2}a/);
    expect(frame).toMatch(/ {2}b/);
    expect(frame).toMatch(/ {2}c/);
    unmount();
  });
});
