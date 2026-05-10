import { describe, it, expect, vi } from 'vitest';
import { WorkerCompletionsBroker } from '../../src/orchestrator/completions-broker.js';
import type { CompletionSummary } from '../../src/orchestrator/completion-summarizer-types.js';

function makeSummary(overrides: Partial<CompletionSummary> = {}): CompletionSummary {
  return {
    workerId: 'wk-1',
    workerName: 'Violin',
    projectName: 'MathScrabble',
    statusKind: 'completed',
    durationMs: 1000,
    headline: 'h',
    ts: new Date(0).toISOString(),
    fallback: false,
    ...overrides,
  };
}

describe('WorkerCompletionsBroker', () => {
  it('fans publishes to all subscribers in registration order', () => {
    const broker = new WorkerCompletionsBroker();
    const calls: string[] = [];
    broker.subscribe((s) => calls.push(`a:${s.headline}`));
    broker.subscribe((s) => calls.push(`b:${s.headline}`));
    broker.publish(makeSummary({ headline: 'one' }));
    expect(calls).toEqual(['a:one', 'b:one']);
  });

  it('returned unsubscribe stops further notifications', () => {
    const broker = new WorkerCompletionsBroker();
    const fn = vi.fn();
    const unsub = broker.subscribe(fn);
    broker.publish(makeSummary({ headline: 'one' }));
    unsub();
    broker.publish(makeSummary({ headline: 'two' }));
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('swallows listener throws so siblings continue receiving', () => {
    const broker = new WorkerCompletionsBroker();
    const survived = vi.fn();
    broker.subscribe(() => {
      throw new Error('faulty');
    });
    broker.subscribe(survived);
    broker.publish(makeSummary());
    expect(survived).toHaveBeenCalledTimes(1);
  });

  it('snapshots subscribers before iteration so mid-publish unsubscribe is honored next call', () => {
    const broker = new WorkerCompletionsBroker();
    const fn = vi.fn();
    const unsubRef: { current: (() => void) | undefined } = { current: undefined };
    broker.subscribe(() => {
      unsubRef.current?.();
    });
    unsubRef.current = broker.subscribe(fn);
    broker.publish(makeSummary({ headline: 'one' }));
    // First pass: both fire (snapshot taken before iteration).
    expect(fn).toHaveBeenCalledTimes(1);
    broker.publish(makeSummary({ headline: 'two' }));
    // Second pass: only the unsubscriber-listener fires (fn was unsubbed
    // mid first publish but snapshot already had it).
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('clear() drops all subscribers', () => {
    const broker = new WorkerCompletionsBroker();
    const fn = vi.fn();
    broker.subscribe(fn);
    broker.clear();
    broker.publish(makeSummary());
    expect(fn).not.toHaveBeenCalled();
    expect(broker.subscriberCount()).toBe(0);
  });

  it('subscriberCount reports current count', () => {
    const broker = new WorkerCompletionsBroker();
    expect(broker.subscriberCount()).toBe(0);
    const u1 = broker.subscribe(() => {});
    const u2 = broker.subscribe(() => {});
    expect(broker.subscriberCount()).toBe(2);
    u1();
    expect(broker.subscriberCount()).toBe(1);
    u2();
    expect(broker.subscriberCount()).toBe(0);
  });

  it('publish to broker with no subscribers is a no-op (no throw)', () => {
    const broker = new WorkerCompletionsBroker();
    expect(() => broker.publish(makeSummary())).not.toThrow();
  });
});
