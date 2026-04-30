import { describe, it, expect } from 'vitest';
import {
  chatHistoryReducer,
  INITIAL_CHAT_HISTORY,
  type AssistantTurn,
  type ChatHistoryAction,
  type ChatHistoryState,
} from '../../../src/ui/data/chatHistoryReducer.js';
import type { MaestroEvent } from '../../../src/orchestrator/maestro/process.js';
import type { HookPayload } from '../../../src/orchestrator/maestro/hook-server.js';

const TS = 1714492800_000; // 2026-04-30 deterministic

function event(e: MaestroEvent, ts = TS): ChatHistoryAction {
  return { kind: 'event', event: e, ts };
}

function pushUser(text: string, ts = TS): ChatHistoryAction {
  return { kind: 'pushUser', text, ts };
}

function fold(actions: readonly ChatHistoryAction[]): ChatHistoryState {
  return actions.reduce(chatHistoryReducer, INITIAL_CHAT_HISTORY);
}

function lastAssistant(state: ChatHistoryState): AssistantTurn {
  const last = state.turns[state.turns.length - 1];
  if (last === undefined || last.kind !== 'assistant') {
    throw new Error('expected last turn to be assistant');
  }
  return last;
}

describe('chatHistoryReducer', () => {
  it('initial state is empty', () => {
    expect(INITIAL_CHAT_HISTORY).toEqual({ turns: [], nextTurnId: 0 });
  });

  it('appends a user turn on pushUser', () => {
    const state = fold([pushUser('hello')]);
    expect(state.turns).toHaveLength(1);
    expect(state.turns[0]).toEqual({
      kind: 'user',
      id: 'user-0',
      text: 'hello',
      ts: TS,
    });
    expect(state.nextTurnId).toBe(1);
  });

  it('opens an assistant turn on turn_started', () => {
    const state = fold([
      pushUser('hi'),
      event({ type: 'turn_started' }),
    ]);
    const t = lastAssistant(state);
    expect(t.id).toBe('assistant-1');
    expect(t.blocks).toEqual([]);
    expect(t.complete).toBe(false);
    expect(t.isError).toBe(false);
  });

  it('coalesces consecutive assistant_text into a single text block', () => {
    const state = fold([
      event({ type: 'turn_started' }),
      event({ type: 'assistant_text', text: 'Hello, ' }),
      event({ type: 'assistant_text', text: 'world' }),
      event({ type: 'assistant_text', text: '!' }),
    ]);
    const t = lastAssistant(state);
    expect(t.blocks).toEqual([{ kind: 'text', text: 'Hello, world!' }]);
  });

  it('opens a new text block when text follows a tool_use', () => {
    const state = fold([
      event({ type: 'turn_started' }),
      event({ type: 'assistant_text', text: 'Let me check.' }),
      event({
        type: 'tool_use',
        callId: 'c1',
        name: 'list_projects',
        input: {},
      }),
      event({ type: 'assistant_text', text: 'Found 3.' }),
    ]);
    const t = lastAssistant(state);
    expect(t.blocks).toHaveLength(3);
    expect(t.blocks[0]).toEqual({ kind: 'text', text: 'Let me check.' });
    expect(t.blocks[1]?.kind).toBe('tool');
    expect(t.blocks[2]).toEqual({ kind: 'text', text: 'Found 3.' });
  });

  it('opens a new text block when text follows a thinking block', () => {
    const state = fold([
      event({ type: 'turn_started' }),
      event({ type: 'assistant_thinking', text: 'reasoning…' }),
      event({ type: 'assistant_text', text: 'Hello.' }),
    ]);
    const t = lastAssistant(state);
    expect(t.blocks).toHaveLength(2);
    expect(t.blocks[0]).toEqual({ kind: 'thinking', text: 'reasoning…' });
    expect(t.blocks[1]).toEqual({ kind: 'text', text: 'Hello.' });
  });

  it('pairs tool_use with tool_result by callId', () => {
    const state = fold([
      event({ type: 'turn_started' }),
      event({
        type: 'tool_use',
        callId: 'c1',
        name: 'list_projects',
        input: { filter: 'all' },
      }),
      event({
        type: 'tool_result',
        callId: 'c1',
        content: '[]',
        isError: false,
      }),
    ]);
    const t = lastAssistant(state);
    expect(t.blocks).toHaveLength(1);
    const block = t.blocks[0];
    if (block === undefined || block.kind !== 'tool') {
      throw new Error('expected tool block');
    }
    expect(block.callId).toBe('c1');
    expect(block.input).toEqual({ filter: 'all' });
    expect(block.result).toEqual({ content: '[]', isError: false });
  });

  it('preserves order when multiple tool calls interleave', () => {
    const state = fold([
      event({ type: 'turn_started' }),
      event({ type: 'tool_use', callId: 'a', name: 'list_projects', input: {} }),
      event({ type: 'tool_use', callId: 'b', name: 'list_workers', input: {} }),
      event({ type: 'tool_result', callId: 'b', content: 'B', isError: false }),
      event({ type: 'tool_result', callId: 'a', content: 'A', isError: true }),
    ]);
    const t = lastAssistant(state);
    expect(t.blocks).toHaveLength(2);
    const [first, second] = t.blocks;
    if (first?.kind !== 'tool' || second?.kind !== 'tool') {
      throw new Error('expected two tool blocks');
    }
    expect(first.callId).toBe('a');
    expect(first.result).toEqual({ content: 'A', isError: true });
    expect(second.callId).toBe('b');
    expect(second.result).toEqual({ content: 'B', isError: false });
  });

  it('ignores tool_result with unknown callId (defensive)', () => {
    const state = fold([
      event({ type: 'turn_started' }),
      event({
        type: 'tool_result',
        callId: 'never-seen',
        content: 'orphan',
        isError: false,
      }),
    ]);
    const t = lastAssistant(state);
    expect(t.blocks).toEqual([]);
  });

  it('closes the turn on turn_completed and stamps isError', () => {
    const state = fold([
      event({ type: 'turn_started' }),
      event({ type: 'assistant_text', text: 'done' }),
      event({ type: 'turn_completed', isError: false, resultText: '' }),
    ]);
    const t = lastAssistant(state);
    expect(t.complete).toBe(true);
    expect(t.isError).toBe(false);
  });

  it('records the error reason and closes the turn on `error`', () => {
    const state = fold([
      event({ type: 'turn_started' }),
      event({ type: 'assistant_text', text: 'partial' }),
      event({ type: 'error', reason: 'rate limited' }),
    ]);
    const t = lastAssistant(state);
    expect(t.complete).toBe(true);
    expect(t.isError).toBe(true);
    expect(t.blocks).toEqual([
      { kind: 'text', text: 'partial' },
      { kind: 'text', text: 'Error: rate limited' },
    ]);
  });

  it('suppresses system_init events (no turn appended)', () => {
    const state = fold([
      event({ type: 'system_init', sessionId: 'abc-123' }),
    ]);
    expect(state.turns).toEqual([]);
    expect(state.nextTurnId).toBe(0);
  });

  it('suppresses idle events (no turn appended)', () => {
    const payload: HookPayload = { sessionId: 'abc', raw: {} };
    const idle: MaestroEvent = { type: 'idle', payload };
    const state = fold([event(idle)]);
    expect(state.turns).toEqual([]);
  });

  it('opens a defensive assistant turn when an event arrives without turn_started', () => {
    // Real Maestro always emits turn_started first, but defensive open
    // protects against lost events.
    const state = fold([
      event({ type: 'assistant_text', text: 'lost?' }),
    ]);
    const t = lastAssistant(state);
    expect(t.blocks).toEqual([{ kind: 'text', text: 'lost?' }]);
    expect(t.complete).toBe(false);
  });

  it('does NOT continue a previously-completed turn — opens a fresh one', () => {
    const state = fold([
      event({ type: 'turn_started' }),
      event({ type: 'assistant_text', text: 'first' }),
      event({ type: 'turn_completed', isError: false, resultText: '' }),
      event({ type: 'assistant_text', text: 'second' }),
    ]);
    expect(state.turns).toHaveLength(2);
    const second = state.turns[1];
    if (second?.kind !== 'assistant') throw new Error('expected assistant');
    expect(second.blocks).toEqual([{ kind: 'text', text: 'second' }]);
    expect(second.complete).toBe(false);
  });

  it('user turns interleave with assistant turns and increment ids', () => {
    const state = fold([
      pushUser('q1'),
      event({ type: 'turn_started' }),
      event({ type: 'assistant_text', text: 'a1' }),
      event({ type: 'turn_completed', isError: false, resultText: '' }),
      pushUser('q2'),
      event({ type: 'turn_started' }),
      event({ type: 'assistant_text', text: 'a2' }),
    ]);
    expect(state.turns.map((t) => t.id)).toEqual([
      'user-0',
      'assistant-1',
      'user-2',
      'assistant-3',
    ]);
  });

  it('preserves prior turn references when only the last turn mutates (memo invariant)', () => {
    const s1 = fold([
      pushUser('q1'),
      event({ type: 'turn_started' }),
      event({ type: 'assistant_text', text: 'partial' }),
    ]);
    const s2 = chatHistoryReducer(s1, event({ type: 'assistant_text', text: '…done' }));
    // Prior user turn must keep its ref so React.memo skips it.
    expect(s2.turns[0]).toBe(s1.turns[0]);
    // Last assistant turn IS a new ref.
    expect(s2.turns[1]).not.toBe(s1.turns[1]);
  });

  it('drops empty assistant_text events (no chunk noise)', () => {
    const state = fold([
      event({ type: 'turn_started' }),
      event({ type: 'assistant_text', text: '' }),
      event({ type: 'assistant_text', text: 'x' }),
    ]);
    const t = lastAssistant(state);
    expect(t.blocks).toEqual([{ kind: 'text', text: 'x' }]);
  });

  it('returns the same state object when no change applies (referential stability)', () => {
    const initial = fold([
      event({ type: 'turn_started' }),
      event({ type: 'assistant_text', text: 'hi' }),
    ]);
    const after = chatHistoryReducer(initial, event({ type: 'assistant_text', text: '' }));
    expect(after).toBe(initial);
  });
});

