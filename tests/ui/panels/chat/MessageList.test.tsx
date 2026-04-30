import React from 'react';
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { ThemeProvider } from '../../../../src/ui/theme/context.js';
import { MessageList } from '../../../../src/ui/panels/chat/MessageList.js';
import type { Turn } from '../../../../src/ui/data/chatHistoryReducer.js';

function userTurn(id: string, text: string): Turn {
  return { kind: 'user', id, text, ts: 0 };
}

function assistantTurn(
  id: string,
  blocks: AssistantBlocks,
): Turn {
  return {
    kind: 'assistant',
    id,
    blocks,
    complete: false,
    isError: false,
    ts: 0,
  };
}

type AssistantBlocks = Extract<Turn, { kind: 'assistant' }>['blocks'];

describe('MessageList', () => {
  it('renders the empty state when there are no turns', () => {
    const { lastFrame, unmount } = render(
      <ThemeProvider>
        <MessageList turns={[]} />
      </ThemeProvider>,
    );
    expect(lastFrame() ?? '').toContain('Start by typing a message below.');
    unmount();
  });

  it('renders a user turn with the chevron prefix', () => {
    const { lastFrame, unmount } = render(
      <ThemeProvider>
        <MessageList turns={[userTurn('user-0', 'hello world')]} />
      </ThemeProvider>,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('❯');
    expect(frame).toContain('hello world');
    unmount();
  });

  it('renders an assistant turn with text blocks', () => {
    const { lastFrame, unmount } = render(
      <ThemeProvider>
        <MessageList
          turns={[
            assistantTurn('assistant-1', [{ kind: 'text', text: 'Sure, I can help with that.' }]),
          ]}
        />
      </ThemeProvider>,
    );
    expect(lastFrame() ?? '').toContain('Sure, I can help with that.');
    unmount();
  });

  it('renders a tool block stub with status marker', () => {
    const { lastFrame, unmount } = render(
      <ThemeProvider>
        <MessageList
          turns={[
            assistantTurn('assistant-1', [
              {
                kind: 'tool',
                callId: 'c1',
                name: 'list_workers',
                input: {},
                result: { content: '[]', isError: false },
              },
            ]),
          ]}
        />
      </ThemeProvider>,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('▸ list_workers');
    expect(frame).toContain('✓');
    unmount();
  });

  it('renders a pending tool block with the … marker', () => {
    const { lastFrame, unmount } = render(
      <ThemeProvider>
        <MessageList
          turns={[
            assistantTurn('assistant-1', [
              {
                kind: 'tool',
                callId: 'c1',
                name: 'spawn_worker',
                input: {},
                result: null,
              },
            ]),
          ]}
        />
      </ThemeProvider>,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('▸ spawn_worker');
    expect(frame).toContain('…');
    unmount();
  });

  it('renders a thinking block stub with the ⚡ Thinking prefix', () => {
    const { lastFrame, unmount } = render(
      <ThemeProvider>
        <MessageList
          turns={[
            assistantTurn('assistant-1', [{ kind: 'thinking', text: 'Pondering the question.' }]),
          ]}
        />
      </ThemeProvider>,
    );
    expect(lastFrame() ?? '').toContain('⚡ Thinking: Pondering the question.');
    unmount();
  });

  it('interleaves blocks in order (text → tool → text)', () => {
    const { lastFrame, unmount } = render(
      <ThemeProvider>
        <MessageList
          turns={[
            assistantTurn('assistant-1', [
              { kind: 'text', text: 'Let me check.' },
              {
                kind: 'tool',
                callId: 'c1',
                name: 'list_projects',
                input: {},
                result: { content: '[]', isError: false },
              },
              { kind: 'text', text: 'Found 0 projects.' },
            ]),
          ]}
        />
      </ThemeProvider>,
    );
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
    const turn: Turn = {
      kind: 'assistant',
      id: 'assistant-1',
      blocks: [],
      complete: true,
      isError: false,
      ts: 0,
    };
    const { lastFrame, unmount } = render(
      <ThemeProvider>
        <MessageList turns={[turn]} />
      </ThemeProvider>,
    );
    expect(lastFrame() ?? '').toContain('(no output)');
    unmount();
  });
});
