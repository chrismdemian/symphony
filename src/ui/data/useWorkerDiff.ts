import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import type { TuiRpc } from '../runtime/rpc.js';
import type { WorkersDiffResult } from '../../rpc/router-impl.js';

/**
 * Phase 3J — fetch the worker's worktree diff against the project base
 * branch. One-shot per `refresh()` call; not poll-driven (git diff is
 * expensive enough that polling would burn cycles for no UX gain).
 *
 * State machine: `idle → loading → ready | error → loading → …`. The
 * caller drives transitions:
 *   - mount with `enabled: true` triggers an initial fetch (loading)
 *   - `refresh()` re-enters loading (kept in same hook)
 *   - workerId change unmounts the hook entirely (key-based reset in
 *     the consumer); fresh hook starts in idle
 *
 * In-flight dedup: while a fetch is pending, additional `refresh()` calls
 * are recorded as a `queuedRefresh` flag and re-fired after the current
 * fetch settles. This avoids the cancel-and-replace dance — simpler, and
 * the failure mode of a single rapid double-press is "see the second
 * result" not "race".
 *
 * Unmount safety: `unmountedRef` gates all setState calls past the await
 * boundary so consumers can drop the hook mid-fetch without React 19
 * dead-tree warnings.
 */

export type WorkerDiffState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading'; readonly previous?: WorkersDiffResult }
  | {
      readonly kind: 'ready';
      readonly data: WorkersDiffResult;
      readonly fetchedAt: number;
    }
  | {
      readonly kind: 'error';
      readonly error: Error;
      readonly previous?: WorkersDiffResult;
    };

export interface UseWorkerDiffResult {
  readonly state: WorkerDiffState;
  refresh(): void;
}

export interface UseWorkerDiffOptions {
  readonly enabled?: boolean;
  readonly capBytes?: number;
  /** Test seam: clock injected so frame harness can pin `fetchedAt`. */
  readonly now?: () => number;
}

type Action =
  | { readonly type: 'fetch_start' }
  | { readonly type: 'fetch_success'; readonly data: WorkersDiffResult; readonly fetchedAt: number }
  | { readonly type: 'fetch_error'; readonly error: Error };

function reducer(state: WorkerDiffState, action: Action): WorkerDiffState {
  switch (action.type) {
    case 'fetch_start': {
      const previous =
        state.kind === 'ready'
          ? state.data
          : state.kind === 'error' || state.kind === 'loading'
            ? state.previous
            : undefined;
      return previous !== undefined
        ? { kind: 'loading', previous }
        : { kind: 'loading' };
    }
    case 'fetch_success':
      return { kind: 'ready', data: action.data, fetchedAt: action.fetchedAt };
    case 'fetch_error': {
      const previous =
        state.kind === 'loading' || state.kind === 'error' ? state.previous : undefined;
      return previous !== undefined
        ? { kind: 'error', error: action.error, previous }
        : { kind: 'error', error: action.error };
    }
    default:
      return state;
  }
}

export function useWorkerDiff(
  rpc: TuiRpc,
  workerId: string,
  options?: UseWorkerDiffOptions,
): UseWorkerDiffResult {
  const enabled = options?.enabled ?? true;
  const capBytes = options?.capBytes;
  const now = options?.now ?? Date.now;
  const [state, dispatch] = useReducer(reducer, { kind: 'idle' } as WorkerDiffState);

  const unmountedRef = useRef(false);
  const inFlightRef = useRef(false);
  const queuedRefreshRef = useRef(false);
  // Mirror enabled into a ref so a queued refresh can check the latest
  // value when it actually fires, not the value captured at request time.
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  // Track the worker id in a ref so the fetch closure always reads the
  // current id, not the one captured when a queued refresh enqueued.
  const workerIdRef = useRef(workerId);
  workerIdRef.current = workerId;

  const capBytesRef = useRef(capBytes);
  capBytesRef.current = capBytes;

  // `now` is provided as a fresh closure by callers in many cases (the
  // visual harness binds `() => fixedNow`); ref-mirroring it prevents
  // `runFetch`'s `useCallback` identity from churning every render and
  // causing the fetch effect to spuriously refire.
  const nowRef = useRef(now);
  nowRef.current = now;

  useEffect(() => {
    return () => {
      unmountedRef.current = true;
    };
  }, []);

  // Force-refresh tick. Bumping this re-runs the fetch effect.
  const [tick, setTick] = useState(0);

  const runFetch = useCallback(async (): Promise<void> => {
    if (inFlightRef.current) {
      queuedRefreshRef.current = true;
      return;
    }
    inFlightRef.current = true;
    if (unmountedRef.current) {
      inFlightRef.current = false;
      return;
    }
    dispatch({ type: 'fetch_start' });
    try {
      const cap = capBytesRef.current;
      const args =
        cap !== undefined
          ? { workerId: workerIdRef.current, capBytes: cap }
          : { workerId: workerIdRef.current };
      const data = (await rpc.call.workers.diff(args)) as WorkersDiffResult;
      if (unmountedRef.current) return;
      dispatch({ type: 'fetch_success', data, fetchedAt: nowRef.current() });
    } catch (err) {
      if (unmountedRef.current) return;
      dispatch({
        type: 'fetch_error',
        error: err instanceof Error ? err : new Error(String(err)),
      });
    } finally {
      inFlightRef.current = false;
      if (queuedRefreshRef.current && enabledRef.current && !unmountedRef.current) {
        queuedRefreshRef.current = false;
        // Fire-and-forget — recursive call respects the in-flight guard.
        void runFetch();
      }
    }
  }, [rpc]);

  useEffect(() => {
    if (!enabled) return;
    void runFetch();
  }, [enabled, workerId, tick, runFetch]);

  const refresh = useCallback(() => {
    if (!enabledRef.current) return;
    setTick((n) => n + 1);
  }, []);

  return { state, refresh };
}
