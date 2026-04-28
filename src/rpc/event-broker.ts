import type { StreamEvent } from '../workers/types.js';

/**
 * Worker event broker — Phase 2B.2.
 *
 * `Worker.events` is a single-consumer AsyncIterable (Phase 1B Known
 * Gotcha). The orchestrator's lifecycle already claims that iterator via
 * `attachEventTap` to populate the per-worker output buffer. The broker
 * does NOT re-iterate `Worker.events` — that would either fail (if the
 * implementation strictly rejects a second consumer) or silently steal
 * events from the lifecycle.
 *
 * Instead, the lifecycle's tap calls `broker.publish(workerId, event)`
 * for every event it observes. The broker fans out to subscribers
 * registered for that workerId. Pure pub-sub layer.
 *
 * Subscribers receive LIVE TAIL only — events that arrive after they
 * subscribe. Replay-from-buffer is a Phase 3 concern (TUI scroll-back is
 * served by `workers.getOutput` over RPC, not the event stream).
 *
 * Listener invocation is synchronous and must not throw — errors are
 * swallowed so a faulty subscriber can't poison fan-out for siblings.
 * Back-pressure (slow client) is handled at the WS-server layer, not here.
 */

export type WorkerEventListener = (event: StreamEvent) => void;

export class WorkerEventBroker {
  private readonly subscribers = new Map<string, Set<WorkerEventListener>>();

  /**
   * Register a listener for a worker's stream events. Returns an
   * unsubscribe function. Idempotent for the same listener instance.
   */
  subscribe(workerId: string, listener: WorkerEventListener): () => void {
    let set = this.subscribers.get(workerId);
    if (!set) {
      set = new Set();
      this.subscribers.set(workerId, set);
    }
    set.add(listener);
    return () => {
      const current = this.subscribers.get(workerId);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) {
        this.subscribers.delete(workerId);
      }
    };
  }

  /** Called by the lifecycle's event tap on every observed event. */
  publish(workerId: string, event: StreamEvent): void {
    const set = this.subscribers.get(workerId);
    if (!set || set.size === 0) return;
    // Snapshot before iteration — listener cleanup during fan-out
    // (e.g. WS close mid-publish) must not skip remaining listeners.
    const snapshot = Array.from(set);
    for (const listener of snapshot) {
      try {
        listener(event);
      } catch {
        // Faulty listener must not poison fan-out for siblings.
      }
    }
  }

  /** Subscribers attached to a worker (test seam). */
  subscriberCount(workerId: string): number {
    return this.subscribers.get(workerId)?.size ?? 0;
  }

  /** Total tracked workers (test seam). */
  workerCount(): number {
    return this.subscribers.size;
  }

  hasSubscribers(workerId: string): boolean {
    return this.subscriberCount(workerId) > 0;
  }

  /** Drop all subscribers — called on RPC server close. */
  clear(): void {
    this.subscribers.clear();
  }
}
