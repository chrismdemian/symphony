import type {
  StreamEvent,
  SystemApiRetryEvent,
} from '../../workers/types.js';

/**
 * Worker output stream reducer (Phase 3D.1).
 *
 * Coalesces a stream of `StreamEvent`s — backfilled from
 * `rpc.workers.tail` plus live from `rpc.subscribe('workers.events',
 * {workerId})` — into an ordered, deduped event log for the output
 * panel.
 *
 * Critical invariants:
 *
 *  - Append-only `events` array. Live events that arrive BEFORE the
 *    backfill resolves are queued by the hook into a `pending` list and
 *    folded in by `backfillMerge`. Subsequent live events go straight to
 *    `live`.
 *  - Silent event-type filter: `system_init`, `log`, `control_request`,
 *    `system` are dropped at the reducer entry. The output panel is for
 *    human-visible content, not protocol noise. Mirrors the dispatcher's
 *    silent set from Phase 1A m3.
 *  - `lastRetryEvent` is the rate-limit banner state. Set on every
 *    `system_api_retry` arrival; cleared on the FIRST non-retry,
 *    non-silent event that follows. The body keeps the audit trail; the
 *    header banner is the glanceable "we're stuck" signal.
 *  - `backfillMerge` re-derives `lastRetryEvent` via a backwards walk of
 *    the merged event log so it matches the visible-state-after-backfill
 *    view, not the pre-backfill snapshot.
 *  - Dedup of pending vs backfill is by `JSON.stringify` deep-equality
 *    against the LAST few backfill events. Cheap (≤200 events × ≤a few
 *    pending), and StreamEvents are plain objects with stable
 *    serialization. We don't need hash-keyed event ids because the
 *    server-side broker order is monotonic per worker.
 */

export type DisplayedStreamEvent = Exclude<
  StreamEvent,
  { type: 'system_init' | 'log' | 'control_request' | 'system' }
>;

const SILENT_EVENT_TYPES: ReadonlySet<StreamEvent['type']> = new Set([
  'system_init',
  'log',
  'control_request',
  'system',
]);

export interface WorkerEventsState {
  readonly events: readonly DisplayedStreamEvent[];
  readonly lastRetryEvent: SystemApiRetryEvent | null;
  readonly subscribeError: Error | null;
  readonly backfillReady: boolean;
}

export type WorkerEventsAction =
  | { readonly kind: 'live'; readonly event: StreamEvent }
  | {
      readonly kind: 'backfillMerge';
      readonly backfill: readonly StreamEvent[];
      readonly pending: readonly StreamEvent[];
    }
  | { readonly kind: 'subscribeError'; readonly error: Error };

export const INITIAL_WORKER_EVENTS_STATE: WorkerEventsState = {
  events: [],
  lastRetryEvent: null,
  subscribeError: null,
  backfillReady: false,
};

export function workerEventsReducer(
  state: WorkerEventsState,
  action: WorkerEventsAction,
): WorkerEventsState {
  switch (action.kind) {
    case 'live': {
      if (SILENT_EVENT_TYPES.has(action.event.type)) return state;
      const event = action.event as DisplayedStreamEvent;
      const lastRetryEvent =
        event.type === 'system_api_retry'
          ? event
          : null;
      return {
        ...state,
        events: [...state.events, event],
        lastRetryEvent,
      };
    }

    case 'backfillMerge': {
      // Filter both sides through the silent set so the dedup below
      // operates on visible events only — cheaper, and pending might
      // contain protocol noise that we never displayed but the hook
      // still queued.
      const backfillVisible = action.backfill.filter(
        (e): e is DisplayedStreamEvent => !SILENT_EVENT_TYPES.has(e.type),
      );
      const pendingVisible = action.pending.filter(
        (e): e is DisplayedStreamEvent => !SILENT_EVENT_TYPES.has(e.type),
      );
      const dedupedPending = dedupePendingAgainstBackfill(
        pendingVisible,
        backfillVisible,
      );
      const merged: DisplayedStreamEvent[] = [
        ...backfillVisible,
        ...dedupedPending,
      ];
      const lastRetryEvent = deriveLastRetryEvent(merged);
      return {
        ...state,
        events: merged,
        lastRetryEvent,
        backfillReady: true,
      };
    }

    case 'subscribeError': {
      return { ...state, subscribeError: action.error };
    }
  }
}

/**
 * Drop events from `pending` whose serialized form matches an event in
 * `backfill`. Order-preserving. Set-based for O(p + b) cost (audit m3:
 * earlier doc claimed bounded-walk semantics that the implementation
 * doesn't actually do — set lookup is the simpler honest description).
 *
 * StreamEvents are plain JSON-serializable objects emitted by Symphony's
 * stream parser; the same logical event has the same serialization on
 * both paths (V8 preserves insertion order across `JSON.stringify`).
 * The comparison set is bounded by `n` (default 200), well within
 * a one-time selection-change cost budget.
 */
function dedupePendingAgainstBackfill(
  pending: readonly DisplayedStreamEvent[],
  backfill: readonly DisplayedStreamEvent[],
): DisplayedStreamEvent[] {
  if (pending.length === 0 || backfill.length === 0) return [...pending];
  const backfillSerialized = new Set(backfill.map((e) => JSON.stringify(e)));
  return pending.filter((e) => !backfillSerialized.has(JSON.stringify(e)));
}

/**
 * Re-derive the rate-limit banner state after a backfill merge. The
 * banner is active iff the LAST visible event is a `system_api_retry`
 * (any non-retry event after it would have cleared the banner under
 * the live-append rule). Mirrors the sequential walk's outcome with a
 * single tail check — audit m1: previous loop body unconditionally
 * returned on iteration 1, hiding the simpler shape.
 */
function deriveLastRetryEvent(
  events: readonly DisplayedStreamEvent[],
): SystemApiRetryEvent | null {
  const last = events[events.length - 1];
  return last !== undefined && last.type === 'system_api_retry' ? last : null;
}
