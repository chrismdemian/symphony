/**
 * Phase 8D.1 — Single-channel pub-sub for automation-fired WAKE HINTS.
 *
 * Mirrors `AutoMergeBrokerImpl` (Phase 3O.1) exactly: snapshot-then-iterate,
 * swallow listener throws, live-tail only (no replay).
 *
 * IMPORTANT — this is a latency hint, NOT the delivery channel. The RPC
 * event frame is sent with `dropOnBackpressure: true` (see
 * `rpc/dispatcher.ts`), so a frame CAN be dropped. Correctness rests on the
 * launcher's pull (`automations.takePending`) + its safety poll; the event
 * only lets the launcher react immediately instead of waiting for the next
 * poll. Never make a scheduled run depend on a delivered event.
 */

/** Emitted after the scheduler claims a due automation. A wake signal. */
export interface AutomationEvent {
  readonly runLogId: number;
  readonly automationId: string;
}

export type AutomationListener = (event: AutomationEvent) => void;

export interface AutomationsBroker {
  subscribe(listener: AutomationListener): () => void;
  publish(event: AutomationEvent): void;
  clear(): void;
  subscriberCount(): number;
}

export class AutomationsBrokerImpl implements AutomationsBroker {
  private readonly listeners = new Set<AutomationListener>();

  subscribe(listener: AutomationListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  publish(event: AutomationEvent): void {
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

export function createAutomationsBroker(): AutomationsBroker {
  return new AutomationsBrokerImpl();
}
