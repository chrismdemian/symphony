/**
 * Phase 6E.3 PTY smoke driver — renders the full Symphony TUI via `runTui`
 * with the settings popup pre-opened (`initialPopup: 'settings'`) and a
 * RECORDING fake VoiceController. Drives the real `<SettingsPanel>` Voice
 * section + threshold sliders in a real ConPTY.
 *
 * The fake controller records every `setVadThreshold` / `setWakeThreshold`
 * call (the App.tsx config→controller hot-apply effect target) and, AFTER
 * unmount on exit, prints them as a `__VAD_CALLS__:[...]` marker to stdout so
 * the smoke can assert the end-to-end keystroke → effect → controller path
 * from the post-exit transcript tail.
 *
 * Run via `node --import tsx tests/smoke/6e3-tui-driver.tsx`.
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
 * Recording stub. The App's config→controller effects call setVadThreshold /
 * setWakeThreshold on a real config change; we record the values so the smoke
 * can prove the hot-apply wiring end-to-end. Snapshot is inert (summon/off) —
 * the settings popup doesn't depend on voice status.
 */
class RecordingVoiceController {
  readonly vadCalls: number[] = [];
  readonly wakeCalls: number[] = [];
  private readonly snap: VoiceSnapshot = {
    status: 'off',
    mode: 'summon',
    isListening: false,
    summoned: false,
    alwaysActive: false,
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
  async setVadThreshold(value: number): Promise<void> {
    this.vadCalls.push(value);
  }
  async setWakeThreshold(value: number): Promise<void> {
    this.wakeCalls.push(value);
  }
  toggle(): void {
    /* no-op stub */
  }
  async shutdown(): Promise<void> {
    /* no-op stub */
  }
}

const fakeMaestro = new FakeMaestro();
const fakeVoice = new RecordingVoiceController();

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
      report: async () => ({ crashedIds: [], capturedAt: '2026-06-02T00:00:00.000Z' }),
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
  initialPopup: 'settings',
  onRequestExit: () => {
    void handle.unmount().then(() => {
      // Post-unmount (alt-screen restored) — emit the recorded hot-apply
      // calls so the smoke can assert the keystroke → effect → controller path.
      process.stdout.write(`__VAD_CALLS__:${JSON.stringify(fakeVoice.vadCalls)}\n`);
      process.exit(0);
    });
  },
});

if (!handle.active) {
  process.stderr.write('runTui did not activate (stdin or stdout not TTY)\n');
  process.exit(2);
}

await handle.exited;
