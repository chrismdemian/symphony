import { useCallback, useEffect, useRef, useState } from 'react';
import type { PendingSpawnSnapshot } from '../../rpc/router-impl.js';
import type { TuiRpc } from '../runtime/rpc.js';

/**
 * Phase 3L — poll the cross-project task queue.
 *
 * Mirrors `useWorkers`: 1s background poll, `inFlightRef` skip-tick
 * guard (audit M2 from 3C: a slow RPC could otherwise stack unbounded
 * in-flight requests under sustained polling), `cancelled` flag for
 * mid-flight unmount, `pollIntervalMs <= 0` disables.
 *
 * Returns the flat global queue already sorted ascending by
 * `enqueuedAt` (server-side guarantee). The TUI panel renders this
 * directly; the "Next →" marker is index 0.
 */
export interface UseQueueResult {
  readonly pending: readonly PendingSpawnSnapshot[];
  readonly loading: boolean;
  readonly error: Error | null;
  refresh(): void;
}

export interface UseQueueOptions {
  /** Background poll cadence in ms; <=0 disables. Default 1000. */
  readonly pollIntervalMs?: number;
}

export function useQueue(rpc: TuiRpc, options?: UseQueueOptions): UseQueueResult {
  const [pending, setPending] = useState<readonly PendingSpawnSnapshot[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<Error | null>(null);
  const [tick, setTick] = useState<number>(0);
  const pollIntervalMs = options?.pollIntervalMs ?? 1000;
  const inFlightRef = useRef(false);
  // 3L diff audit M1: when `refresh()` fires while an earlier poll is
  // still in flight, the new `tick` value is observed by the effect
  // but the early-return on inFlightRef drops it. The user sees stale
  // queue state for up to 1 poll interval after every cancel/reorder.
  // Track the pending refresh in a ref, and when the in-flight poll
  // resolves, re-arm one more tick.
  const pendingRefreshRef = useRef(false);

  const refresh = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    if (inFlightRef.current) {
      pendingRefreshRef.current = true;
      return;
    }
    let cancelled = false;
    inFlightRef.current = true;
    setLoading(true);
    rpc.call.queue
      .list()
      .then((list) => {
        if (cancelled) return;
        setPending(list);
        setError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err : new Error(String(err)));
      })
      .finally(() => {
        inFlightRef.current = false;
        if (cancelled) return;
        setLoading(false);
        // Drain any refresh request that arrived while the previous
        // poll was in flight. Bumping `tick` re-runs this effect, which
        // dispatches the fresh `queue.list()`.
        if (pendingRefreshRef.current) {
          pendingRefreshRef.current = false;
          setTick((n) => n + 1);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [rpc, tick]);

  useEffect(() => {
    if (pollIntervalMs <= 0) return;
    const handle = setInterval(() => setTick((n) => n + 1), pollIntervalMs);
    return () => {
      clearInterval(handle);
    };
  }, [pollIntervalMs]);

  return { pending, loading, error, refresh };
}
