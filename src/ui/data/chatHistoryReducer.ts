import type { MaestroEvent } from '../../orchestrator/maestro/process.js';
import type { CompletionStatusKind } from '../../orchestrator/completion-summarizer-types.js';

/**
 * Chat history reducer — content-block model.
 *
 * Coalesces a stream of MaestroEvents into a `Turn[]` history. Mirrors
 * Anthropic's content-block layout: a turn is an ordered list of
 * `text | tool | thinking | error` blocks, opened/closed by event boundaries.
 *
 * Critical invariants (Plan-agent critique, Known Gotchas):
 *
 *  - `assistant_text` events are CHUNKS — coalesced into the active text
 *    block by APPENDING to a single `text: string`. NEVER store as
 *    `chunks: string[]`: joining N chunks across N renders is O(N²).
 *  - `assistant_text` after a `tool_use` / `assistant_thinking` opens a
 *    NEW text block in the same turn — break only on `turn_completed`
 *    and you'll merge bubbles incorrectly.
 *  - Prior turns keep their object refs across updates so
 *    `React.memo(Bubble)` with an identity comparator skips unchanged
 *    bubbles. Use `[...turns.slice(0, -1), newLast]`, not `.map(...)`.
 *  - Pure reducer: ids derive from `state.nextTurnId`, ts from the
 *    action. No `Date.now()` inside.
 *  - Each block carries a stable id: tool blocks reuse `callId`; text /
 *    thinking / error blocks get a synthetic `blockId` of the form
 *    `<turnId>::b<seq>` assigned at create time. 3B.2 audit M6: index
 *    keys are brittle once block components hold local state, so
 *    callers MUST `key` by id, never by index.
 *
 * Suppressed events (no render value): `system_init`, `idle`.
 */

export interface ToolResult {
  readonly content: string;
  readonly isError: boolean;
}

export type Block =
  | { readonly kind: 'text'; readonly blockId: string; readonly text: string }
  | {
      readonly kind: 'tool';
      readonly callId: string;
      readonly name: string;
      readonly input: Record<string, unknown>;
      readonly result: ToolResult | null;
    }
  | { readonly kind: 'thinking'; readonly blockId: string; readonly text: string }
  // Visual review: distinct block kind so the error message renders in
  // red WITHOUT the prior streamed text in the same bubble inheriting
  // the error color (turn-level `isError` is kept for hierarchy /
  // future iconography but no longer drives text coloring).
  | { readonly kind: 'error'; readonly blockId: string; readonly text: string };

/**
 * Phase 3K — payload shape for the `pushSystem` action.
 *
 * Mirrors `CompletionSummary` plus a stable `workerId` so the Bubble
 * can re-resolve the instrument name at render time. Resolution races
 * exist when a worker spawns + completes faster than the TUI's 1 s
 * worker-list poll cycle: at receipt time the allocator hasn't seen
 * the worker yet, so we can't resolve it. Storing the workerId lets a
 * later render — once the worker shows up in the list — pull the
 * allocated name (Violin / Cello / ...) instead of being frozen on
 * the server's slug fallback (`worker-abc123`).
 *
 * `workerName` remains the fallback the Bubble uses when no resolver
 * is in scope or returns `undefined`.
 */
export interface SystemSummary {
  readonly workerId: string;
  readonly workerName: string;
  readonly projectName: string;
  readonly statusKind: CompletionStatusKind;
  readonly durationMs: number | null;
  readonly headline: string;
  readonly metrics?: string;
  readonly details?: string;
  readonly fallback: boolean;
}

export type Turn =
  | { readonly kind: 'user'; readonly id: string; readonly text: string; readonly ts: number }
  | {
      readonly kind: 'assistant';
      readonly id: string;
      readonly blocks: readonly Block[];
      /** Monotonic counter for synthetic blockIds within this turn. */
      readonly nextBlockSeq: number;
      readonly complete: boolean;
      readonly isError: boolean;
      readonly ts: number;
    }
  /**
   * Phase 3K — system row for completion summaries. Distinct kind so
   * the renderer (Bubble) discriminates without overloading assistant
   * blocks. No bordered bubble — flat row with status icon, header
   * line (worker · project · duration) and 1-3 indented body lines.
   */
  | {
      readonly kind: 'system';
      readonly id: string;
      readonly summary: SystemSummary;
      readonly ts: number;
    };

