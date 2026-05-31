/**
 * Phase 6E.1 PTY smoke driver — renders the full Symphony TUI via
 * `runTui` against a fake Maestro + a STUB VoiceController (no real
 * Python / mic / SQLite). The stub mirrors the real controller's
 * `subscribe`/`getSnapshot`/`toggle`/`setSendToMaestro`/`setInjectToInput`/
 * `shutdown` surface and flips its snapshot synchronously on `toggle()`
 * so the smoke can drive `Ctrl+G` and observe the listening indicator
 * transition in a REAL ConPTY.
 *
 * Run via `node --import tsx tests/smoke/6e1-tui-driver.tsx`.
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
 * Stub VoiceController — NO real bridge. `toggle()` flips off ↔ listening
 * synchronously so the smoke can assert the chip transition on `Ctrl+G`
 * without a venv. This deliberately bypasses `startSession` (which would
 * spawn Python). If a future smoke wants the real controller, gate it on
 * a venv probe — for the chip-toggle assertion, the stub is sufficient.
 */
class StubVoiceController {
  private snap: VoiceSnapshot = { status: 'off', mode: 'summon', isListening: false };
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
  toggle(): void {
    this.snap =
      this.snap.status === 'off'
        ? { status: 'listening', mode: 'summon', isListening: true }
        : { status: 'off', mode: 'summon', isListening: false };
    for (const l of this.listeners) l();
  }
  async shutdown(): Promise<void> {
    this.snap = { status: 'off', mode: 'summon', isListening: false };
    for (const l of this.listeners) l();
  }
}

const fakeMaestro = new FakeMaestro();
const fakeVoice = new StubVoiceController();

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
      report: async () => ({ crashedIds: [], capturedAt: '2026-05-30T00:00:00.000Z' }),
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
