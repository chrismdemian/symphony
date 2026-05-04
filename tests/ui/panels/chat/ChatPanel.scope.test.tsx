import React from 'react';
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { EventEmitter } from 'node:events';
import { ThemeProvider } from '../../../../src/ui/theme/context.js';
import {
  FocusProvider,
  useFocus,
  type FocusState,
} from '../../../../src/ui/focus/focus.js';
import { AppActionsProvider } from '../../../../src/ui/runtime/AppActions.js';
import { ChatPanel } from '../../../../src/ui/panels/chat/ChatPanel.js';
import {
  MaestroEventsProvider,
  type MaestroController,
} from '../../../../src/ui/data/MaestroEventsProvider.js';
import type { MaestroEvent } from '../../../../src/orchestrator/maestro/process.js';

/**
 * Phase 3E regression — `<ChatPanel>` MUST derive `isActive` from
 * `focus.currentScope`, NOT `focus.currentMainKey`. When a popup is on
 * top of chat, `currentMainKey` is still `'chat'`, but the popup owns
 * the active key scope. Without this gate, both InputBars (popup +
 * chat) consume keystrokes in parallel.
 *
 * Test strategy: write a character to stdin while a `'question'` popup
 * is on top; the chat InputBar must NOT show the typed character (the
 * popup-scope handler — registered higher in the dispatcher walk —
 * would otherwise still let the InputBar's own `useInput` listener
 * fire, since `useInput` siblings run in parallel).
 *
 * We intentionally don't mount the popup itself — only its focus state.
 * That keeps the test about the ONE invariant: chat's InputBar is
 * inactive while a popup is on top.
 */

class StubMaestro implements MaestroController {
  readonly emitter = new EventEmitter();
  sendUserMessage(): void {}
  events(): AsyncIterable<MaestroEvent> {
    const queue: MaestroEvent[] = [];
    const iter: AsyncIterableIterator<MaestroEvent> = {
      [Symbol.asyncIterator]() {
        return iter;
      },
      async next() {
        return { value: undefined as never, done: true };
      },
      async return() {
        return { value: undefined as never, done: true };
      },
    };
    void queue; // unused — chat history is empty in this scope test.
    return iter;
  }
}

function flush(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}

const stripAnsi = (s: string): string =>
  // eslint-disable-next-line no-control-regex
  s.replace(/\x1b\[[\d;]*[a-zA-Z]/g, '');

function renderChatWithFocus(initial: FocusState): {
  stdin: { write: (s: string) => void };
  lastFrame: () => string | undefined;
} {
  const m = new StubMaestro();
  return render(
    <ThemeProvider>
      <FocusProvider initial={initial}>
        <AppActionsProvider value={{ onRequestExit: () => {} }}>
          <MaestroEventsProvider source={m} now={() => 0}>
            <ChatPanel />
          </MaestroEventsProvider>
        </AppActionsProvider>
      </FocusProvider>
    </ThemeProvider>,
  ) as unknown as {
    stdin: { write: (s: string) => void };
    lastFrame: () => string | undefined;
  };
}

describe('ChatPanel — currentScope (Phase 3E regression)', () => {
  it('typed characters land in the InputBar when chat is the active scope', async () => {
    const { stdin, lastFrame } = renderChatWithFocus({
      stack: [{ kind: 'main', key: 'chat' }],
    });
    await flush();
    stdin.write('hello');
    await flush();
    expect(stripAnsi(lastFrame() ?? '')).toContain('hello');
  });

  it('typed characters do NOT land in the InputBar while a popup is on top', async () => {
    const { stdin, lastFrame } = renderChatWithFocus({
      stack: [
        { kind: 'main', key: 'chat' },
        { kind: 'popup', key: 'question' },
      ],
    });
    await flush();
    stdin.write('hello');
    await flush();
    const frame = stripAnsi(lastFrame() ?? '');
    expect(frame).not.toContain('hello');
    // The placeholder still renders (no buffer text was inserted).
    expect(frame).toContain('Tell Maestro what to do');
  });

  it('switching from chat-focus to a popup blurs the InputBar mid-session', async () => {
    function Toggler({ openPopup }: { readonly openPopup: boolean }): React.JSX.Element {
      const focus = useFocus();
      React.useEffect(() => {
        if (openPopup && focus.state.stack.length === 1) {
          focus.pushPopup('question');
        }
      }, [openPopup, focus]);
      return <ChatPanel />;
    }
    const m = new StubMaestro();
    const { stdin, lastFrame, rerender } = render(
      <ThemeProvider>
        <FocusProvider>
          <AppActionsProvider value={{ onRequestExit: () => {} }}>
            <MaestroEventsProvider source={m} now={() => 0}>
              <Toggler openPopup={false} />
            </MaestroEventsProvider>
          </AppActionsProvider>
        </FocusProvider>
      </ThemeProvider>,
    );
    await flush();
    stdin.write('abc');
    await flush();
    expect(stripAnsi(lastFrame() ?? '')).toContain('abc');
    rerender(
      <ThemeProvider>
        <FocusProvider>
          <AppActionsProvider value={{ onRequestExit: () => {} }}>
            <MaestroEventsProvider source={m} now={() => 0}>
              <Toggler openPopup={true} />
            </MaestroEventsProvider>
          </AppActionsProvider>
        </FocusProvider>
      </ThemeProvider>,
    );
    await flush();
    stdin.write('def');
    await flush();
    // Popup grabbed scope; the new keystrokes must NOT appear in the
    // chat input.
    const frame = stripAnsi(lastFrame() ?? '');
    expect(frame).not.toContain('abcdef');
  });
});