export type AssistantTurn = Extract<Turn, { kind: 'assistant' }>;
export type SystemTurn = Extract<Turn, { kind: 'system' }>;

export interface ChatHistoryState {
  readonly turns: readonly Turn[];
  readonly nextTurnId: number;
  /**
   * Phase 3K — system turns waiting to flush AFTER the in-flight
   * assistant turn completes. The chat reducer's "active assistant
   * turn" detection (lines below) finds the last unclosed assistant
   * turn and merges new events into it; appending a `system` turn at
   * the end while Maestro is mid-stream would split the assistant
   * bubble (next `assistant_text` would open a fresh turn). Buffer
   * here, drain on `turn_completed` / `error` / `pushUser` / when the
   * tail isn't an in-flight assistant.
   */
  readonly pendingSystems: readonly SystemTurn[];
}

export const INITIAL_CHAT_HISTORY: ChatHistoryState = {
  turns: [],
  nextTurnId: 0,
  pendingSystems: [],
};

export type ChatHistoryAction =
  | { readonly kind: 'event'; readonly event: MaestroEvent; readonly ts: number }
  | { readonly kind: 'pushUser'; readonly text: string; readonly ts: number }
  | { readonly kind: 'pushSystem'; readonly summary: SystemSummary; readonly ts: number };

/** Drain pending system turns into the visible turn list. */
function drainPendingSystems(state: ChatHistoryState): ChatHistoryState {
  if (state.pendingSystems.length === 0) return state;
  return {
    turns: [...state.turns, ...state.pendingSystems],
    nextTurnId: state.nextTurnId,
    pendingSystems: [],
  };
}

export function chatHistoryReducer(
  state: ChatHistoryState,
  action: ChatHistoryAction,
): ChatHistoryState {
  if (action.kind === 'pushUser') {
    const id = `user-${state.nextTurnId}`;
    const userTurn: Turn = { kind: 'user', id, text: action.text, ts: action.ts };
    // Drain any deferred system turns BEFORE the user's new message —
    // user input is also a turn boundary; the rare race where a
    // summary lands while Maestro is streaming and the user types
    // before turn_completed fires would otherwise stash forever.
    const drained = drainPendingSystems(state);
    return {
      turns: [...drained.turns, userTurn],
      nextTurnId: drained.nextTurnId + 1,
      pendingSystems: [],
    };
  }

  if (action.kind === 'pushSystem') {
    const id = `system-${state.nextTurnId}`;
    const systemTurn: SystemTurn = {
      kind: 'system',
      id,
      summary: action.summary,
      ts: action.ts,
    };
    const last = state.turns[state.turns.length - 1];
    if (last !== undefined && last.kind === 'assistant' && !last.complete) {
      // Maestro is mid-stream — defer until turn_completed fires so
      // appending the system row doesn't split the assistant bubble.
      return {
        turns: state.turns,
        nextTurnId: state.nextTurnId + 1,
        pendingSystems: [...state.pendingSystems, systemTurn],
      };
    }
    return {
      turns: [...state.turns, systemTurn],
      nextTurnId: state.nextTurnId + 1,
      pendingSystems: state.pendingSystems,
    };
  }

  const { event, ts } = action;
  switch (event.type) {
    case 'system_init':
    case 'idle':
      return state;

    case 'turn_started': {
      const id = `assistant-${state.nextTurnId}`;
      const turn: Turn = {
        kind: 'assistant',
        id,
        blocks: [],
        nextBlockSeq: 0,
        complete: false,
        isError: false,
        ts,
      };
      return {
        turns: [...state.turns, turn],
        nextTurnId: state.nextTurnId + 1,
        pendingSystems: state.pendingSystems,
      };
    }

    case 'assistant_text':
    case 'assistant_thinking':
    case 'tool_use':
    case 'tool_result':
    case 'turn_completed':
    case 'error': {
      const last = state.turns[state.turns.length - 1];
      let base: ChatHistoryState;
      let workingTurn: AssistantTurn;

      if (last !== undefined && last.kind === 'assistant' && !last.complete) {
        // Continue the in-flight assistant turn.
        base = state;
        workingTurn = last;
      } else {
        // Defensive: event arrived without a preceding `turn_started`,
        // OR after the previous turn was closed. Open a fresh assistant
        // turn so the data isn't dropped.
        const id = `assistant-${state.nextTurnId}`;
        workingTurn = {
          kind: 'assistant',
          id,
          blocks: [],
          nextBlockSeq: 0,
          complete: false,
          isError: false,
          ts,
        };
        base = {
          turns: [...state.turns, workingTurn],
          nextTurnId: state.nextTurnId + 1,
          pendingSystems: state.pendingSystems,
        };
      }

      const updated = applyToAssistantTurn(workingTurn, event);
      const next: ChatHistoryState = (updated === workingTurn)
        ? base
        : { ...base, turns: [...base.turns.slice(0, -1), updated] };
      // turn_completed / error close the assistant turn — drain any
      // system turns that arrived during the stream so they render
      // immediately after the bubble.
      if (event.type === 'turn_completed' || event.type === 'error') {
        return drainPendingSystems(next);
      }
      return next;
    }

    default: {
      const _exhaustive: never = event;
      return state;
    }
  }
}

