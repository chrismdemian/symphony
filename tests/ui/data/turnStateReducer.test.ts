import { describe, it, expect } from 'vitest';
import {
  INITIAL_TURN_STATE,
  turnStateReducer,
  type TurnState,
  type TurnStateAction,
} from '../../../src/ui/data/turnStateReducer.js';
import type { MaestroEvent } from '../../../src/orchestrator/maestro/process.js';
import type { HookPayload } from '../../../src/orchestrator/maestro/hook-server.js';

const TS = 1714492800_000;

function step(state: TurnState, e: MaestroEvent, ts = TS): TurnState {
  const action: TurnStateAction = { event: e, ts };
  return turnStateReducer(state, action);
}

describe('turnStateReducer', () => {
  it('initial state is idle', () => {
    expect(INITIAL_TURN_STATE).toEqual({
      inFlight: false,
      currentTool: null,
      currentToolCallId: null,
      currentToolStartedAt: null,
    });
  });

  it('turn_started flips inFlight true with no current tool', () => {
    const next = step(INITIAL_TURN_STATE, { type: 'turn_started' });
    expect(next.inFlight).toBe(true);
    expect(next.currentTool).toBeNull();
  });

  it('tool_use captures name + callId + ts', () => {
    const after = [
      { type: 'turn_started' as const },
      {
        type: 'tool_use' as const,
        callId: 'c1',
        name: 'spawn_worker',
        input: { prompt: 'x' },
      },
    ].reduce<TurnState>((s, e) => step(s, e, 42), INITIAL_TURN_STATE);
    expect(after).toEqual({
      inFlight: true,
      currentTool: 'spawn_worker',
      currentToolCallId: 'c1',
      currentToolStartedAt: 42,
    });
  });

  it('tool_result with matching callId clears the current tool but keeps inFlight', () => {
    const after = [
      { type: 'turn_started' as const },
      {
        type: 'tool_use' as const,
        callId: 'c1',
        name: 'list_workers',
        input: {},
      },
      {
        type: 'tool_result' as const,
        callId: 'c1',
        content: '[]',
        isError: false,
      },
    ].reduce<TurnState>((s, e) => step(s, e), INITIAL_TURN_STATE);
    expect(after).toEqual({
      inFlight: true,
      currentTool: null,
      currentToolCallId: null,
      currentToolStartedAt: null,
    });
  });

  it('tool_result with non-matching callId is a no-op', () => {
    const initial: TurnState = {
      inFlight: true,
      currentTool: 'spawn_worker',
      currentToolCallId: 'c1',
      currentToolStartedAt: TS,
    };
    const after = step(initial, {
      type: 'tool_result',
      callId: 'other',
      content: '',
      isError: false,
    });
    expect(after).toBe(initial);
  });

  it('turn_completed clears tool and flips inFlight false', () => {
    const initial: TurnState = {
      inFlight: true,
      currentTool: 'audit_changes',
      currentToolCallId: 'c2',
      currentToolStartedAt: TS,
    };
    const after = step(initial, { type: 'turn_completed', isError: false, resultText: '' });
    expect(after).toEqual(INITIAL_TURN_STATE);
  });

  it('error clears tool and flips inFlight false', () => {
    const initial: TurnState = {
      inFlight: true,
      currentTool: 'finalize',
      currentToolCallId: 'c3',
      currentToolStartedAt: TS,
    };
    const after = step(initial, { type: 'error', reason: 'boom' });
    expect(after).toEqual(INITIAL_TURN_STATE);
  });

  it('most recent tool_use overwrites prior tool tracking', () => {
    const after = [
      { type: 'turn_started' as const },
      { type: 'tool_use' as const, callId: 'a', name: 'list_workers', input: {} },
      { type: 'tool_use' as const, callId: 'b', name: 'spawn_worker', input: {} },
    ].reduce<TurnState>((s, e) => step(s, e), INITIAL_TURN_STATE);
    expect(after.currentTool).toBe('spawn_worker');
    expect(after.currentToolCallId).toBe('b');
  });

  it('text + thinking events are no-ops', () => {
    const initial: TurnState = {
      inFlight: true,
      currentTool: 'list_projects',
      currentToolCallId: 'c1',
      currentToolStartedAt: TS,
    };
    expect(step(initial, { type: 'assistant_text', text: 'hi' })).toBe(initial);
    expect(step(initial, { type: 'assistant_thinking', text: 'why' })).toBe(initial);
  });

  it('system_init + idle are no-ops', () => {
    const idlePayload: HookPayload = { sessionId: 'x', raw: {} };
    expect(step(INITIAL_TURN_STATE, { type: 'system_init', sessionId: 'abc' })).toBe(
      INITIAL_TURN_STATE,
    );
    expect(step(INITIAL_TURN_STATE, { type: 'idle', payload: idlePayload })).toBe(
      INITIAL_TURN_STATE,
    );
  });
});
