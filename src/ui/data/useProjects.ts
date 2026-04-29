import { useCallback, useEffect, useState } from 'react';
import type { ProjectSnapshot } from '../../projects/types.js';
import type { TuiRpc } from '../runtime/rpc.js';

/**
 * Fetch the registered project list via RPC. Phase 3A: poll-once on mount,
 * expose `refresh()` for manual reload. Phase 3B+ may add subscription
 * topic (`projects.events` doesn't exist yet — Phase 2B.2 only ships
 * `workers.events`).
 */
export interface UseProjectsResult {
  readonly projects: readonly ProjectSnapshot[];
  readonly loading: boolean;
  readonly error: Error | null;
  refresh(): void;
}

export function useProjects(rpc: TuiRpc): UseProjectsResult {
  const [projects, setProjects] = useState<readonly ProjectSnapshot[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<Error | null>(null);
  const [tick, setTick] = useState<number>(0);

  const refresh = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    rpc.call.projects
      .list({})
      .then((list) => {
        if (cancelled) return;
        setProjects(list);
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

  return { projects, loading, error, refresh };
}
