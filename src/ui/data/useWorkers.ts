import { useCallback, useEffect, useState } from 'react';
import type { WorkerRecordSnapshot } from '../../orchestrator/worker-registry.js';
import type { TuiRpc } from '../runtime/rpc.js';

/**
 * Fetch the live + persisted worker list via RPC.
 *
 * Phase 3A shipped poll-once. Phase 3C upgrades to a 1-second polling
 * tick so the workers panel reflects status flips without needing
 * per-worker subscriptions for the LIST view (subscriptions are
 * per-worker via `workers.events`; a list-changed broadcast topic is
 * a possible follow-up if 1 s feels sluggish).
 *
 * The interval is `pollIntervalMs` so tests can pass `0` to disable
 * background polling and drive `refresh()` manually. Set to <=0 to
 * disable the interval entirely.
 */
export interface UseWorkersResult {
  readonly workers: readonly WorkerRecordSnapshot[];
  readonly loading: boolean;
  readonly error: Error | null;
  refresh(): void;
}

export interface UseWorkersOptions {
  /** Background poll cadence in ms; <=0 disables. Default 1000. */
  readonly pollIntervalMs?: number;
}

export function useWorkers(rpc: TuiRpc, options?: UseWorkersOptions): UseWorkersResult {
  const [workers, setWorkers] = useState<readonly WorkerRecordSnapshot[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<Error | null>(null);
  const [tick, setTick] = useState<number>(0);
  const pollIntervalMs = options?.pollIntervalMs ?? 1000;

  const refresh = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    rpc.call.workers
      .list({})
      .then((list) => {
        if (cancelled) return;
        setWorkers(list);
        setError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err : new Error(String(err)));
      })
      .finally(() => {
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

  return { workers, loading, error, refresh };
}
