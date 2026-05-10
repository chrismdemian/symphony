import { describe, it, expect } from 'vitest';
import {
  chatHistoryReducer,
  INITIAL_CHAT_HISTORY,
  type ChatHistoryAction,
  type ChatHistoryState,
  type SystemSummary,
  type SystemTurn,
} from '../../../src/ui/data/chatHistoryReducer.js';
import type { MaestroEvent } from '../../../src/orchestrator/maestro/process.js';

/**
 * Phase 3K — `pushSystem` action and deferred-flush behavior.
 *
 * The chat reducer's invariant: an in-flight assistant turn (last
 * unclosed assistant) must not have its bubble split by a system turn
 * appended at the end. The reducer buffers system turns in
 * `pendingSystems` while assistant is mid-stream, then drains on
 * `turn_completed` / `error` / `pushUser` / when the tail isn't an
 * unclosed assistant.
 */

const TS = 1714492800_000;

function event(e: MaestroEvent, ts = TS): ChatHistoryAction {
  return { kind: 'event', event: e, ts };
}

function pushUser(text: string, ts = TS): ChatHistoryAction {
  return { kind: 'pushUser', text, ts };
}

function pushSystem(summary: SystemSummary, ts = TS): ChatHistoryAction {
  return { kind: 'pushSystem', summary, ts };
}

function makeSummary(overrides: Partial<SystemSummary> = {}): SystemSummary {
  return {
    workerId: 'wk-1',
    workerName: 'Violin',
    projectName: 'MathScrabble',
    statusKind: 'completed',
    durationMs: 138_000,
    headline: 'wired endpoints',
    fallback: false,
    ...overrides,
  };
}

function fold(actions: readonly ChatHistoryAction[]): ChatHistoryState {
  return actions.reduce(chatHistoryReducer, INITIAL_CHAT_HISTORY);
}

describe('chatHistoryReducer — pushSystem', () => {
  it('appends a system turn at idle', () => {
    const state = fold([pushSystem(makeSummary())]);
    expect(state.turns).toHaveLength(1);
    const turn = state.turns[0] as SystemTurn;
    expect(turn.kind).toBe('system');
    expect(turn.id).toBe('system-0');
    expect(turn.summary.headline).toBe('wired endpoints');
    expect(turn.ts).toBe(TS);
    expect(state.nextTurnId).toBe(1);
    expect(state.pendingSystems).toEqual([]);
  });

  it('appends a system turn after a completed assistant turn', () => {
    const state = fold([
      pushUser('hi'),
      event({ type: 'turn_started' }),
      event({ type: 'assistant_text', text: 'hello' }),
      event({ type: 'turn_completed', isError: false, resultText: '' }),
      pushSystem(makeSummary()),
    ]);
    expect(state.turns).toHaveLength(3);
    expect(state.turns[2]?.kind).toBe('system');
    expect(state.pendingSystems).toEqual([]);
  });

  it('defers the system turn when the assistant is mid-stream', () => {
    const state = fold([
      pushUser('hi'),
      event({ type: 'turn_started' }),
      event({ type: 'assistant_text', text: 'thinking…' }),
      pushSystem(makeSummary()),
    ]);
    expect(state.turns).toHaveLength(2); // user + in-flight assistant
    expect(state.pendingSystems).toHaveLength(1);
    expect(state.nextTurnId).toBe(3); // system id was reserved
  });

  it('drains pending systems on turn_completed', () => {
    const state = fold([
      pushUser('hi'),
      event({ type: 'turn_started' }),
      event({ type: 'assistant_text', text: 'thinking…' }),
      pushSystem(makeSummary({ headline: 'first' })),
      pushSystem(makeSummary({ headline: 'second' })),
      event({ type: 'turn_completed', isError: false, resultText: '' }),
    ]);
    expect(state.turns).toHaveLength(4); // user + assistant + 2 systems
    expect(state.pendingSystems).toEqual([]);
    const sys1 = state.turns[2] as SystemTurn;
    const sys2 = state.turns[3] as SystemTurn;
    expect(sys1.summary.headline).toBe('first');
    expect(sys2.summary.headline).toBe('second');
  });

  it('drains pending systems on error event (closes the assistant turn)', () => {
    const state = fold([
      event({ type: 'turn_started' }),
      event({ type: 'assistant_text', text: 'mid' }),
      pushSystem(makeSummary({ headline: 'pending' })),
      event({ type: 'error', reason: 'boom' }),
    ]);
    expect(state.pendingSystems).toEqual([]);
    // Last turn after drain is the system row (assistant + error blocks
    // sit at index 0; system at index 1 since drain appends after).
    expect(state.turns[state.turns.length - 1]?.kind).toBe('system');
  });

  it('drains pending systems on pushUser (rare race: user types mid-stream)', () => {
    const state = fold([
      event({ type: 'turn_started' }),
      event({ type: 'assistant_text', text: 'mid' }),
      pushSystem(makeSummary({ headline: 'pending' })),
      pushUser('hello again'),
    ]);
    // Drain happens BEFORE the user turn appends.
    expect(state.pendingSystems).toEqual([]);
    expect(state.turns[state.turns.length - 1]?.kind).toBe('user');
    // System turn sits between assistant and user.
    expect(state.turns[state.turns.length - 2]?.kind).toBe('system');
  });

  it('does NOT split an in-flight assistant: text after deferred system stays in same bubble', () => {
    const state = fold([
      event({ type: 'turn_started' }),
      event({ type: 'assistant_text', text: 'thinking ' }),
      pushSystem(makeSummary({ headline: 'pending' })),
      event({ type: 'assistant_text', text: 'more' }),
    ]);
    // The assistant bubble accumulated both chunks; the system turn
    // is still pending, not interleaved.
    const assistant = state.turns[0];
    if (assistant?.kind !== 'assistant') throw new Error('expected assistant turn');
    expect(assistant.blocks).toHaveLength(1);
    const block = assistant.blocks[0];
    if (block?.kind !== 'text') throw new Error('expected text block');
    expect(block.text).toBe('thinking more');
    expect(state.pendingSystems).toHaveLength(1);
  });

  it('preserves pending order: FIFO drain', () => {
    const state = fold([
      event({ type: 'turn_started' }),
      pushSystem(makeSummary({ headline: 'A' })),
      pushSystem(makeSummary({ headline: 'B' })),
      pushSystem(makeSummary({ headline: 'C' })),
      event({ type: 'turn_completed', isError: false, resultText: '' }),
    ]);
    const headlines = state.turns
      .filter((t): t is SystemTurn => t.kind === 'system')
      .map((t) => t.summary.headline);
    expect(headlines).toEqual(['A', 'B', 'C']);
  });

  it('multiple system turns at idle each append immediately (no defer)', () => {
    const state = fold([
      pushSystem(makeSummary({ headline: 'one' })),
      pushSystem(makeSummary({ headline: 'two' })),
    ]);
    expect(state.turns).toHaveLength(2);
    expect(state.pendingSystems).toEqual([]);
  });

  it('SystemTurn carries all summary fields (metrics + details optional)', () => {
    const state = fold([
      pushSystem(
        makeSummary({
          headline: 'h',
          metrics: 'm',
          details: 'd',
          statusKind: 'failed',
          durationMs: null,
        }),
      ),
    ]);
    const turn = state.turns[0] as SystemTurn;
    expect(turn.summary.metrics).toBe('m');
    expect(turn.summary.details).toBe('d');
    expect(turn.summary.statusKind).toBe('failed');
    expect(turn.summary.durationMs).toBeNull();
  });
});
