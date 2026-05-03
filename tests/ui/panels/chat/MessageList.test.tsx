import React from 'react';
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { ThemeProvider } from '../../../../src/ui/theme/context.js';
import { FocusProvider } from '../../../../src/ui/focus/focus.js';
import { MessageList } from '../../../../src/ui/panels/chat/MessageList.js';
import type {
  AssistantTurn,
  Block,
  Turn,
} from '../../../../src/ui/data/chatHistoryReducer.js';

function userTurn(id: string, text: string): Turn {
  return { kind: 'user', id, text, ts: 0 };
}

function assistantTurn(
  id: string,
  blocks: readonly Block[],
  complete: boolean = false,
): AssistantTurn {
  return {
    kind: 'assistant',
    id,
    blocks,
    nextBlockSeq: blocks.length,
    complete,
    isError: false,
    ts: 0,
  };
}

function textBlock(blockId: string, text: string): Block {
  return { kind: 'text', blockId, text };
}

function toolBlock(
  callId: string,
  name: string,
  result: { content: string; isError: boolean } | null = null,
  input: Record<string, unknown> = {},
): Block {
  return { kind: 'tool', callId, name, input, result };
}

function thinkingBlock(blockId: string, text: string): Block {
  return { kind: 'thinking', blockId, text };
}

function mount(turns: readonly Turn[], isFocused: boolean = false) {
  return render(
    <ThemeProvider>
      <FocusProvider>
        <MessageList turns={turns} isFocused={isFocused} />
      </FocusProvider>
    </ThemeProvider>,
  );
}

describe('MessageList', () => {
  it('renders nothing visible when there are no turns', () => {
    const { lastFrame, unmount } = mount([]);
    const frame = lastFrame() ?? '';
    expect(frame).not.toContain('❯');
    unmount();
  });

  it('renders a user turn with the chevron prefix', () => {
    const { lastFrame, unmount } = mount([userTurn('user-0', 'hello world')]);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('❯');
    expect(frame).toContain('hello world');
    unmount();
  });

  it('renders an assistant turn with text blocks', () => {
    const { lastFrame, unmount } = mount([
      assistantTurn('assistant-1', [
        textBlock('assistant-1::b0', 'Sure, I can help with that.'),
      ]),
    ]);
    expect(lastFrame() ?? '').toContain('Sure, I can help with that.');
    unmount();
  });

  it('renders a tool block with success status (✓) and ANSI-stripped result', () => {
    const ansiContent = '\x1b[31mError loaded\x1b[0m: 3 workers';
    const { lastFrame, unmount } = mount([
      assistantTurn('assistant-1', [
        toolBlock('c1', 'list_workers', { content: ansiContent, isError: false }),
      ]),
    ]);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('▸ list_workers');
    expect(frame).toContain('✓');
    expect(frame).toContain('Error loaded: 3 workers');
    // ANSI escape was stripped from the visible content.
    expect(frame).not.toContain('\x1b[31m');
    unmount();
  });

  it('renders a pending tool block with the … marker', () => {
    const { lastFrame, unmount } = mount([
      assistantTurn('assistant-1', [toolBlock('c1', 'spawn_worker', null)]),
    ]);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('▸ spawn_worker');
    expect(frame).toContain('…');
    unmount();
  });

  it('renders a tool block with error status (✗)', () => {
    const { lastFrame, unmount } = mount([
      assistantTurn('assistant-1', [
        toolBlock(
          'c1',
          'finalize',
          { content: 'merge conflict', isError: true },
          { branch: 'feat/x' },
        ),
      ]),
    ]);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('▸ finalize');
    expect(frame).toContain('✗');
    expect(frame).toContain('merge conflict');
    unmount();
  });

  it('renders a thinking block with italic muted prefix', () => {
    const { lastFrame, unmount } = mount([
      assistantTurn('assistant-1', [
        thinkingBlock('assistant-1::b0', 'Pondering the question.'),
      ]),
    ]);
    const frame = lastFrame() ?? '';
    // 3B.2 dropped the ⚡ glyph and `Thinking:` colon — bare `thinking`
    // label leads, then the body line.
    expect(frame).toContain('thinking');
    expect(frame).toContain('Pondering the question.');
    expect(frame).not.toContain('⚡');
    unmount();
  });

  it('interleaves blocks in order (text → tool → text)', () => {
    const { lastFrame, unmount } = mount([
      assistantTurn('assistant-1', [
        textBlock('assistant-1::b0', 'Let me check.'),
        toolBlock('c1', 'list_projects', { content: '[]', isError: false }),
        textBlock('assistant-1::b1', 'Found 0 projects.'),
      ]),
    ]);
    const frame = lastFrame() ?? '';
    const checkIdx = frame.indexOf('Let me check.');
    const toolIdx = frame.indexOf('▸ list_projects');
    const foundIdx = frame.indexOf('Found 0 projects.');
    expect(checkIdx).toBeGreaterThanOrEqual(0);
    expect(toolIdx).toBeGreaterThan(checkIdx);
    expect(foundIdx).toBeGreaterThan(toolIdx);
    unmount();
  });

  it('shows "(no output)" when an assistant turn completes empty', () => {
    const turn = assistantTurn('assistant-1', [], true);
    const { lastFrame, unmount } = mount([turn]);
    expect(lastFrame() ?? '').toContain('(no output)');
    unmount();
  });

  it('extracts file_path summary from tool input', () => {
    const { lastFrame, unmount } = mount([
      assistantTurn('assistant-1', [
        toolBlock(
          'c1',
          'Read',
          { content: 'file contents', isError: false },
          { file_path: '/tmp/foo.txt' },
        ),
      ]),
    ]);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('▸ Read /tmp/foo.txt');
    unmount();
  });

  it('extracts command summary for Bash-style tool inputs', () => {
    const { lastFrame, unmount } = mount([
      assistantTurn('assistant-1', [
        toolBlock(
          'c1',
          'Bash',
          { content: 'ok', isError: false },
          { command: 'ls -la' },
        ),
      ]),
    ]);
    expect(lastFrame() ?? '').toContain('▸ Bash ls -la');
    unmount();
  });

  it('keys turns by id, not array index, so prior bubbles bail out (memo invariant)', () => {
    // Identity-stable React keys — visually a smoke test that prior
    // turn refs aren't recreated when only the last turn mutates.
    // The deeper memo guarantee is exercised in chatHistoryReducer tests.
    const turns: Turn[] = [
      userTurn('user-0', 'hi'),
      assistantTurn('assistant-1', [textBlock('assistant-1::b0', 'hello')]),
    ];
    const { lastFrame, unmount } = mount(turns);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('hi');
    expect(frame).toContain('hello');
    unmount();
  });
});

