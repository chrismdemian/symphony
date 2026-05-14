import type {
  TaskReadyBroker,
  TaskReadyEvent,
  TaskReadyListener,
} from './task-ready-types.js';

/**
 * Phase 3P — Single-channel pub-sub for `TaskReadyEvent` payloads.
 *
 * Identical shape to `AutoMergeBrokerImpl` (3O.1):
 *   - Snapshot-then-iterate so listener cleanup mid-publish doesn't
 *     skip remaining listeners.
 *   - Swallow listener throws so a faulty subscriber can't poison
 *     fan-out for siblings.
 *   - LIVE TAIL only — no replay buffer. The TUI subscribes once per
 *     session; late subscribers don't see prior events. Acceptable
 *     because Maestro learns about ready transitions via the live
 *     chat row, not by replaying history.
 */
export class TaskReadyBrokerImpl implements TaskReadyBroker {
  private readonly listeners = new Set<TaskReadyListener>();

  subscribe(listener: TaskReadyListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  publish(event: TaskReadyEvent): void {
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

export function createTaskReadyBroker(): TaskReadyBroker {
  return new TaskReadyBrokerImpl();
}
