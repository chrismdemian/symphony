import React from 'react';
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { EventEmitter } from 'node:events';
import { ThemeProvider } from '../../../../src/ui/theme/context.js';
import { FocusProvider } from '../../../../src/ui/focus/focus.js';
import { ChatPanel } from '../../../../src/ui/panels/chat/ChatPanel.js';
import {
  MaestroEventsProvider,
  type MaestroController,
} from '../../../../src/ui/data/MaestroEventsProvider.js';
import {
  MaestroTurnInFlightError,
  type MaestroEvent,
} from '../../../../src/orchestrator/maestro/process.js';

const ENTER = '\r';

class FakeMaestro implements MaestroController {
  readonly emitter = new EventEmitter();
  readonly sent: string[] = [];
  private throwOnSend = false;

  setThrowOnSend(value: boolean): void {
    this.throwOnSend = value;
  }

  sendUserMessage(text: string): void {
    if (this.throwOnSend) throw new MaestroTurnInFlightError();
    this.sent.push(text);
  }

  events(): AsyncIterable<MaestroEvent> {
    const queue: MaestroEvent[] = [];
    const waiters: Array<(e: MaestroEvent | undefined) => void> = [];
    let stopped = false;
    const onEvent = (e: MaestroEvent): void => {
      const w = waiters.shift();
      if (w !== undefined) w(e);
      else queue.push(e);
    };
    const onStop = (): void => {
      stopped = true;
      while (waiters.length > 0) waiters.shift()!(undefined);
    };
    this.emitter.on('event', onEvent);
    this.emitter.once('stopped', onStop);
    const emitter = this.emitter;

    const iter: AsyncIterableIterator<MaestroEvent> = {
      [Symbol.asyncIterator]() {
        return iter;
      },
      async next(): Promise<IteratorResult<MaestroEvent>> {
        if (queue.length > 0) return { value: queue.shift()!, done: false };
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
    return iter;
  }

  emit(event: MaestroEvent): void {
    this.emitter.emit('event', event);
  }
}

function flush(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}

interface Harness {
  readonly stdin: { write: (s: string) => void };
  readonly lastFrame: () => string | undefined;
  readonly unmount: () => void;
}

function renderChat(maestro: FakeMaestro): Harness {
  const result = render(
    <ThemeProvider>
      <FocusProvider>
        <MaestroEventsProvider source={maestro} now={() => 0}>
          <ChatPanel />
        </MaestroEventsProvider>
      </FocusProvider>
    </ThemeProvider>,
  );
  return result as unknown as Harness;
}

describe('ChatPanel (3B.1 integration)', () => {
  it('renders an empty chat with the input bar placeholder', async () => {
    const m = new FakeMaestro();
    const { lastFrame, unmount } = renderChat(m);
    await flush();
    // Visual review: the InputBar's placeholder is the single source
    // of "type something" copy. MessageList no longer emits its own
    // empty-state hint.
    expect(lastFrame() ?? '').toContain('Tell Maestro what to do');
    unmount();
  });

  it('sends a typed message and renders the user bubble', async () => {
    const m = new FakeMaestro();
    const { stdin, lastFrame, unmount } = renderChat(m);
    await flush();
    stdin.write('hello world');
    await flush();
    stdin.write(ENTER);
    await flush();
    expect(m.sent).toEqual(['hello world']);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('❯');
    expect(frame).toContain('hello world');
    unmount();
  });

  it('streams an assistant reply chunk-by-chunk and accumulates the text', async () => {
    const m = new FakeMaestro();
    const { stdin, lastFrame, unmount } = renderChat(m);
    await flush();
    stdin.write('hi');
    await flush();
    stdin.write(ENTER);
    await flush();

    m.emit({ type: 'turn_started' });
    await flush();
    m.emit({ type: 'assistant_text', text: 'Hello' });
    await flush();
    m.emit({ type: 'assistant_text', text: ', ' });
    await flush();
    m.emit({ type: 'assistant_text', text: 'world!' });
    await flush();
    m.emit({ type: 'turn_completed', isError: false, resultText: 'Hello, world!' });
    await flush();

    expect(lastFrame() ?? '').toContain('Hello, world!');
    unmount();
  });

  it('renders interleaved tool blocks in order', async () => {
    const m = new FakeMaestro();
    const { stdin, lastFrame, unmount } = renderChat(m);
    await flush();
    stdin.write('check workers');
    await flush();
    stdin.write(ENTER);
    await flush();

    m.emit({ type: 'turn_started' });
    await flush();
    m.emit({ type: 'assistant_text', text: 'Looking up workers.' });
    await flush();
    m.emit({ type: 'tool_use', callId: 'c1', name: 'list_workers', input: {} });
    await flush();
    m.emit({ type: 'tool_result', callId: 'c1', content: '[]', isError: false });
    await flush();
    m.emit({ type: 'assistant_text', text: 'No workers running.' });
    await flush();
    m.emit({ type: 'turn_completed', isError: false, resultText: '' });
    await flush();

    const frame = lastFrame() ?? '';
    expect(frame).toContain('Looking up workers.');
    expect(frame).toContain('▸ list_workers');
    expect(frame).toContain('No workers running.');
    unmount();
  });

  it('surfaces MaestroTurnInFlightError as an inline error message', async () => {
    const m = new FakeMaestro();
    m.setThrowOnSend(true);
    const { stdin, lastFrame, unmount } = renderChat(m);
    await flush();
    stdin.write('hi');
    await flush();
    stdin.write(ENTER);
    await flush();
    expect(m.sent).toEqual([]);
    expect(lastFrame() ?? '').toContain('A previous turn is still streaming');
    unmount();
  });

  it('clears the error on a subsequent successful submit', async () => {
    const m = new FakeMaestro();
    m.setThrowOnSend(true);
    const { stdin, lastFrame, unmount } = renderChat(m);
    await flush();
    stdin.write('first');
    await flush();
    stdin.write(ENTER);
    await flush();
    expect(lastFrame() ?? '').toContain('A previous turn is still streaming');

    m.setThrowOnSend(false);
    stdin.write('second');
    await flush();
    stdin.write(ENTER);
    await flush();
    expect(m.sent).toEqual(['second']);
    expect(lastFrame() ?? '').not.toContain('A previous turn is still streaming');
    unmount();
  });
});