function nextBlockId(turn: AssistantTurn): string {
  return `${turn.id}::b${turn.nextBlockSeq}`;
}

function applyToAssistantTurn(
  turn: AssistantTurn,
  event: MaestroEvent,
): AssistantTurn {
  switch (event.type) {
    case 'assistant_text': {
      if (event.text.length === 0) return turn;
      const lastBlock = turn.blocks[turn.blocks.length - 1];
      if (lastBlock !== undefined && lastBlock.kind === 'text') {
        // Coalesce — preserve the existing blockId so React.memo on
        // ToolCallSummary / TextBlock can skip identity-equal re-renders
        // on every chunk after the first.
        const merged: Block = {
          kind: 'text',
          blockId: lastBlock.blockId,
          text: lastBlock.text + event.text,
        };
        return { ...turn, blocks: [...turn.blocks.slice(0, -1), merged] };
      }
      const block: Block = {
        kind: 'text',
        blockId: nextBlockId(turn),
        text: event.text,
      };
      return {
        ...turn,
        blocks: [...turn.blocks, block],
        nextBlockSeq: turn.nextBlockSeq + 1,
      };
    }

    case 'assistant_thinking': {
      if (event.text.length === 0) return turn;
      const block: Block = {
        kind: 'thinking',
        blockId: nextBlockId(turn),
        text: event.text,
      };
      return {
        ...turn,
        blocks: [...turn.blocks, block],
        nextBlockSeq: turn.nextBlockSeq + 1,
      };
    }

    case 'tool_use': {
      const block: Block = {
        kind: 'tool',
        callId: event.callId,
        name: event.name,
        input: event.input,
        result: null,
      };
      return { ...turn, blocks: [...turn.blocks, block] };
    }

    case 'tool_result': {
      const idx = turn.blocks.findIndex(
        (b) => b.kind === 'tool' && b.callId === event.callId,
      );
      if (idx === -1) return turn;
      const target = turn.blocks[idx];
      if (target === undefined || target.kind !== 'tool') return turn;
      const updated: Block = {
        ...target,
        result: { content: event.content, isError: event.isError },
      };
      return {
        ...turn,
        blocks: [...turn.blocks.slice(0, idx), updated, ...turn.blocks.slice(idx + 1)],
      };
    }

    case 'turn_completed':
      return { ...turn, complete: true, isError: event.isError };

    case 'error': {
      const block: Block = {
        kind: 'error',
        blockId: nextBlockId(turn),
        text: `Error: ${event.reason}`,
      };
      return {
        ...turn,
        blocks: [...turn.blocks, block],
        nextBlockSeq: turn.nextBlockSeq + 1,
        complete: true,
        isError: true,
      };
    }

    default:
      return turn;
  }
}
