/**
 * Phase 3S PTY smoke driver — boots the full Symphony TUI inside a
 * real ConPTY (via the parent harness), renders against a fake Maestro
 * + fake RPC, and exposes the autonomy-tier dial for keystroke driving.
 *
 * Run via `node --import tsx tests/smoke/3s-tui-driver.tsx`.
 */
import { EventEmitter } from 'node:events';
import { runTui } from '../../src/ui/runtime/runTui.js';
import { type MaestroEvent } from '../../src/orchestrator/maestro/process.js';
import type { MaestroController } from '../../src/ui/data/MaestroEventsProvider.js';
import type { TuiRpc } from '../../src/ui/runtime/rpc.js';

class FakeMaestro implements MaestroController {
  readonly emitter = new EventEmitter();
  sendUserMessage(_text: string): void {}
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
        return { value: undefined as never, done: true };
      },
    };
    return iter;
  }
}

const fakeMaestro = new FakeMaestro();

const fakeRpc: TuiRpc = {
  call: {
    projects: { list: async () => [], get: async () => null, register: async () => null },
    tasks: { list: async () => [], get: async () => null, create: async () => null, update: async () => null, graph: async () => ({ nodes: [], edges: [], cycles: [] }) },
    workers: {
      list: async () => [],
      get: async () => null,
      kill: async () => ({ killed: false }),
      tail: async () => ({ events: [], total: 0 }),
      diff: async () => null,
      sendTo: async ({ workerId, message }: { workerId: string; message: string }) => ({ workerId, bytes: message.length }),
    },
    questions: { list: async () => [], get: async () => null, answer: async () => null },
    waves: { list: async () => [], get: async () => null },
    mode: { get: async () => ({ mode: 'plan' as const }), setModel: async () => ({ modelMode: 'opus' as const, warnings: [] }) },
    queue: {
      list: async () => [],
      cancel: async () => ({ cancelled: false, reason: 'not in queue' }),
      reorder: async () => ({ moved: false, reason: 'not in queue' }),
    },
    // Phase 3S — runtime.setAutonomyTier is fired by AppShell's useEffect
    // whenever config.autonomyTier changes (i.e. after Ctrl+Y).
    runtime: {
      setAutonomyTier: async ({ tier }: { tier: 1 | 2 | 3 }) => ({ tier }),
      setAwayMode: async () => undefined,
    },
    notifications: {
      flushAwayDigest: async () => ({ digest: null }),
    },
    recovery: {
      report: async () => ({ crashedIds: [], capturedAt: '2026-05-14T12:00:00.000Z' }),
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any,
  subscribe: async () => ({ topic: 'noop', unsubscribe: async () => undefined }),
  close: async () => undefined,
};

const handle = runTui({
  maestro: fakeMaestro,
  rpc: fakeRpc,
  version: '0.0.0-smoke',
  onRequestExit: () => {
    void handle.unmount().then(() => process.exit(0));
  },
});

if (!handle.active) {
  process.stderr.write('runTui did not activate (stdin or stdout not TTY)\n');
  process.exit(2);
}

await handle.exited;
