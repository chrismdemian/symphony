import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { App } from '../../src/ui/App.js';
import type { MaestroSource } from '../../src/ui/data/useMaestroEvents.js';
import type { TuiRpc } from '../../src/ui/runtime/rpc.js';

class FakeMaestro implements MaestroSource {
  events(): AsyncIterable<never> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const empty: any = {
      [Symbol.asyncIterator]() {
        return {
          next: async () => ({ done: true, value: undefined }),
        };
      },
    };
    return empty;
  }
  sendUserMessage(_text: string): void {
    // 3B.1: Layout test doesn't exercise the chat send path.
  }
}

function makeFakeRpc(): TuiRpc {
  return {
    call: {
      projects: {
        list: async () => [],
        get: async () => null,
        register: async () => {
          throw new Error('unused in test');
        },
      },
      tasks: {
        list: async () => [],
        get: async () => null,
        create: async () => {
          throw new Error('unused');
        },
        update: async () => {
          throw new Error('unused');
        },
      },
      workers: {
        list: async () => [],
        get: async () => null,
        kill: async () => ({ killed: false }),
      },
      questions: {
        list: async () => [],
        get: async () => null,
        answer: async () => {
          throw new Error('unused');
        },
      },
      waves: {
        list: async () => [],
        get: async () => null,
      },
      mode: {
        get: async () => ({ mode: 'plan' as const }),
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    subscribe: async () => ({
      topic: 'noop',
      unsubscribe: async () => {},
    }),
    close: async () => {},
  };
}

let originalColumns: number | undefined;
let originalRows: number | undefined;

beforeEach(() => {
  originalColumns = process.stdout.columns;
  originalRows = process.stdout.rows;
});

afterEach(() => {
  if (originalColumns !== undefined) {
    Object.defineProperty(process.stdout, 'columns', { value: originalColumns, configurable: true });
  }
  if (originalRows !== undefined) {
    Object.defineProperty(process.stdout, 'rows', { value: originalRows, configurable: true });
  }
});

describe('<App> Layout', () => {
  it('renders all three panels — chat is live (3B.1) + worker/output placeholders (3C/3D)', async () => {
    Object.defineProperty(process.stdout, 'columns', { value: 140, configurable: true });
    Object.defineProperty(process.stdout, 'rows', { value: 40, configurable: true });
    const { lastFrame, unmount } = render(
      <App
        maestro={new FakeMaestro()}
        rpc={makeFakeRpc()}
        version="0.0.0"
        onRequestExit={() => {}}
      />,
    );
    // Allow data hooks (microtasks) to settle.
    await new Promise((r) => setImmediate(r));
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Chat');
    expect(frame).toContain('Workers');
    expect(frame).toContain('Output');
    // 3B.1 replaced the chat placeholder with the real panel — empty
    // history shows only the input bar's "Tell Maestro what to do…"
    // placeholder (no MessageList hint — visual review concluded the
    // duplicate hint leaked when the user was mid-type).
    expect(frame).toContain('Tell Maestro what to do');
    // Worker + output panels still show their 3A placeholders.
    expect(frame).toContain('Phase 3C');
    expect(frame).toContain('Phase 3D');
    unmount();
  });

  it('renders the status bar with Symphony brand', async () => {
    Object.defineProperty(process.stdout, 'columns', { value: 140, configurable: true });
    Object.defineProperty(process.stdout, 'rows', { value: 40, configurable: true });
    const { lastFrame, unmount } = render(
      <App
        maestro={new FakeMaestro()}
        rpc={makeFakeRpc()}
        version="0.0.0"
        onRequestExit={() => {}}
      />,
    );
    await new Promise((r) => setImmediate(r));
    expect(lastFrame() ?? '').toContain('Symphony');
    unmount();
  });

  it('renders the Tab keybind hint in the bottom bar', async () => {
    Object.defineProperty(process.stdout, 'columns', { value: 140, configurable: true });
    Object.defineProperty(process.stdout, 'rows', { value: 40, configurable: true });
    const { lastFrame, unmount } = render(
      <App
        maestro={new FakeMaestro()}
        rpc={makeFakeRpc()}
        version="0.0.0"
        onRequestExit={() => {}}
      />,
    );
    await new Promise((r) => setImmediate(r));
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Tab');
    expect(frame).toContain('next panel');
    expect(frame).toContain('Ctrl+C');
    expect(frame).toContain('exit');
    unmount();
  });

  it('does not crash with cols=80 (narrow layout path)', async () => {
    Object.defineProperty(process.stdout, 'columns', { value: 80, configurable: true });
    Object.defineProperty(process.stdout, 'rows', { value: 30, configurable: true });
    const { lastFrame, unmount } = render(
      <App
        maestro={new FakeMaestro()}
        rpc={makeFakeRpc()}
        version="0.0.0"
        onRequestExit={() => {}}
      />,
    );
    await new Promise((r) => setImmediate(r));
    const frame = lastFrame() ?? '';
    // All three panels still rendered, just stacked.
    expect(frame).toContain('Chat');
    expect(frame).toContain('Workers');
    expect(frame).toContain('Output');
    unmount();
  });
});
