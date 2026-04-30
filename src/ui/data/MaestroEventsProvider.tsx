import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type ReactNode,
} from 'react';
import {
  MaestroTurnInFlightError,
  type MaestroEvent,
} from '../../orchestrator/maestro/process.js';
import type { MaestroSource } from './useMaestroEvents.js';
import {
  chatHistoryReducer,
  INITIAL_CHAT_HISTORY,
  type ChatHistoryState,
  type Turn,
} from './chatHistoryReducer.js';
import {
  INITIAL_TURN_STATE,
  turnStateReducer,
  type TurnState,
} from './turnStateReducer.js';

/**
 * Single-iterator MaestroEvent provider.
 *
 * Plan-agent S3: two iterators (sessionId hook + chat-history hook)
 * over the same `MaestroProcess.events()` source race each other and
 * blow the 256-event backlog cap during heavy `assistant_text`
 * streaming. One iterator, fanned out via context, eliminates both.
 *
 * Reduces in lock-step:
 *  - sessionId: lifted out of `system_init`
 *  - chat history (turn list with content blocks)
 *  - turn state (`{inFlight, currentTool, ...}`)
 *
 * Selectors (`useMaestroData`) read the combined controller. Components
 * memo their leaves so per-event reconciliation stays bounded — see
 * the Phase 3B Known Gotcha additions in CLAUDE.md once 3B.1 lands.
 *
 * Cleanup mirrors `useMaestroEvents` audit C2: `iter.return()` runs
 * synchronously on unmount to abort the parked `next()` and trigger
 * the iterator's `finally` block.
 */

interface CombinedState {
  readonly sessionId: string | null;
  readonly chat: ChatHistoryState;
  readonly turn: TurnState;
}

const INITIAL_COMBINED: CombinedState = {
  sessionId: null,
  chat: INITIAL_CHAT_HISTORY,
  turn: INITIAL_TURN_STATE,
};

type CombinedAction =
  | { readonly kind: 'event'; readonly event: MaestroEvent; readonly ts: number }
  | { readonly kind: 'pushUser'; readonly text: string; readonly ts: number };

function combinedReducer(state: CombinedState, action: CombinedAction): CombinedState {
  // Audit M2: the combined reducer must short-circuit when ALL three
  // child reducers report no change — otherwise every event allocates
  // a fresh state object and re-renders the provider, even no-op
  // events like empty `assistant_text` chunks. Children already enforce
  // referential stability; we propagate it.
  if (action.kind === 'pushUser') {
    const nextChat = chatHistoryReducer(state.chat, action);
    if (nextChat === state.chat) return state;
    return { sessionId: state.sessionId, chat: nextChat, turn: state.turn };
  }
  const { event, ts } = action;
  const nextSessionId = event.type === 'system_init' ? event.sessionId : state.sessionId;
  const nextChat = chatHistoryReducer(state.chat, action);
  const nextTurn = turnStateReducer(state.turn, { event, ts });
  if (
    nextSessionId === state.sessionId &&
    nextChat === state.chat &&
    nextTurn === state.turn
  ) {
    return state;
  }
  return { sessionId: nextSessionId, chat: nextChat, turn: nextTurn };
}

/**
 * Controller flavor of `MaestroSource` — the chat panel needs to send
 * user messages back to the orchestrator, not just consume events.
 * `MaestroProcess` structurally satisfies this shape; tests that
 * exercise the chat path provide a fake with both methods.
 */
export interface MaestroController extends MaestroSource {
  readonly sendUserMessage: (text: string) => void;
}

export type SendUserMessageResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'turn_in_flight' }
  | { readonly ok: false; readonly reason: 'send_failed'; readonly message: string };

export interface MaestroDataController {
  readonly sessionId: string | null;
  readonly turns: readonly Turn[];
  readonly turn: TurnState;
  /**
   * Append a user turn to history WITHOUT sending to Maestro. Use when
   * the chat panel locally renders a message (e.g., simulated history,
   * tests). Production submit goes through `sendUserMessage` below.
   */
  readonly pushUserMessage: (text: string) => void;
  /**
   * Atomic send + push: forwards `text` to the orchestrator, then
   * appends the user turn to history. If Maestro rejects (turn already
   * in flight), nothing is pushed and the error is surfaced via the
   * result. Phase 2C.1 audit M3 makes the synchronous throw on re-entry
   * the load-bearing signal.
   */
  readonly sendUserMessage: (text: string) => SendUserMessageResult;
}

