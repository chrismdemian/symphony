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

  const refresh = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    if (inFlightRef.current) return;
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
