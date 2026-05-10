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
      queue: {
        list: async () => [],
        cancel: async () => ({ cancelled: false, reason: 'not in queue' }),
        reorder: async () => ({ moved: false, reason: 'not in queue' }),
      },
      notifications: {
        flushAwayDigest: async () => {},
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
  it('renders all three panels — chat live (3B.1), workers live (3C), output placeholder (3D)', async () => {
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
    expect(frame).toContain('Tell Maestro what to do');
    // 3C: empty workers panel renders the empty-state hint.
    expect(frame).toContain('no workers');
    // 3D.1: output panel renders the no-selection hint when no worker
    // is selected (default state with empty workers list).
    expect(frame).toContain('Select a worker');
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