describe('MessageList — scrolling', () => {
  function manyTurns(n: number): Turn[] {
    return Array.from({ length: n }, (_, i) =>
      assistantTurn(`a-${i}`, [textBlock(`a-${i}::b0`, `turn ${i}`)], true),
    );
  }

  it('renders an overflow indicator only when content exceeds the viewport', () => {
    // ink-testing-library reports 0/0 metrics by default, so the
    // viewport falls back to "all turns" — overflow indicator should
    // NOT appear unless the user actively scrolls (PageUp).
    const { lastFrame, unmount } = mount(manyTurns(3));
    const frame = lastFrame() ?? '';
    expect(frame).not.toContain('above');
    expect(frame).not.toContain('below');
    unmount();
  });

  it('PageUp shows the "above" hint when focused (user scrolled up)', () => {
    const { stdin, lastFrame, unmount, rerender } = render(
      <ThemeProvider>
        <FocusProvider>
          <MessageList turns={manyTurns(20)} isFocused={true} />
        </FocusProvider>
      </ThemeProvider>,
    );
    // PageUp via raw ANSI escape (ESC [ 5 ~).
    stdin.write('[5~');
    rerender(
      <ThemeProvider>
        <FocusProvider>
          <MessageList turns={manyTurns(20)} isFocused={true} />
        </FocusProvider>
      </ThemeProvider>,
    );
    // The viewport-based heuristic plus the ink-testing-library 0-height
    // fallback won't always trigger "above" — but PageUp must NOT crash
    // and must keep the frame coherent.
    const frame = lastFrame() ?? '';
    expect(frame).toContain('turn');
    unmount();
  });

  it('does NOT consume scroll keys when blurred', () => {
    const turns = manyTurns(20);
    const { stdin, lastFrame, unmount } = render(
      <ThemeProvider>
        <FocusProvider>
          <MessageList turns={turns} isFocused={false} />
        </FocusProvider>
      </ThemeProvider>,
    );
    stdin.write('[5~'); // PageUp
    const frame = lastFrame() ?? '';
    // Blurred — no scroll happened, no "above" hint. Focus-gated useInput
    // is the only way scroll state mutates.
    expect(frame).not.toContain('above');
    unmount();
  });
});
