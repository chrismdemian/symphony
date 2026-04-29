import { useCallback, useEffect, useState } from 'react';
import type { ToolMode } from '../../orchestrator/types.js';
import type { TuiRpc } from '../runtime/rpc.js';

/** Maestro's current PLAN / ACT mode, surfaced via RPC `mode.get`. */
export interface UseModeResult {
  readonly mode: ToolMode | null;
  readonly loading: boolean;
  readonly error: Error | null;
  refresh(): void;
}

export function useMode(rpc: TuiRpc): UseModeResult {
  const [mode, setMode] = useState<ToolMode | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<Error | null>(null);
  const [tick, setTick] = useState<number>(0);

  const refresh = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    rpc.call.mode
      .get()
      .then((snap) => {
        if (cancelled) return;
        setMode(snap.mode);
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

  return { mode, loading, error, refresh };
}
