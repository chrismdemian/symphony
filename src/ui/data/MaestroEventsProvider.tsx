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
import { randomUUID } from 'node:crypto';
import {
  MaestroTurnInFlightError,
  type MaestroEvent,
} from '../../orchestrator/maestro/process.js';
import type { MaestroSource } from './useMaestroEvents.js';
import {
  chatHistoryReducer,
  INITIAL_CHAT_HISTORY,
  type ChatHistoryState,
  type SystemSummary,
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
  | { readonly kind: 'pushUser'; readonly text: string; readonly ts: number }
  | { readonly kind: 'pushSystem'; readonly summary: SystemSummary; readonly ts: number };

function combinedReducer(state: CombinedState, action: CombinedAction): CombinedState {
  // Audit M2: the combined reducer must short-circuit when ALL three
  // child reducers report no change — otherwise every event allocates
  // a fresh state object and re-renders the provider, even no-op
  // events like empty `assistant_text` chunks. Children already enforce
  // referential stability; we propagate it.
  if (action.kind === 'pushUser' || action.kind === 'pushSystem') {
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
   *
   * Phase 3T: when `interruptPending` is true (set via `markInterrupted`),
   * the outgoing `text` is wrapped in an `[INTERRUPT NOTICE]` envelope
   * before being sent to Maestro; the flag is then cleared. Maestro's
   * prompt recognizes the envelope and treats the prior direction as
   * fully discarded.
   */
  readonly sendUserMessage: (text: string) => SendUserMessageResult;
  /**
   * Phase 3K — append a system row (worker completion summary) to
   * chat history. Source-agnostic entry point so `useCompletionEvents`
   * can dispatch without knowing about the combined reducer. The
   * reducer defers insertion until any in-flight assistant turn
   * completes (preserves bubble integrity); see chatHistoryReducer
   * `pendingSystems` queue.
   */
  readonly pushSystem: (summary: SystemSummary) => void;
  /**
   * Phase 3T — after the keybind handler fires `rpc.call.runtime.interrupt()`
   * successfully, it calls this method with the RPC result. The
   * controller pushes a synthetic gray-⏸ system row to chat AND arms
   * the envelope-wrap on the next `sendUserMessage`. Idempotent —
   * calling twice without a sendUserMessage in between is a no-op for
   * the flag (already set), but pushes another row each time so the
   * chat reflects every pivot.
   */
  readonly markInterrupted: (info: {
    readonly workersKilled: readonly string[];
    readonly queuedCancelled: readonly string[];
    readonly tasksCancelled: readonly string[];
  }) => void;
  /** Phase 3T — current interrupt-pending state (envelope is armed). Read-only. */
  readonly interruptPending: boolean;
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

  const pushSystem = useCallback((summary: SystemSummary) => {
    dispatch({ kind: 'pushSystem', summary, ts: nowRef.current() });
  }, []);

  // Phase 3T — envelope arming. Set by markInterrupted; consumed (and
  // cleared) by the next sendUserMessage. Ref-mirrored so the latest
  // value is read synchronously inside the sendUserMessage callback
  // without triggering a re-render before the envelope wraps.
  const interruptPendingRef = useRef(false);
  const [interruptPending, setInterruptPending] = React.useState(false);

  const sendUserMessage = useCallback(
    (text: string): SendUserMessageResult => {
      // Phase 3T — wrap with the [INTERRUPT NOTICE] envelope if armed.
      // The wrap happens BEFORE the synchronous source.sendUserMessage
      // call so a re-entry rejection (MaestroTurnInFlightError) sees
      // the wrapped text and the flag still flips to false on success.
      let outgoing = text;
      if (interruptPendingRef.current) {
        outgoing =
          '[INTERRUPT NOTICE] The user pivoted on the previous turn. ' +
          'Workers were killed, queued tasks cancelled. Treat the prior ' +
          'direction as fully discarded. Respond fresh to the message ' +
          'below.\n\n' +
          text;
      }
      try {
        source.sendUserMessage(outgoing);
      } catch (err) {
        if (err instanceof MaestroTurnInFlightError) {
          // Maestro rejected synchronously — no bytes on the wire,
          // suppress the user push. Leave the envelope flag set so
          // the next attempt still wraps.
          return { ok: false, reason: 'turn_in_flight' };
        }
        // Audit C1: any OTHER throw may fire AFTER stdin write
        // succeeded. Pushing the user turn anyway keeps history
        // honest — the user sees their message, then sees the
        // `send_failed` error inline.
        if (text.trim().length > 0) {
          dispatch({ kind: 'pushUser', text, ts: nowRef.current() });
        }
        // Clear the flag — bytes likely landed on stdin already; we
        // don't want to re-wrap on retry.
        if (interruptPendingRef.current) {
          interruptPendingRef.current = false;
          setInterruptPending(false);
        }
        return {
          ok: false,
          reason: 'send_failed',
          message: err instanceof Error ? err.message : String(err),
        };
      }
      // Successful send — clear the envelope flag (chat history shows
      // the user's ORIGINAL text, not the wrapped envelope; Maestro's
      // stdin got the wrapped form).
      if (interruptPendingRef.current) {
        interruptPendingRef.current = false;
        setInterruptPending(false);
      }
      if (text.trim().length > 0) {
        dispatch({ kind: 'pushUser', text, ts: nowRef.current() });
      }
      return { ok: true };
    },
    [source],
  );

  const markInterrupted = useCallback(
    (info: {
      readonly workersKilled: readonly string[];
      readonly queuedCancelled: readonly string[];
      readonly tasksCancelled: readonly string[];
    }) => {
      // Arm the envelope wrap for the next sendUserMessage.
      interruptPendingRef.current = true;
      setInterruptPending(true);
      // Push a synthetic gray-⏸ system row summarizing the pivot.
      const total =
        info.workersKilled.length + info.queuedCancelled.length + info.tasksCancelled.length;
      const parts: string[] = [];
      if (info.workersKilled.length > 0) {
        parts.push(`${info.workersKilled.length} worker${info.workersKilled.length === 1 ? '' : 's'} killed`);
      }
      if (info.queuedCancelled.length > 0) {
        parts.push(
          `${info.queuedCancelled.length} queued spawn${info.queuedCancelled.length === 1 ? '' : 's'} drained`,
        );
      }
      if (info.tasksCancelled.length > 0) {
        parts.push(
          `${info.tasksCancelled.length} pending task${info.tasksCancelled.length === 1 ? '' : 's'} cancelled`,
        );
      }
      const detail = total === 0 ? 'nothing in flight' : parts.join(' · ');
      // Audit Minor #1: use `crypto.randomUUID()` rather than
      // `interrupt-${nowRef.current()}` so a double-pivot within the
      // same millisecond doesn't collide on synthetic workerId. Inert
      // today (chat reducer keys by `nextTurnId`, not workerId), but
      // cheap insurance — mirrors 3M's away-digest posture.
      const summary: SystemSummary = {
        workerId: `interrupt-${randomUUID()}`,
        workerName: 'Symphony',
        projectName: '',
        statusKind: 'interrupted',
        headline: `Interrupted — ${detail}. Awaiting new direction.`,
        durationMs: null,
        fallback: false,
      };
      dispatch({ kind: 'pushSystem', summary, ts: nowRef.current() });
    },
    [],
  );

  const controller = useMemo<MaestroDataController>(
    () => ({
      sessionId: state.sessionId,
      turns: state.chat.turns,
      turn: state.turn,
      pushUserMessage,
      sendUserMessage,
      pushSystem,
      markInterrupted,
      interruptPending,
    }),
    [
      state.sessionId,
      state.chat.turns,
      state.turn,
      pushUserMessage,
      sendUserMessage,
      pushSystem,
      markInterrupted,
      interruptPending,
    ],
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
