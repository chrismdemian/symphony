import type {
  CompletionsBroker,
  CompletionsListener,
  CompletionSummary,
} from './completion-summarizer-types.js';

/**
 * Phase 3K — Single-channel pub-sub for `CompletionSummary` payloads.
 *
 * Mirrors `WorkerEventBroker` (`src/rpc/event-broker.ts`):
 *   - Snapshot-then-iterate so listener cleanup mid-publish doesn't
 *     skip remaining listeners.
 *   - Swallow listener throws so a faulty subscriber can't poison
 *     fan-out for siblings.
 *   - Listeners receive LIVE TAIL only — no replay buffer. Callers
 *     that need scroll-back should consult the worker's persisted
 *     output via `workers.tail` (Phase 3K does not buffer summaries).
 *
 * No per-worker keying: completion summaries are a global feed, the
 * TUI's chat panel subscribes once per session.
 */
export class WorkerCompletionsBroker implements CompletionsBroker {
  private readonly listeners = new Set<CompletionsListener>();

  subscribe(listener: CompletionsListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  publish(summary: CompletionSummary): void {
    if (this.listeners.size === 0) return;
    const snapshot = Array.from(this.listeners);
    for (const listener of snapshot) {
      try {
        listener(summary);
      } catch {
        // Faulty listener must not poison fan-out for siblings.
      }
    }
  }

  clear(): void {
    this.listeners.clear();
  }

  subscriberCount(): number {
    return this.listeners.size;
  }
}
