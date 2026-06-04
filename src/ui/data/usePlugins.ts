import { useCallback, useEffect, useRef, useState } from 'react';
import type { PluginListItem } from '../../rpc/router-impl.js';
import type { TuiRpc } from '../runtime/rpc.js';

/**
 * Phase 7C — fetch the installed-plugin list via RPC for the Plugins panel.
 *
 * Unlike `useWorkers` (1 s background poll for spontaneous status flips),
 * the plugin list only changes on USER action (enable/disable/install/
 * remove), so this hook does NOT poll by default — it fetches on mount and
 * the panel calls `refresh()` after each mutation. A `pollIntervalMs` is
 * still accepted (tests / a future event topic) but defaults to 0 (off).
 *
 * `inFlightRef` guards against overlapping fetches (mirrors `useWorkers`
 * audit M2); `unmountedRef` guards fire-and-forget `setState` after the
 * popup closes (3C/3J precedent).
 */
export interface UsePluginsResult {
  readonly plugins: readonly PluginListItem[];
  readonly loading: boolean;
  readonly error: Error | null;
  refresh(): void;
}

export interface UsePluginsOptions {
  /** Background poll cadence in ms; <=0 disables. Default 0 (off). */
  readonly pollIntervalMs?: number;
}

export function usePlugins(rpc: TuiRpc, options?: UsePluginsOptions): UsePluginsResult {
  const [plugins, setPlugins] = useState<readonly PluginListItem[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<Error | null>(null);
  const [tick, setTick] = useState<number>(0);
  const pollIntervalMs = options?.pollIntervalMs ?? 0;
  const inFlightRef = useRef(false);
  // A `refresh()` (or poll tick) that lands while a `list()` is in flight
  // would otherwise be dropped — `tick` advanced but the early-return
  // skipped the fetch. Record it and re-bump `tick` from the in-flight
  // `.finally` so the deferred refresh runs (3L `useQueue` precedent).
  // Critical for the panel's "mutate → refetch → reflect" model: each
  // mutation fires its own `refresh()`, which can overlap a prior refetch.
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
    rpc.call.plugins
      .list()
      .then((list) => {
        if (cancelled) return;
        setPlugins(list);
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

  return { plugins, loading, error, refresh };
}
