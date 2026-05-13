import { useEffect } from 'react';
import type { TuiRpc } from '../runtime/rpc.js';
import type { AutoMergeEvent, AutoMergeKind } from '../../orchestrator/auto-merge-types.js';
import type { SystemSummary } from './chatHistoryReducer.js';
import type { CompletionStatusKind } from '../../orchestrator/completion-summarizer-types.js';

/**
 * Phase 3O.1 — subscribe to the orchestrator's `auto-merge.events` topic
 * and forward each `AutoMergeEvent` into the chat panel via the
 * provided `pushSystem` callback.
 *
 * Mirrors `useCompletionEvents` in shape. Live-tail only (no replay
 * buffer); receipt-time `workerName` is the server's slug — the Bubble
 * re-resolves via `InstrumentNameContext` at render time so a slow
 * allocator doesn't lock the row on the slug forever.
 *
 * AutoMergeKind → CompletionStatusKind mapping for the SystemSummary
 * carrier (drives glyph + color in `Bubble.SystemBubble`):
 *   'merged'   → 'completed' (✓ success/gold)
 *   'failed'   → 'failed'    (✗ error/red)
 *   'declined' → 'timeout'   (⏱ warning/amber)
 *   'asked'    → 'timeout'   (⏱ warning/amber)
 *   'ready'    → 'timeout'   (⏱ warning/amber)
 *
 * The headline carries the actual user-facing string (server-side
 * formatted for remote-client consistency). No new SystemSummary
 * shape needed.
 */

const KIND_TO_STATUS: Readonly<Record<AutoMergeKind, CompletionStatusKind>> = {
  merged: 'completed',
  failed: 'failed',
  declined: 'timeout',
  asked: 'timeout',
  ready: 'timeout',
};

export interface UseAutoMergeEventsOptions {
  readonly rpc: TuiRpc;
  readonly pushSystem: (summary: SystemSummary) => void;
}

export function useAutoMergeEvents(opts: UseAutoMergeEventsOptions): void {
  const { rpc, pushSystem } = opts;

  useEffect(() => {
    let cancelled = false;
    let cleanup: (() => void) | null = null;

    void (async () => {
      try {
        const subscription = await rpc.subscribe(
          'auto-merge.events',
          undefined,
          (payload) => {
            if (cancelled) return;
            const event = payload as AutoMergeEvent;
            const statusKind = KIND_TO_STATUS[event.kind];
            // Build the SystemSummary. Headline already carries the
            // primary message; details accumulate cleanup-warning or
            // unclear-answer hints when present (the Bubble renders
            // them on muted-gray indented sub-rows).
            const detailLines: string[] = [];
            if (event.cleanupWarning !== undefined && event.cleanupWarning.length > 0) {
              detailLines.push(`cleanup warning: ${event.cleanupWarning}`);
            }
            if (event.unclearAnswer !== undefined && event.unclearAnswer.length > 0) {
              detailLines.push(`raw answer: '${event.unclearAnswer}'`);
            }
            if (event.reason !== undefined && event.reason.length > 0) {
              detailLines.push(event.reason);
            }
            const summary: SystemSummary = {
              workerId: event.workerId,
              workerName: event.workerId, // resolver overrides at render time
              projectName: event.projectName,
              statusKind,
              durationMs: null,
              headline: event.headline,
              ...(detailLines.length > 0 ? { details: detailLines.join('\n') } : {}),
              fallback: false,
            };
            pushSystem(summary);
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
        // a downgrade scenario). Silent — chat still works for normal
        // Maestro events; auto-merge events are an enhancement.
      }
    })();

    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, [rpc, pushSystem]);
}
