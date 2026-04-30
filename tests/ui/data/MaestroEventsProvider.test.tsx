import React from 'react';
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { Text } from 'ink';
import { EventEmitter } from 'node:events';
import {
  MaestroEventsProvider,
  useMaestroData,
  type MaestroController,
} from '../../../src/ui/data/MaestroEventsProvider.js';
import type { MaestroEvent } from '../../../src/orchestrator/maestro/process.js';

class FakeMaestroSource implements MaestroController {
  readonly emitter = new EventEmitter();
  readonly iters: AsyncIterator<MaestroEvent>[] = [];
  readonly sent: string[] = [];

  sendUserMessage(text: string): void {
    this.sent.push(text);
  }

  events(): AsyncIterable<MaestroEvent> {
    const queue: MaestroEvent[] = [];
    const waiters: Array<(e: MaestroEvent | undefined) => void> = [];
    let stopped = false;
    const emitter = this.emitter;
    const onEvent = (e: MaestroEvent): void => {
      const w = waiters.shift();
      if (w !== undefined) w(e);
      else queue.push(e);
    };
    const onStop = (): void => {
      stopped = true;
      while (waiters.length > 0) waiters.shift()!(undefined);
    };
    emitter.on('event', onEvent);
    emitter.once('stopped', onStop);

    const iters = this.iters;
    const iter: AsyncIterableIterator<MaestroEvent> = {
      [Symbol.asyncIterator]() {
        return iter;
      },
      async next(): Promise<IteratorResult<MaestroEvent>> {
        if (queue.length > 0) {
          return { value: queue.shift()!, done: false };
        }
        if (stopped) return { value: undefined as never, done: true };
        const next = await new Promise<MaestroEvent | undefined>((r) => waiters.push(r));
        if (next === undefined) return { value: undefined as never, done: true };
        return { value: next, done: false };
      },
      async return(): Promise<IteratorResult<MaestroEvent>> {
        emitter.off('event', onEvent);
        emitter.off('stopped', onStop);
        return { value: undefined as never, done: true };
      },
    };
    iters.push(iter);
    return iter;
  }

  emit(event: MaestroEvent): void {
    this.emitter.emit('event', event);
  }

  stop(): void {
    this.emitter.emit('stopped');
  }
}

function Probe(): React.JSX.Element {
  const data = useMaestroData();
  const lastTurn = data.turns[data.turns.length - 1];
  const summary =
    lastTurn === undefined
      ? '(no turns)'
      : lastTurn.kind === 'user'
        ? `user: ${lastTurn.text}`
        : `assistant: ${lastTurn.blocks.map((b) => (b.kind === 'text' ? b.text : `[${b.kind}]`)).join(' | ')}`;
  return (
    <Text>
      session={data.sessionId ?? 'null'} | turns={data.turns.length} | inFlight={data.turn.inFlight ? 'yes' : 'no'} | tool={data.turn.currentTool ?? 'null'} | last={summary}
    </Text>
  );
}

function flushMicrotasks(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}

