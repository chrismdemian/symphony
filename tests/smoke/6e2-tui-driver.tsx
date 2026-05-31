/**
 * Phase 6E.2 PTY smoke driver — renders the full Symphony TUI via `runTui`
 * against a fake Maestro + an always-mode FAKE VoiceController (no Python /
 * mic / SQLite). The stub boots into always-mode "listening" (ambient
 * violet chip); `toggle()` (Ctrl+G) ARMS a summon → the gold `◉ Summoned`
 * chip; a second toggle disarms. Mirrors the 6E.1 driver structure.
 *
 * Run via `node --import tsx tests/smoke/6e2-tui-driver.tsx`.
 */
import { EventEmitter } from 'node:events';
import { runTui } from '../../src/ui/runtime/runTui.js';
import {
  MaestroTurnInFlightError,
  type MaestroEvent,
} from '../../src/orchestrator/maestro/process.js';
import type { MaestroController } from '../../src/ui/data/MaestroEventsProvider.js';
import type { TuiRpc } from '../../src/ui/runtime/rpc.js';
import type {
  VoiceController,
  VoiceSnapshot,
  SendToMaestroFn,
  InjectToInputFn,
} from '../../src/voice/voice-controller.js';

class FakeMaestro implements MaestroController {
  readonly emitter = new EventEmitter();
  sendUserMessage(_text: string): void {
    if (this.emitter.listenerCount('throw') > 0) {
      throw new MaestroTurnInFlightError();
    }
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

/**
 * Always-mode stub. Boots `listening`/`always`/`alwaysActive`. `toggle()`
 * flips the `summoned` flag (Ctrl+G arms/disarms). No bridge, no store —
 * pure snapshot flips so the smoke can assert the chip transition.
 */
class AlwaysVoiceController {
  private snap: VoiceSnapshot = {
    status: 'listening',
    mode: 'always',
    isListening: true,
    summoned: false,
    alwaysActive: true,
  };
  private readonly listeners = new Set<() => void>();

  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  };
  getSnapshot = (): VoiceSnapshot => this.snap;
  setSendToMaestro(_fn: SendToMaestroFn): void {
    /* no-op stub */
  }
  setInjectToInput(_fn: InjectToInputFn): void {
    /* no-op stub */
  }
  setNoticeSink(_fn: (message: string) => void): void {
    /* no-op stub */
  }
  async setMode(_mode: 'summon' | 'always'): Promise<void> {
    /* no-op stub */
  }
  toggle(): void {
    this.snap = { ...this.snap, summoned: !this.snap.summoned };
    for (const l of this.listeners) l();
  }
  async shutdown(): Promise<void> {
    this.snap = { ...this.snap, summoned: false };
    for (const l of this.listeners) l();
  }
}

const fakeMaestro = new FakeMaestro();
const fakeVoice = new AlwaysVoiceController();

const fakeRpc: TuiRpc = {
  call: {
    projects: { list: async () => [], get: async () => null, register: async () => null },
    tasks: {
      list: async () => [],
      get: async () => null,
      create: async () => null,
      update: async () => null,
      graph: async () => ({ nodes: [], edges: [], cycles: [] }),
    },
    workers: {
      list: async () => [],
      get: async () => null,
      kill: async () => ({ killed: false }),
      tail: async () => ({ events: [], total: 0 }),
      diff: async () => null,
    },
    questions: { list: async () => [], get: async () => null, answer: async () => null },
    waves: { list: async () => [], get: async () => null },
    mode: {
      get: async () => ({ mode: 'plan' as const }),
      setModel: async () => ({ modelMode: 'opus' as const, warnings: [] }),
    },
    queue: {
      list: async () => [],
      cancel: async () => ({ cancelled: false, reason: 'not in queue' }),
      reorder: async () => ({ moved: false, reason: 'not in queue' }),
    },
    runtime: {
      setAutonomyTier: async ({ tier }: { tier: 1 | 2 | 3 }) => ({ tier }),
      setAwayMode: async () => undefined,
    },
    notifications: { flushAwayDigest: async () => ({ digest: null }) },
    recovery: {
      report: async () => ({ crashedIds: [], capturedAt: '2026-05-31T00:00:00.000Z' }),
    },
    audit: { list: async () => [], count: async () => 0 },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any,
  subscribe: async () => ({ topic: 'noop', unsubscribe: async () => undefined }),
  close: async () => undefined,
};

const handle = runTui({
  maestro: fakeMaestro,
  rpc: fakeRpc,
  version: '0.0.0-smoke',
  voice: fakeVoice as unknown as VoiceController,
  onRequestExit: () => {
    void handle.unmount().then(() => process.exit(0));
  },
});

if (!handle.active) {
  process.stderr.write('runTui did not activate (stdin or stdout not TTY)\n');
  process.exit(2);
}

await handle.exited;
