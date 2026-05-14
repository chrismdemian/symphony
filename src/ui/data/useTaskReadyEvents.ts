import { useEffect } from 'react';
import type { TuiRpc } from '../runtime/rpc.js';
import type { TaskReadyEvent } from '../../orchestrator/task-ready-types.js';
import type { SystemSummary } from './chatHistoryReducer.js';

/**
 * Phase 3P — subscribe to the orchestrator's `task-ready.events` topic
 * and forward each `TaskReadyEvent` into the chat panel via the
 * provided `pushSystem` callback.
 *
 * Mirrors `useAutoMergeEvents` in shape. Live-tail only (no replay
 * buffer).
 *
 * TaskReadyEvent → SystemSummary mapping:
 *   - statusKind: 'completed' — gold ✓ glyph. The bubble's headline
 *     ("Task ready: B (p1) — A completed") already names the trigger
 *     completion, and the glyph reinforces that a successful unblock
 *     just happened. Maestro can read the row and call list_tasks
 *     (ready_only=true) to pick up the work.
 *   - workerId: server stamps a synthetic `task-ready-<taskId>` slug.
 *     Useful for chat reducer keying; no live worker corresponds to
 *     it (the row is task-scoped, not worker-scoped).
 *   - durationMs: null. The event isn't a duration-bearing completion.
 *
 * Subscribe failure is swallowed silently — the chat still works for
 * normal Maestro events; ready notifications are an enhancement.
 */

export interface UseTaskReadyEventsOptions {
  readonly rpc: TuiRpc;
  readonly pushSystem: (summary: SystemSummary) => void;
}

export function useTaskReadyEvents(opts: UseTaskReadyEventsOptions): void {
  const { rpc, pushSystem } = opts;

  useEffect(() => {
    let cancelled = false;
    let cleanup: (() => void) | null = null;

    void (async () => {
      try {
        const subscription = await rpc.subscribe(
          'task-ready.events',
          undefined,
          (payload) => {
            if (cancelled) return;
            const event = payload as TaskReadyEvent;
            const summary: SystemSummary = {
              workerId: `task-ready-${event.task.id}`,
              workerName: 'Symphony',
              projectName: event.projectName,
              statusKind: 'completed',
              durationMs: null,
              headline: event.headline,
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
        // a downgrade scenario). Silent.
      }
    })();

    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, [rpc, pushSystem]);
}
