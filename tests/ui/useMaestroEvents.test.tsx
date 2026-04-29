import { describe, it, expect } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { Text } from 'ink';
import {
  useMaestroEvents,
  type MaestroSource,
} from '../../src/ui/data/useMaestroEvents.js';
import type { MaestroEvent } from '../../src/orchestrator/maestro/process.js';

/**
 * Audit C2 regression — `useMaestroEvents` must call `iter.return()` on
 * cleanup so the underlying iterator's `finally` block runs and the
 * MaestroProcess emitter listener is removed. Without this, every
 * unmount leaks a listener.
 */

class TrackedSource implements MaestroSource {
  public iteratorCount = 0;
  public openIterators = 0;
  private readonly seed: MaestroEvent[];

  constructor(seed: MaestroEvent[] = []) {
    this.seed = seed;
  }

  events(): AsyncIterable<MaestroEvent> {
    this.iteratorCount += 1;
    this.openIterators += 1;
    const onReturn = (): void => {
      this.openIterators -= 1;
    };
    let i = 0;
    let done = false;
    const queue = [...this.seed];
    return {
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<MaestroEvent>> {
            if (done) return { done: true, value: undefined };
            if (i < queue.length) {
              const value = queue[i]!;
              i += 1;
              return { done: false, value };
            }
            // No more events: simulate "still streaming" by hanging.
            // The hook's cleanup must call return() to abort us.
            await new Promise<void>(() => {
              // never resolves
            });
            return { done: true, value: undefined };
          },
          async return(): Promise<IteratorResult<MaestroEvent>> {
            done = true;
            onReturn();
            return { done: true, value: undefined };
          },
        };
      },
    };
  }
}

function Probe(props: { source: MaestroSource }): React.JSX.Element {
  const { sessionId, count } = useMaestroEvents(props.source);
  return (
    <>
      <Text>SESSION={sessionId ?? 'null'}</Text>
      <Text>COUNT={String(count)}</Text>
    </>
  );
}

describe('useMaestroEvents', () => {
  it('processes a system_init event into sessionId', async () => {
    const source = new TrackedSource([
      { type: 'system_init', sessionId: 'fake-1' } as MaestroEvent,
    ]);
    const { lastFrame, unmount } = render(<Probe source={source} />);
    await new Promise((r) => setImmediate(r));
    expect(lastFrame()).toContain('SESSION=fake-1');
    expect(lastFrame()).toContain('COUNT=1');
    await unmount();
  });

  it('calls iter.return() on unmount, freeing the iterator (audit C2)', async () => {
    const source = new TrackedSource([
      { type: 'system_init', sessionId: 's1' } as MaestroEvent,
    ]);
    const { unmount } = render(<Probe source={source} />);
    await new Promise((r) => setImmediate(r));
    expect(source.openIterators).toBe(1);
    unmount();
    // The cleanup function calls iter.return() synchronously; await microtask
    // for the promise chain to settle.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(source.openIterators).toBe(0);
  });

  it('multiple consumers each get their own iterator', async () => {
    const source = new TrackedSource();
    const { unmount: u1 } = render(<Probe source={source} />);
    const { unmount: u2 } = render(<Probe source={source} />);
    await new Promise((r) => setImmediate(r));
    expect(source.iteratorCount).toBe(2);
    expect(source.openIterators).toBe(2);
    u1();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(source.openIterators).toBe(1);
    u2();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(source.openIterators).toBe(0);
  });
});
