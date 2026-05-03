import React from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { render } from 'ink-testing-library';
import {
  StatusLine,
  deriveHasOpenTextBlock,
} from '../../../../src/ui/panels/chat/StatusLine.js';
import { ThemeProvider } from '../../../../src/ui/theme/context.js';
import {
  INITIAL_TURN_STATE,
  type TurnState,
} from '../../../../src/ui/data/turnStateReducer.js';
import type { Turn } from '../../../../src/ui/data/chatHistoryReducer.js';

const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

const inFlight = (currentTool: string | null): TurnState => ({
  inFlight: true,
  currentTool,
  currentToolCallId: currentTool === null ? null : 'c1',
  currentToolStartedAt: 0,
});

// eslint-disable-next-line no-control-regex
const stripAnsi = (s: string): string => s.replace(/\x1b\[[\d;]*[a-zA-Z]/g, '');

beforeEach(() => {
  vi.useFakeTimers({
    toFake: [
      'setTimeout',
      'clearTimeout',
      'setInterval',
      'clearInterval',
      'performance',
      'Date',
    ],
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('deriveHasOpenTextBlock', () => {
  test('returns false on empty history', () => {
    expect(deriveHasOpenTextBlock([])).toBe(false);
  });

  test('returns false when last turn is user', () => {
    const turns: Turn[] = [{ kind: 'user', id: 'u-0', text: 'hi', ts: 0 }];
    expect(deriveHasOpenTextBlock(turns)).toBe(false);
  });

  test('returns false when last assistant turn is complete', () => {
    const turns: Turn[] = [
      {
        kind: 'assistant',
        id: 'a-0',
        blocks: [{ kind: 'text', blockId: 'a-0::b0', text: 'done' }],
        nextBlockSeq: 1,
        complete: true,
        isError: false,
        ts: 0,
      },
    ];
    expect(deriveHasOpenTextBlock(turns)).toBe(false);
  });

  test('returns true when last block is open text on incomplete assistant turn', () => {
    const turns: Turn[] = [
      {
        kind: 'assistant',
        id: 'a-0',
        blocks: [{ kind: 'text', blockId: 'a-0::b0', text: 'mid-' }],
        nextBlockSeq: 1,
        complete: false,
        isError: false,
        ts: 0,
      },
    ];
    expect(deriveHasOpenTextBlock(turns)).toBe(true);
  });

  test('returns false when last block is tool, not text', () => {
    const turns: Turn[] = [
      {
        kind: 'assistant',
        id: 'a-0',
        blocks: [
          { kind: 'tool', callId: 'c1', name: 'Read', input: {}, result: null },
        ],
        nextBlockSeq: 1,
        complete: false,
        isError: false,
        ts: 0,
      },
    ];
    expect(deriveHasOpenTextBlock(turns)).toBe(false);
  });
});

describe('<StatusLine/>', () => {
  test('renders an empty box (no glyphs) when not in flight', () => {
    const result = render(
      <ThemeProvider>
        <StatusLine turn={INITIAL_TURN_STATE} turns={[]} />
      </ThemeProvider>,
    );
    const frame = stripAnsi(result.lastFrame() ?? '');
    expect(frame).not.toMatch(/[▁▂▃▄▅▆▇█]/);
    expect(frame).not.toContain('Conducting');
    expect(frame).not.toContain('Listening');
    result.unmount();
  });

  test('renders EQ glyphs + verb when in flight', async () => {
    const result = render(
      <ThemeProvider>
        <StatusLine turn={inFlight('spawn_worker')} turns={[]} />
      </ThemeProvider>,
    );
    await flush();
    const frame = stripAnsi(result.lastFrame() ?? '');
    expect(frame).toMatch(/[▁▂▃▄▅▆▇█]{4}/);
    expect(frame).toContain('Conducting');
    result.unmount();
  });

  test('verb changes when currentTool changes', async () => {
    const result = render(
      <ThemeProvider>
        <StatusLine turn={inFlight('list_workers')} turns={[]} />
      </ThemeProvider>,
    );
    await flush();
    const frame = stripAnsi(result.lastFrame() ?? '');
    expect(frame).toContain('Listening');
    result.unmount();
  });

  test('shows Phrasing when no tool but text block is open', async () => {
    const turns: Turn[] = [
      {
        kind: 'assistant',
        id: 'a-0',
        blocks: [{ kind: 'text', blockId: 'a-0::b0', text: 'thinking out loud' }],
        nextBlockSeq: 1,
        complete: false,
        isError: false,
        ts: 0,
      },
    ];
    const result = render(
      <ThemeProvider>
        <StatusLine turn={inFlight(null)} turns={turns} />
      </ThemeProvider>,
    );
    await flush();
    const frame = stripAnsi(result.lastFrame() ?? '');
    expect(frame).toContain('Phrasing');
    result.unmount();
  });

  test('shows Composing when no tool, no text block', async () => {
    const result = render(
      <ThemeProvider>
        <StatusLine turn={inFlight(null)} turns={[]} />
      </ThemeProvider>,
    );
    await flush();
    const frame = stripAnsi(result.lastFrame() ?? '');
    expect(frame).toContain('Composing');
    result.unmount();
  });
});
