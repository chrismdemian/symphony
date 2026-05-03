/**
 * 3B.3 PTY smoke driver — spawns inside a real ConPTY (via the parent
 * harness), renders the full Symphony TUI via `runTui` against a fake
 * Maestro + fake RPC, and emits a scripted event sequence so the
 * status line is visible during the test window.
 *
 * Run via `node --import tsx tests/smoke/3b3-tui-driver.tsx`.
 */
import { EventEmitter } from 'node:events';
import { runTui } from '../../src/ui/runtime/runTui.js';
import {
  MaestroTurnInFlightError,
  type MaestroEvent,
} from '../../src/orchestrator/maestro/process.js';
import type { MaestroController } from '../../src/ui/data/MaestroEventsProvider.js';
import type { TuiRpc } from '../../src/ui/runtime/rpc.js';

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
  emit(e: MaestroEvent): void {
    this.emitter.emit('event', e);
  }
}

const fakeMaestro = new FakeMaestro();

const fakeRpc: TuiRpc = {
  call: {
    projects: { list: async () => [], get: async () => null, register: async () => null },
    tasks: { list: async () => [], get: async () => null, create: async () => null, update: async () => null },
    workers: { list: async () => [], get: async () => null, kill: async () => ({ killed: false }) },
    questions: { list: async () => [], get: async () => null, answer: async () => null },
    waves: { list: async () => [], get: async () => null },
    mode: { get: async () => ({ mode: 'plan' as const }) },
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

// Scripted event sequence: a turn that fires a tool, holds, then completes.
// Spread out over ~6 seconds so the parent harness can observe each phase.
async function script(): Promise<void> {
  await wait(1500);
  fakeMaestro.emit({ type: 'turn_started' });
  await wait(300);
  fakeMaestro.emit({
    type: 'tool_use',
    callId: 'c1',
    name: 'list_workers',
    input: {},
  });
  // Hold for ~3s so the parent harness can sample the in-flight status line
  // multiple times across animation ticks.
  await wait(3000);
  fakeMaestro.emit({
    type: 'tool_result',
    callId: 'c1',
    content: 'no workers',
    isError: false,
  });
  await wait(200);
  fakeMaestro.emit({ type: 'turn_completed', isError: false, resultText: '' });
}

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

void script().catch((err) => {
  process.stderr.write(`script error: ${err instanceof Error ? err.stack : String(err)}\n`);
});

await handle.exited;
