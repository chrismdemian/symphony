import { useEffect, useReducer, useRef } from 'react';
import type { MaestroEvent } from '../../orchestrator/maestro/process.js';

/**
 * Subscribe to a `MaestroProcess.events()` async iterator from inside React.
 *
 * Concurrent iterators ARE supported by `MaestroProcess` (audit 2C.1 m3),
 * so this hook is safe to use multiple times.
 *
 * Audit C2 / 3A: cleanup MUST call `iter.return()` to deterministically
 * abort the in-flight `next()` AND run MaestroProcess's `events()`
 * `finally` block (which removes the emitter listener). The previous
 * `done.value = true` flag was insufficient — the loop sat parked in
 * `await new Promise(... waiters.push)` and the guard never re-checked
 * until another event arrived, leaving the listener attached forever.
 *
 * Audit m1/m2/m3: a single `useReducer` collapses the prior
 * `setLatest` + `setCount` double-render and gives consumers atomic
 * state updates (essential for Phase 3D's streaming).
 */

export interface MaestroSource {
  /** Returns an async iterable that yields events as they're emitted. */
  events(): AsyncIterable<MaestroEvent>;
}

interface State {
  readonly sessionId: string | null;
  readonly latest: Partial<Record<MaestroEvent['type'], MaestroEvent>>;
  readonly count: number;
}

export type UseMaestroEventsResult = State;

const INITIAL: State = { sessionId: null, latest: {}, count: 0 };

function reducer(prev: State, event: MaestroEvent): State {
  return {
    sessionId: event.type === 'system_init' ? event.sessionId : prev.sessionId,
    latest: { ...prev.latest, [event.type]: event },
    count: prev.count + 1,
  };
}

export interface UseMaestroEventsOptions {
  /** Optional sink — called for every event AFTER state update. */
  readonly onEvent?: (event: MaestroEvent) => void;
}

export function useMaestroEvents(
  source: MaestroSource,
  options: UseMaestroEventsOptions = {},
): UseMaestroEventsResult {
  const [state, dispatch] = useReducer(reducer, INITIAL);
  const onEventRef = useRef(options.onEvent);
  onEventRef.current = options.onEvent;

  useEffect(() => {
    const iterable = source.events();
    const iter = iterable[Symbol.asyncIterator]();
    let cancelled = false;

    void (async () => {
      try {
        while (true) {
          const result = await iter.next();
          if (cancelled || result.done === true) return;
          dispatch(result.value);
          onEventRef.current?.(result.value);
        }
      } catch {
        // Iterator errors land on Maestro's `error` event channel via
        // `MaestroProcess.on('error', ...)`. The loop simply terminates.
      }
    })();

    return () => {
      cancelled = true;
      // Audit C2: `iter.return()` deterministically aborts the in-flight
      // `next()` AND runs the iterator's `finally` block, removing the
      // emitter listener. Without this, the listener leaks until the
      // launcher exits.
      void iter.return?.();
    };
  }, [source]);

  return state;
}