const MaestroDataContext = createContext<MaestroDataController | null>(null);

export interface MaestroEventsProviderProps {
  readonly source: MaestroController;
  readonly children: ReactNode;
  /**
   * Override the timestamp source. Tests inject a deterministic clock;
   * production defaults to `Date.now`.
   */
  readonly now?: () => number;
}

export function MaestroEventsProvider({
  source,
  children,
  now,
}: MaestroEventsProviderProps): React.JSX.Element {
  const [state, dispatch] = useReducer(combinedReducer, INITIAL_COMBINED);
  // Audit M3: pin `now` behind a ref so inline `now={() => 0}` (the
  // canonical test pattern) doesn't change identity across renders and
  // tear down the iterator pump. The ref read happens at the dispatch
  // site — production never overrides `now`, so this stays a single
  // global `Date.now` reference at runtime.
  const nowRef = useRef<() => number>(now ?? Date.now);
  nowRef.current = now ?? Date.now;

  useEffect(() => {
    const iterable = source.events();
    const iter = iterable[Symbol.asyncIterator]();
    let cancelled = false;

    void (async () => {
      try {
        while (true) {
          const result = await iter.next();
          if (cancelled || result.done === true) return;
          dispatch({ kind: 'event', event: result.value, ts: nowRef.current() });
        }
      } catch {
        // Iterator errors land on Maestro's `error` event channel via
        // `MaestroProcess.on('error', ...)`. The pump simply terminates.
      }
    })();

    return () => {
      cancelled = true;
      // Audit C2 (Phase 3A) parity — `iter.return()` aborts the parked
      // `next()` AND runs the iterator's `finally` block. Without it
      // the listener leaks until the launcher exits.
      void iter.return?.();
    };
  }, [source]);

  const pushUserMessage = useCallback((text: string) => {
    // Audit M4: guard at the dispatch boundary against empty /
    // whitespace-only input. The reducer stays pure; the policy lives
    // here so future callers (3B.2 paste / slash-preview) inherit it.
    if (text.trim().length === 0) return;
    dispatch({ kind: 'pushUser', text, ts: nowRef.current() });
  }, []);

  const sendUserMessage = useCallback(
    (text: string): SendUserMessageResult => {
      try {
        source.sendUserMessage(text);
      } catch (err) {
        if (err instanceof MaestroTurnInFlightError) {
          // Maestro rejected synchronously — no bytes on the wire,
          // suppress the user push.
          return { ok: false, reason: 'turn_in_flight' };
        }
        // Audit C1: any OTHER throw may fire AFTER stdin write
        // succeeded. Pushing the user turn anyway keeps history
        // honest — the user sees their message, then sees the
        // `send_failed` error inline.
        if (text.trim().length > 0) {
          dispatch({ kind: 'pushUser', text, ts: nowRef.current() });
        }
        return {
          ok: false,
          reason: 'send_failed',
          message: err instanceof Error ? err.message : String(err),
        };
      }
      if (text.trim().length > 0) {
        dispatch({ kind: 'pushUser', text, ts: nowRef.current() });
      }
      return { ok: true };
    },
    [source],
  );

  const controller = useMemo<MaestroDataController>(
    () => ({
      sessionId: state.sessionId,
      turns: state.chat.turns,
      turn: state.turn,
      pushUserMessage,
      sendUserMessage,
    }),
    [state.sessionId, state.chat.turns, state.turn, pushUserMessage, sendUserMessage],
  );

  return (
    <MaestroDataContext.Provider value={controller}>{children}</MaestroDataContext.Provider>
  );
}

export function useMaestroData(): MaestroDataController {
  const ctx = useContext(MaestroDataContext);
  if (ctx === null) {
    throw new Error('useMaestroData() called outside <MaestroEventsProvider>');
  }
  return ctx;
}
