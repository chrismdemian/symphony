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
 * Name resolution: the hook stores the server's `workerName` slug as a
 * fallback in the SystemSummary AND forwards `workerId` so the
 * Bubble can re-resolve via `InstrumentNameContext` at render time
 * (audit C1 fix — receipt-time resolution loses the race when a
 * worker completes faster than one poll-tick).
 *
 * No client-side dedup: the server's summarizer is the source of
 * truth (`createCompletionSummarizer` tracks in-flight per workerId).
 * A worker that completes, gets resumed, and completes again should
 * legitimately produce two summaries — client-side deduping by
 * workerId would drop the second, which is the exact case we want to
 * surface.
 */

export interface UseCompletionEventsOptions {
  readonly rpc: TuiRpc;
  /**
   * Push a system summary into the chat reducer. Typically
   * `useMaestroData().pushSystem`.
   */
  readonly pushSystem: (summary: SystemSummary) => void;
}

export function useCompletionEvents(opts: UseCompletionEventsOptions): void {
  const { rpc, pushSystem } = opts;

  useEffect(() => {
    let cancelled = false;
    let cleanup: (() => void) | null = null;

    void (async () => {
      try {
        const subscription = await rpc.subscribe(
          'completions.events',
          undefined,
          (payload) => {
            if (cancelled) return;
            const summary = payload as CompletionSummary;
            pushSystem({
              workerId: summary.workerId,
              workerName: summary.workerName,
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
  }, [rpc, pushSystem]);
}
