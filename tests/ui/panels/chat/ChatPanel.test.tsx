import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { EventEmitter } from 'node:events';
import { ThemeProvider } from '../../../../src/ui/theme/context.js';
import { FocusProvider } from '../../../../src/ui/focus/focus.js';
import { AppActionsProvider } from '../../../../src/ui/runtime/AppActions.js';
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

interface RenderChatOptions {
  readonly onRequestExit?: () => void;
}

function renderChat(maestro: FakeMaestro, opts: RenderChatOptions = {}): Harness {
  const onRequestExit = opts.onRequestExit ?? (() => {});
  const result = render(
    <ThemeProvider>
      <FocusProvider>
        <AppActionsProvider value={{ onRequestExit }}>
          <MaestroEventsProvider source={maestro} now={() => 0}>
            <ChatPanel />
          </MaestroEventsProvider>
        </AppActionsProvider>
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

  it('renders tool calls with extracted summary and ANSI-stripped result', async () => {
    const m = new FakeMaestro();
    const { stdin, lastFrame, unmount } = renderChat(m);
    await flush();
    stdin.write('read it');
    await flush();
    stdin.write(ENTER);
    await flush();

    m.emit({ type: 'turn_started' });
    await flush();
    m.emit({
      type: 'tool_use',
      callId: 'c1',
      name: 'Read',
      input: { file_path: '/tmp/example.txt' },
    });
    await flush();
    m.emit({
      type: 'tool_result',
      callId: 'c1',
      content: '\x1b[32mhello\x1b[0m world',
      isError: false,
    });
    await flush();
    m.emit({ type: 'turn_completed', isError: false, resultText: '' });
    await flush();

    const frame = lastFrame() ?? '';
    expect(frame).toContain('▸ Read /tmp/example.txt');
    expect(frame).toContain('hello world');
    expect(frame).not.toContain('\x1b[32m');
    unmount();
  });

  it('intercepts /quit, calls onRequestExit, and does NOT send to Maestro', async () => {
    const m = new FakeMaestro();
    const onExit = vi.fn();
    const { stdin, unmount } = renderChat(m, { onRequestExit: onExit });
    await flush();
    stdin.write('/quit');
    await flush();
    stdin.write(ENTER);
    await flush();
    expect(onExit).toHaveBeenCalledOnce();
    expect(m.sent).toEqual([]);
    unmount();
  });

  it('surfaces unknown commands inline rather than sending them', async () => {
    const m = new FakeMaestro();
    const { stdin, lastFrame, unmount } = renderChat(m);
    await flush();
    stdin.write('/notarealcmd');
    await flush();
    stdin.write(ENTER);
    await flush();
    expect(m.sent).toEqual([]);
    expect(lastFrame() ?? '').toContain('Unknown command:');
    unmount();
  });

  // Note: multi-line `/quit` (Ctrl+J between command and rest) is
  // covered at the unit layer:
  //   - InputBuffer.test.ts proves embedded `\n` survives `insertChunk`
  //   - slashCommands.test.ts proves `parseSlashCommand` returns null
  //     for any text containing `\n` (multi-line bypass)
  // The integration shape would require driving Ink's bracketed-paste
  // channel through ink-testing-library, which doesn't decode it.
  // Keeping the contract at the unit level avoids a brittle test that
  // proves the wrong path (audit 3B.2 M5).

  it('defers onRequestExit so React commit completes before launcher unmount (audit M3)', async () => {
    const m = new FakeMaestro();
    const onExit = vi.fn();
    const { stdin, unmount } = renderChat(m, { onRequestExit: onExit });
    await flush();
    stdin.write('/quit');
    await flush();
    stdin.write(ENTER);
    // Synchronously after the keystroke: NOT yet called (deferred via
    // setImmediate in ChatPanel.handleSubmit).
    expect(onExit).not.toHaveBeenCalled();
    await flush();
    expect(onExit).toHaveBeenCalledOnce();
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
