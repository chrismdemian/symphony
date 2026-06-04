/**
 * Phase 7C PTY smoke driver — boots the full Symphony TUI inside a real
 * ConPTY (via the parent harness) with a fake Maestro + a STATEFUL fake
 * RPC whose `plugins.*` procedures back an in-memory list, so the smoke
 * can drive `/plugins`, toggle a row (and see the glyph flip), and open
 * the install input.
 *
 * Run via `node --import tsx tests/smoke/7c-tui-driver.tsx`.
 */
import { EventEmitter } from 'node:events';
import { runTui } from '../../src/ui/runtime/runTui.js';
import { type MaestroEvent } from '../../src/orchestrator/maestro/process.js';
import type { MaestroController } from '../../src/ui/data/MaestroEventsProvider.js';
import type { TuiRpc } from '../../src/ui/runtime/rpc.js';
import type { PluginListItem } from '../../src/rpc/router-impl.js';

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

const ISO = '2026-06-03T12:00:00.000Z';
let plugins: PluginListItem[] = [
  {
    id: 'notifier-example',
    name: 'Notifier',
    version: '0.1.0',
    enabled: true,
    source: 'npm:@symphony/notifier',
    installedAt: ISO,
    permissions: ['notify:send'],
    capabilityFlags: [],
  },
  {
    id: 'echo',
    name: 'Echo',
    version: '1.0.0',
    enabled: false,
    source: '/repos/echo',
    installedAt: ISO,
    permissions: ['task:read'],
    capabilityFlags: ['irreversible'],
  },
];

const fakeMaestro = new FakeMaestro();

const fakeRpc: TuiRpc = {
  call: {
    projects: {
      list: async () => [{ id: 'p1', name: 'MathScrabble', path: '/repos/ms', createdAt: ISO }],
      get: async () => null,
      register: async () => null,
    },
    tasks: { list: async () => [], get: async () => null, create: async () => null, update: async () => null, graph: async () => ({ nodes: [], edges: [], cycles: [] }) },
    workers: {
      list: async () => [],
      get: async () => null,
      kill: async () => ({ killed: false }),
      tail: async () => ({ events: [], total: 0 }),
      diff: async () => null,
    },
    questions: { list: async () => [], get: async () => null, answer: async () => null },
    waves: { list: async () => [], get: async () => null },
    mode: { get: async () => ({ mode: 'plan' as const }), setModel: async () => ({ modelMode: 'opus' as const, warnings: [] }) },
    queue: {
      list: async () => [],
      cancel: async () => ({ cancelled: false, reason: 'not in queue' }),
      reorder: async () => ({ moved: false, reason: 'not in queue' }),
    },
    runtime: { setAutonomyTier: async ({ tier }: { tier: 1 | 2 | 3 }) => ({ tier }), setAwayMode: async () => undefined },
    notifications: { flushAwayDigest: async () => ({ digest: null }) },
    recovery: { report: async () => ({ crashedIds: [], capturedAt: ISO }) },
    audit: { list: async () => [], count: async () => 0 },
    plugins: {
      list: async () => plugins.map((p) => ({ ...p })),
      setEnabled: async ({ id, enabled }: { id: string; enabled: boolean }) => {
        plugins = plugins.map((p) => (p.id === id ? { ...p, enabled } : p));
        return { id, enabled };
      },
      install: async () => ({ id: 'x', name: 'X', version: '1', reinstall: false }),
      remove: async ({ id }: { id: string }) => {
        plugins = plugins.filter((p) => p.id !== id);
        return { id, removedRow: true, removedDir: true };
      },
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
