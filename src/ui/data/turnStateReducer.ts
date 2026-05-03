import type { MaestroEvent } from '../../orchestrator/maestro/process.js';

/**
 * Turn state for the chat status line.
 *
 * Drives `<StatusLine>` rendering (3B.3): `currentTool` selects a
 * musical-orchestral verb via `verbMap.ts`; `inFlight` gates whether
 * the line is rendered at all.
 *
 * Tracks ONLY the most recent in-flight `tool_use`. Concurrent tool
 * calls are uncommon in practice (Maestro mostly runs serial calls),
 * so we trade fidelity for simplicity here. If multi-tool concurrency
 * becomes a UX issue, upgrade to a full in-flight Set keyed by callId.
 */

export interface TurnState {
  readonly inFlight: boolean;
  readonly currentTool: string | null;
  readonly currentToolCallId: string | null;
  readonly currentToolStartedAt: number | null;
}

export const INITIAL_TURN_STATE: TurnState = {
  inFlight: false,
  currentTool: null,
  currentToolCallId: null,
  currentToolStartedAt: null,
};

const IDLE_AFTER_TOOL: Pick<TurnState, 'currentTool' | 'currentToolCallId' | 'currentToolStartedAt'> = {
  currentTool: null,
  currentToolCallId: null,
  currentToolStartedAt: null,
};

export interface TurnStateAction {
  readonly event: MaestroEvent;
  readonly ts: number;
}

export function turnStateReducer(state: TurnState, action: TurnStateAction): TurnState {
  const { event, ts } = action;
  switch (event.type) {
    case 'turn_started':
      return { inFlight: true, ...IDLE_AFTER_TOOL };

    case 'tool_use':
      return {
        inFlight: true,
        currentTool: event.name,
        currentToolCallId: event.callId,
        currentToolStartedAt: ts,
      };

    case 'tool_result':
      if (event.callId !== state.currentToolCallId) return state;
      return { ...state, ...IDLE_AFTER_TOOL };

    case 'turn_completed':
    case 'error':
      return { inFlight: false, ...IDLE_AFTER_TOOL };

    case 'system_init':
    case 'idle':
    case 'assistant_text':
    case 'assistant_thinking':
      return state;

    default: {
      // Audit 3B.1 m9: exhaustive guard — any new MaestroEvent variant
      // without a case here trips the never-assignment at compile time.
      const _exhaustive: never = event;
      return state;
    }
  }
}
