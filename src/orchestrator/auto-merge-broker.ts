import type {
  AutoMergeBroker,
  AutoMergeEvent,
  AutoMergeListener,
} from './auto-merge-types.js';

/**
 * Phase 3O.1 — Single-channel pub-sub for `AutoMergeEvent` payloads.
 *
 * Mirrors `WorkerCompletionsBroker` (Phase 3K) exactly:
 *   - Snapshot-then-iterate so listener cleanup mid-publish doesn't
 *     skip remaining listeners.
 *   - Swallow listener throws so a faulty subscriber can't poison
 *     fan-out for siblings.
 *   - Listeners receive LIVE TAIL only — no replay buffer. Late
 *     subscribers don't see prior events. Acceptable because the
 *     auto-merge gate is bound to the same TUI session that runs the
 *     finalize anyway.
 *
 * No per-worker keying: auto-merge events are a global feed, the TUI
 * chat panel subscribes once per session.
 */
export class AutoMergeBrokerImpl implements AutoMergeBroker {
  private readonly listeners = new Set<AutoMergeListener>();

  subscribe(listener: AutoMergeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  publish(event: AutoMergeEvent): void {
    if (this.listeners.size === 0) return;
    const snapshot = Array.from(this.listeners);
    for (const listener of snapshot) {
      try {
        listener(event);
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

export function createAutoMergeBroker(): AutoMergeBroker {
  return new AutoMergeBrokerImpl();
}
