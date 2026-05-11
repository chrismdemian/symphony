import { useEffect, useRef, useState } from 'react';
import type { SessionTotals } from '../../orchestrator/session-totals.js';
import { EMPTY_SESSION_TOTALS } from '../../orchestrator/session-totals.js';
import type { TuiRpc } from '../runtime/rpc.js';

/**
 * Phase 3N.2 — poll `stats.session` for the running token + cost totals.
 *
 * Mirrors `useQueue`'s shape: 1s background poll, `inFlightRef` skip-tick
 * guard against stack-up under slow RPC (audit M2 from 3C), `cancelled`
 * flag for mid-flight unmount, `pollIntervalMs <= 0` disables.
 *
 * Returns `EMPTY_SESSION_TOTALS` until the first poll resolves so the
 * status-bar segment can decide visibility from a stable initial shape
 * (its render hides itself when both `totalTokens === 0 && totalCostUsd
 * === 0` — see `StatusBar.tsx`).
 */

export interface UseSessionTotalsResult {
  readonly totals: SessionTotals;
  readonly loading: boolean;
  readonly error: Error | null;
}

export interface UseSessionTotalsOptions {
  readonly pollIntervalMs?: number;
}

export function useSessionTotals(
  rpc: TuiRpc,
  options?: UseSessionTotalsOptions,
): UseSessionTotalsResult {
  const [totals, setTotals] = useState<SessionTotals>(EMPTY_SESSION_TOTALS);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<Error | null>(null);
  const [tick, setTick] = useState<number>(0);
  const pollIntervalMs = options?.pollIntervalMs ?? 1000;
  const inFlightRef = useRef(false);
  // Audit M1 (3N.2): in production, the IpcClient proxy ALWAYS returns
  // a sub-proxy for `rpc.call.stats.session` — even when the server
  // doesn't have the namespace registered. The optional-chain check
  // below is reachable ONLY by plain-object test fakes (scenario rigs
  // predating 3N.2). For real RPC clients connected to a legacy
  // orchestrator, `stats.session()` returns `not_found` per ProtocolError.
  // Cache that result in a ref so we don't poll 1Hz at a wall forever.
  const namespaceMissingRef = useRef(false);

  useEffect(() => {
    if (inFlightRef.current) return;
    if (namespaceMissingRef.current) return;
    // Test-rig short-circuit: scenario fakes that predate 3N.2 omit
    // the `stats` namespace from their `rpc.call` object. Without this
    // guard, `runStart`-driven scenarios would throw
    // `Cannot read 'session' of undefined` on mount.
    const stats = (rpc.call as { stats?: { session?: () => Promise<SessionTotals> } }).stats;
    if (stats?.session === undefined) {
      namespaceMissingRef.current = true;
      setLoading(false);
      return;
    }
    let cancelled = false;
    inFlightRef.current = true;
    setLoading(true);
    stats
      .session()
      .then((next) => {
        if (cancelled) return;
        setTotals(next);
        setError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // Audit M1 (3N.2): a legacy orchestrator (pre-3N.2 binary)
        // serving an up-to-date TUI returns `not_found` from
        // `stats.session`. Treat as "namespace absent forever" — cache
        // the verdict and stop polling.
        const code = (err as { code?: string } | null)?.code;
        if (code === 'not_found') {
          namespaceMissingRef.current = true;
          return;
        }
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

  return { totals, loading, error };
}
