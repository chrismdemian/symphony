import { useEffect, useReducer } from 'react';
import type { TuiRpc } from '../runtime/rpc.js';
import type { StreamEvent } from '../../workers/types.js';
import {
  INITIAL_WORKER_EVENTS_STATE,
  workerEventsReducer,
  type WorkerEventsState,
} from './workerEventsReducer.js';

/**
 * Subscribe to a worker's stream events with backfill (Phase 3D.1).
 *
 * Mirrors `useMaestroEvents`'s iterator-cleanup discipline (Phase 3A C2)
 * but adds backfill merging because the RPC `workers.events` topic is
 * live-tail only — no replay (`src/rpc/event-broker.ts:18-19`).
 *
 * Sequencing (matters):
 *
 *  1. Subscribe FIRST. Live events queue into a local `pending` array
 *     while `backfillDone` is false.
 *  2. THEN call `rpc.call.workers.tail({workerId, n: BACKFILL_N})`.
 *  3. On tail resolve: dispatch `backfillMerge` which dedupes pending
 *     against backfill tail and produces the ordered visible log.
 *  4. From here on, live events go straight to the reducer.
 *
 * Subscribing before requesting tail is the only race-safe order. If we
 * tail-then-subscribe, events emitted during the gap are dropped: the
 * tail snapshot doesn't include them and they fired before our listener
 * attached. Subscribe-first guarantees we capture every event from at
 * latest the subscribe-attach moment forward; the dedup filter handles
 * any overlap with the tail.
 *
 * Cleanup invariants:
 *
 *  - `cancelled` flag short-circuits both the live event handler and the
 *    backfill `.then` so a fast unmount or workerId change can't race
 *    state into a torn-down hook.
 *  - `subscription.unsubscribe()` is fire-and-forget on cleanup. Awaiting
 *    it would block React's commit cleanup; the WS layer cleans up the
 *    server-side listener regardless of when our promise resolves.
 *
 * Selection-change behavior: callers should mount this hook inside a
 * subtree keyed by `workerId` (e.g. `<WorkerOutputView key={workerId}/>`)
 * so React unmounts and remounts cleanly per worker. The `[rpc, workerId]`
 * dep on the effect handles the data-side reset; the `key` handles the
 * reducer-state reset. Both together = no cross-worker bleed.
 */

/** Default tail backfill — bounded; matches PLAN.md decision. */
export const BACKFILL_N = 200;

export function useWorkerEvents(
  rpc: TuiRpc,
  workerId: string,
): WorkerEventsState {
  const [state, dispatch] = useReducer(
    workerEventsReducer,
    INITIAL_WORKER_EVENTS_STATE,
  );

  useEffect(() => {
    let cancelled = false;
    let backfillDone = false;
    const pending: StreamEvent[] = [];
    let subscriptionCleanup: (() => void) | null = null;

    void (async () => {
      try {
        const subscription = await rpc.subscribe(
          'workers.events',
          { workerId },
          (payload) => {
            if (cancelled) return;
            const event = payload as StreamEvent;
            if (!backfillDone) {
              pending.push(event);
              return;
            }
            dispatch({ kind: 'live', event });
          },
        );
        if (cancelled) {
          // We won the unsubscribe race — clean up immediately.
          void subscription.unsubscribe().catch(() => undefined);
          return;
        }
        subscriptionCleanup = (): void => {
          void subscription.unsubscribe().catch(() => undefined);
        };

        const tail = (await rpc.call.workers.tail({
          workerId,
          n: BACKFILL_N,
        })) as { events: StreamEvent[]; total: number };

        if (cancelled) return;
        dispatch({
          kind: 'backfillMerge',
          backfill: tail.events,
          pending: pending.slice(),
        });
        backfillDone = true;
        pending.length = 0;
      } catch (cause) {
        if (cancelled) return;
        const error = cause instanceof Error ? cause : new Error(String(cause));
        // Audit M1: don't lose events on tail failure. If subscribe
        // succeeded but tail rejected, the listener has been queueing
        // live events into `pending` — flush them via an empty-backfill
        // merge and flip `backfillDone` so subsequent live events flow
        // straight through. Without this, every event that arrives
        // after the rejection is silently dropped into a `pending`
        // array that nothing reads.
        if (subscriptionCleanup !== null) {
          dispatch({ kind: 'backfillMerge', backfill: [], pending: pending.slice() });
          backfillDone = true;
          pending.length = 0;
        }
        dispatch({ kind: 'subscribeError', error });
      }
    })();

    return () => {
      cancelled = true;
      if (subscriptionCleanup !== null) subscriptionCleanup();
    };
  }, [rpc, workerId]);

  return state;
}
