import { useCallback, useEffect, useState } from 'react';
import type { WorkerRecordSnapshot } from '../../orchestrator/worker-registry.js';
import type { TuiRpc } from '../runtime/rpc.js';

/**
 * Fetch the live + persisted worker list via RPC. Phase 3A: poll-once.
 * Phase 3C will refresh on `workers.events` for real-time status flips.
 */
export interface UseWorkersResult {
  readonly workers: readonly WorkerRecordSnapshot[];
  readonly loading: boolean;
  readonly error: Error | null;
  refresh(): void;
}

export function useWorkers(rpc: TuiRpc): UseWorkersResult {
  const [workers, setWorkers] = useState<readonly WorkerRecordSnapshot[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<Error | null>(null);
  const [tick, setTick] = useState<number>(0);

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

  return { workers, loading, error, refresh };
}
