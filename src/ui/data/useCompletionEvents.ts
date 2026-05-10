import { useEffect } from 'react';
import type { TuiRpc } from '../runtime/rpc.js';
import type { CompletionSummary } from '../../orchestrator/completion-summarizer-types.js';
import type { SystemSummary } from './chatHistoryReducer.js';

/**
 * Phase 3K — subscribe to the orchestrator's `completions.events` topic
 * and forward each `CompletionSummary` into the chat panel via the
 * provided `pushSystem` callback.
 *
 * No backfill / no replay: the broker is live-tail only
 * (`src/orchestrator/completions-broker.ts`). Summaries that landed
 * before the TUI started subscribing are not surfaced — by design;
 * stale completions in chat would confuse the conversation flow more
 * than they'd inform.
 *
 * Name resolution: the server-side payload's `workerName` is a slug
 * fallback (`worker-abc123`). When `getWorkerName(workerId)` returns a
 * defined string, that overrides the payload — typical wiring is
 * `getWorkerName: (id) => instruments.get(id)` so completed workers
 * still show their TUI-allocated name (`Violin`, `Cello`, …) even
 * though the server has no instrument concept.
 *
 * Idempotency: the hook ignores duplicate `workerId` arrivals (the
 * server's summarizer is itself idempotent per-worker, but a
 * resubscribe race after RPC reconnect could replay; defense in
 * depth). Tracking is a `Set<string>` of seen workerIds; capacity is
 * unbounded (workers complete once per Symphony lifetime so growth is
 * negligible).
 */

export interface UseCompletionEventsOptions {
  readonly rpc: TuiRpc;
  /**
   * Push a system summary into the chat reducer. Typically
   * `useMaestroData().pushSystem`.
   */
  readonly pushSystem: (summary: SystemSummary) => void;
  /**
   * Resolve a worker's display name from its id. Return `undefined`
   * to fall back to the server-provided `workerName`.
   */
  readonly getWorkerName?: (workerId: string) => string | undefined;
}

export function useCompletionEvents(opts: UseCompletionEventsOptions): void {
  const { rpc, pushSystem, getWorkerName } = opts;

  useEffect(() => {
    let cancelled = false;
    let cleanup: (() => void) | null = null;
    const seen = new Set<string>();

    void (async () => {
      try {
        const subscription = await rpc.subscribe(
          'completions.events',
          undefined,
          (payload) => {
            if (cancelled) return;
            const summary = payload as CompletionSummary;
            if (seen.has(summary.workerId)) return;
            seen.add(summary.workerId);
            const resolvedName = getWorkerName?.(summary.workerId);
            const workerName = resolvedName !== undefined && resolvedName.length > 0
              ? resolvedName
              : summary.workerName;
            pushSystem({
              workerName,
              projectName: summary.projectName,
              statusKind: summary.statusKind,
              durationMs: summary.durationMs,
              headline: summary.headline,
              ...(summary.metrics !== undefined ? { metrics: summary.metrics } : {}),
              ...(summary.details !== undefined ? { details: summary.details } : {}),
              fallback: summary.fallback,
            });
          },
        );
        if (cancelled) {
          void subscription.unsubscribe();
          return;
        }
        cleanup = (): void => {
          void subscription.unsubscribe();
        };
      } catch {
        // Subscribe failed (e.g., server doesn't support the topic in
        // a downgrade scenario). Silent — the chat panel still works
        // for normal Maestro events; completions are an enhancement.
      }
    })();

    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, [rpc, pushSystem, getWorkerName]);
}