describe('MaestroEventsProvider', () => {
  it('runs ONE iterator and fans state to consumers', async () => {
    const source = new FakeMaestroSource();
    const { lastFrame, unmount } = render(
      <MaestroEventsProvider source={source} now={() => 100}>
        <Probe />
      </MaestroEventsProvider>,
    );

    expect(lastFrame()).toContain('session=null');
    expect(lastFrame()).toContain('turns=0');

    source.emit({ type: 'system_init', sessionId: 'abc-123' });
    await flushMicrotasks();
    expect(lastFrame()).toContain('session=abc-123');

    source.emit({ type: 'turn_started' });
    source.emit({ type: 'assistant_text', text: 'Hello' });
    source.emit({ type: 'assistant_text', text: ', world' });
    await flushMicrotasks();
    expect(lastFrame()).toContain('inFlight=yes');
    expect(lastFrame()).toContain('Hello, world');

    source.emit({ type: 'tool_use', callId: 'c1', name: 'list_workers', input: {} });
    await flushMicrotasks();
    expect(lastFrame()).toContain('tool=list_workers');

    source.emit({ type: 'tool_result', callId: 'c1', content: '[]', isError: false });
    await flushMicrotasks();
    expect(lastFrame()).toContain('tool=null');

    source.emit({ type: 'turn_completed', isError: false, resultText: '' });
    await flushMicrotasks();
    expect(lastFrame()).toContain('inFlight=no');

    expect(source.iters).toHaveLength(1);
    unmount();
  });

  it('exposes pushUserMessage, which appends a user turn', async () => {
    const source = new FakeMaestroSource();
    let captured: ReturnType<typeof useMaestroData> | undefined;
    function Capture(): React.JSX.Element {
      captured = useMaestroData();
      return <Text>n={captured.turns.length}</Text>;
    }
    const { lastFrame, unmount } = render(
      <MaestroEventsProvider source={source} now={() => 7}>
        <Capture />
      </MaestroEventsProvider>,
    );
    expect(lastFrame()).toContain('n=0');

    captured!.pushUserMessage('hi there');
    await flushMicrotasks();
    expect(lastFrame()).toContain('n=1');
    const last = captured!.turns[0];
    expect(last).toEqual({ kind: 'user', id: 'user-0', text: 'hi there', ts: 7 });
    unmount();
  });

  it('throws when useMaestroData is called outside the provider', () => {
    function NoProvider(): React.JSX.Element {
      useMaestroData();
      return <Text>unreachable</Text>;
    }
    // React surfaces hook errors via stderr + the rendered frames;
    // ink-testing-library doesn't propagate them as rejected promises.
    // Suppress stderr noise and assert via the rendered frame buffer.
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((): boolean => true) as typeof process.stderr.write;
    try {
      const { lastFrame, unmount } = render(<NoProvider />);
      // React's default error boundary renders nothing — the frame is
      // empty / lacks our 'unreachable' marker.
      expect(lastFrame()).not.toContain('unreachable');
      unmount();
    } finally {
      process.stderr.write = originalWrite;
    }
  });

  it('cleans up the iterator on unmount (return() called)', async () => {
    const source = new FakeMaestroSource();
    const { unmount } = render(
      <MaestroEventsProvider source={source} now={() => 0}>
        <Probe />
      </MaestroEventsProvider>,
    );
    await flushMicrotasks();
    expect(source.emitter.listenerCount('event')).toBe(1);
    unmount();
    await flushMicrotasks();
    expect(source.emitter.listenerCount('event')).toBe(0);
  });

  it('audit M2: no-op events preserve combined state identity', async () => {
    const source = new FakeMaestroSource();
    let snapshots: Array<ReturnType<typeof useMaestroData>> = [];
    function Capture(): React.JSX.Element {
      const data = useMaestroData();
      snapshots.push(data);
      return <Text>n={data.turns.length}</Text>;
    }
    const { unmount } = render(
      <MaestroEventsProvider source={source} now={() => 0}>
        <Capture />
      </MaestroEventsProvider>,
    );
    await flushMicrotasks();
    snapshots = []; // discard initial-render snapshots
    // Empty assistant_text is a no-op at the chat reducer AND the
    // turn reducer. The combined reducer must short-circuit and
    // return the SAME state object so React skips the provider
    // re-render entirely.
    source.emit({ type: 'assistant_text', text: '' });
    await flushMicrotasks();
    // No additional render observed — the reducer returned the same
    // state ref, so React's `Object.is` bailed out.
    expect(snapshots).toHaveLength(0);
    unmount();
  });

  it('audit M3: parent re-renders do not tear down the iterator pump', async () => {
    const source = new FakeMaestroSource();
    function Parent(): React.JSX.Element {
      const [, force] = React.useReducer((n: number) => n + 1, 0);
      // Re-render parent on a microtask so the provider sees a fresh
      // `now` identity (inline arrow: `now={() => 0}`).
      React.useEffect(() => {
        const id = setInterval(() => force(), 5);
        return () => clearInterval(id);
      }, []);
      return (
        <MaestroEventsProvider source={source} now={() => 0}>
          <Text>x</Text>
        </MaestroEventsProvider>
      );
    }
    const { unmount } = render(<Parent />);
    // Let the parent re-render a handful of times.
    await new Promise((r) => setTimeout(r, 80));
    // Without the M3 fix, every parent re-render would tear down +
    // restart the iterator. With the ref pattern, only ONE iterator
    // ever opens.
    expect(source.iters.length).toBe(1);
    unmount();
  });

  it('audit M4: empty pushUserMessage is a no-op (no orphan ❯ bubble)', async () => {
    const source = new FakeMaestroSource();
    let captured: ReturnType<typeof useMaestroData> | undefined;
    function Capture(): React.JSX.Element {
      captured = useMaestroData();
      return <Text>n={captured.turns.length}</Text>;
    }
    const { unmount } = render(
      <MaestroEventsProvider source={source} now={() => 0}>
        <Capture />
      </MaestroEventsProvider>,
    );
    await flushMicrotasks();
    captured!.pushUserMessage('');
    captured!.pushUserMessage('   ');
    captured!.pushUserMessage('\n\t  ');
    await flushMicrotasks();
    expect(captured!.turns).toHaveLength(0);
    unmount();
  });

  it('audit C1: a non-turn-in-flight throw still pushes the user turn', async () => {
    const source = new FakeMaestroSource();
    let captured: ReturnType<typeof useMaestroData> | undefined;
    function Capture(): React.JSX.Element {
      captured = useMaestroData();
      return <Text>n={captured.turns.length}</Text>;
    }
    // Override sendUserMessage to throw a generic error AFTER the
    // hypothetical write completed (e.g., EPIPE recovery throw).
    source.sendUserMessage = (_text: string): void => {
      throw new Error('write EPIPE');
    };
    const { unmount, rerender: _rerender } = render(
      <MaestroEventsProvider source={source} now={() => 0}>
        <Capture />
      </MaestroEventsProvider>,
    );
    await flushMicrotasks();
    const result = captured!.sendUserMessage('hello');
    await flushMicrotasks();
    // Force a re-render so React commits the dispatched state and
    // Capture re-runs to refresh the `captured` reference.
    await flushMicrotasks();
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('send_failed');
    // The user turn IS present — non-turn-in-flight throws don't
    // orphan the message (audit C1).
    expect(captured!.turns).toHaveLength(1);
    expect(captured!.turns[0]).toMatchObject({ kind: 'user', text: 'hello' });
    unmount();
  });

  it('preserves prior turn references across reducer updates (memo invariant)', async () => {
    const source = new FakeMaestroSource();
    let captured: ReturnType<typeof useMaestroData> | undefined;
    function Capture(): React.JSX.Element {
      captured = useMaestroData();
      return <Text>n={captured.turns.length}</Text>;
    }
    const { unmount, lastFrame } = render(
      <MaestroEventsProvider source={source} now={() => 0}>
        <Capture />
      </MaestroEventsProvider>,
    );
    // Let the iterator pump's useEffect run BEFORE we push events into
    // the source — otherwise the handler isn't attached yet and emits
    // are lost.
    await flushMicrotasks();
    // Open turn 1 (user) + turn 2 (assistant) so we have a prior turn
    // whose identity must survive a streaming chunk on the LAST turn.
    captured!.pushUserMessage('q');
    source.emit({ type: 'turn_started' });
    source.emit({ type: 'assistant_text', text: 'a' });
    // Two microtask drains — React 19 + ink commit needs the second
    // hop for `Capture` to re-run with the post-dispatch controller.
    await flushMicrotasks();
    await flushMicrotasks();
    void lastFrame();
    const snap1 = captured!.turns;
    expect(snap1).toHaveLength(2);

    source.emit({ type: 'assistant_text', text: 'b' });
    await flushMicrotasks();
    await flushMicrotasks();
    const snap2 = captured!.turns;
    expect(snap2).toHaveLength(2);

    // Prior user turn keeps identity (memo invariant).
    expect(snap2[0]).toBe(snap1[0]);
    // Last assistant turn IS a new ref (its blocks accumulated).
    expect(snap2[1]).not.toBe(snap1[1]);
    const finalAssistant = snap2[1];
    if (finalAssistant?.kind !== 'assistant') throw new Error('expected assistant');
    expect(finalAssistant.blocks).toEqual([{ kind: 'text', text: 'ab' }]);
    unmount();
  });
});
