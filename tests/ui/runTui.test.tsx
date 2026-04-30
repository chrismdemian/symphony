import { describe, it, expect } from 'vitest';
import { runTui } from '../../src/ui/runtime/runTui.js';
import type { MaestroSource } from '../../src/ui/data/useMaestroEvents.js';
import type { TuiRpc } from '../../src/ui/runtime/rpc.js';

class FakeMaestro implements MaestroSource {
  events(): AsyncIterable<never> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const it: any = {
      [Symbol.asyncIterator]() {
        return {
          next: async () => ({ done: true, value: undefined }),
        };
      },
    };
    return it;
  }
  sendUserMessage(_text: string): void {
    // runTui smoke tests don't exercise the chat send path.
  }
}

function makeFakeRpc(): TuiRpc {
  return {
    call: {
      projects: { list: async () => [], get: async () => null, register: async () => null },
      tasks: { list: async () => [], get: async () => null, create: async () => null, update: async () => null },
      workers: { list: async () => [], get: async () => null, kill: async () => ({ killed: false }) },
      questions: { list: async () => [], get: async () => null, answer: async () => null },
      waves: { list: async () => [], get: async () => null },
      mode: { get: async () => ({ mode: 'plan' as const }) },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    subscribe: async () => ({ topic: 'noop', unsubscribe: async () => {} }),
    close: async () => {},
  };
}

function makeFakeStdout(isTty: boolean): NodeJS.WriteStream {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const out: any = {
    isTTY: isTty,
    columns: 120,
    rows: 30,
    write: () => true,
    on: () => out,
    off: () => out,
    once: () => out,
    emit: () => false,
    addListener: () => out,
    removeListener: () => out,
    end: () => out,
    cork: () => {},
    uncork: () => {},
  };
  return out as NodeJS.WriteStream;
}

function makeFakeStdin(): NodeJS.ReadStream {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stdin: any = {
    isTTY: true,
    setEncoding: () => stdin,
    setRawMode: () => stdin,
    resume: () => stdin,
    pause: () => stdin,
    on: () => stdin,
    off: () => stdin,
    once: () => stdin,
    emit: () => false,
    addListener: () => stdin,
    removeListener: () => stdin,
    read: () => null,
    ref: () => stdin,
    unref: () => stdin,
  };
  return stdin as NodeJS.ReadStream;
}

function makeNonTtyStdin(): NodeJS.ReadStream {
  const stdin = makeFakeStdin();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (stdin as any).isTTY = false;
  return stdin;
}

describe('runTui', () => {
  it('returns a no-op handle when stdout is not a TTY', () => {
    const handle = runTui({
      maestro: new FakeMaestro(),
      rpc: makeFakeRpc(),
      version: '0.0.0',
      onRequestExit: () => {},
      stdin: makeFakeStdin(),
      stdout: makeFakeStdout(false),
    });
    expect(handle.active).toBe(false);
  });

  it('returns a no-op handle when stdin is not a TTY (audit C1)', () => {
    // `echo hi | symphony start` — stdout TTY but stdin is piped.
    // Without this guard, Ink would crash at `setRawMode`.
    const handle = runTui({
      maestro: new FakeMaestro(),
      rpc: makeFakeRpc(),
      version: '0.0.0',
      onRequestExit: () => {},
      stdin: makeNonTtyStdin(),
      stdout: makeFakeStdout(true),
    });
    expect(handle.active).toBe(false);
  });

  it('returns an active handle when stdout is a TTY', async () => {
    const handle = runTui({
      maestro: new FakeMaestro(),
      rpc: makeFakeRpc(),
      version: '0.0.0',
      onRequestExit: () => {},
      stdin: makeFakeStdin(),
      stdout: makeFakeStdout(true),
    });
    expect(handle.active).toBe(true);
    await handle.unmount();
    await handle.exited;
  });

  it('unmount is idempotent', async () => {
    const handle = runTui({
      maestro: new FakeMaestro(),
      rpc: makeFakeRpc(),
      version: '0.0.0',
      onRequestExit: () => {},
      stdin: makeFakeStdin(),
      stdout: makeFakeStdout(true),
    });
    await handle.unmount();
    await handle.unmount(); // should not throw
    await handle.exited;
  });

  it('exited resolves after unmount', async () => {
    const handle = runTui({
      maestro: new FakeMaestro(),
      rpc: makeFakeRpc(),
      version: '0.0.0',
      onRequestExit: () => {},
      stdin: makeFakeStdin(),
      stdout: makeFakeStdout(true),
    });
    let resolved = false;
    void handle.exited.then(() => {
      resolved = true;
    });
    await handle.unmount();
    await handle.exited;
    expect(resolved).toBe(true);
  });
});
