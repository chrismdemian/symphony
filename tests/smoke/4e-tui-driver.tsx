/**
 * Phase 4E PTY smoke driver — renders the full Symphony TUI via
 * `runTui` against a fake Maestro + a fake RPC whose `workers.tail`
 * returns THREE `structured_completion` events, each with its own
 * advisory `display` json-render spec. This is the focus-shim
 * multi-instance case in a REAL ConPTY: three `<JsonRenderBlock>`
 * mounted at once, each going through the `<NoopFocusProvider>` stack
 * (zero Ink `useInput` Tab handlers — no rivalry with Symphony's
 * KeybindProvider panel cycle).
 *
 * Run via `node --import tsx tests/smoke/4e-tui-driver.tsx`.
 */
import { EventEmitter } from 'node:events';
import { runTui } from '../../src/ui/runtime/runTui.js';
import {
  MaestroTurnInFlightError,
  type MaestroEvent,
} from '../../src/orchestrator/maestro/process.js';
import type { MaestroController } from '../../src/ui/data/MaestroEventsProvider.js';
import type { TuiRpc } from '../../src/ui/runtime/rpc.js';
import type { StreamEvent } from '../../src/workers/types.js';

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
        const next = await new Promise<MaestroEvent | undefined>((r) =>
          waiters.push(r),
        );
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

const CARD = {
  root: 'c',
  elements: {
    c: { type: 'Card', props: { title: 'Run Summary' }, children: ['h', 't'] },
    h: { type: 'Heading', props: { text: 'auth refactor' } },
    t: { type: 'Text', props: { text: '3 files changed, 142 tests green' } },
  },
};
const TABLE = {
  root: 'tbl',
  elements: {
    tbl: {
      type: 'Table',
      props: {
        columns: [
          { header: 'Suite', key: 'suite' },
          { header: 'Result', key: 'result' },
        ],
        rows: [
          { suite: 'unit', result: '142/142' },
          { suite: 'scenarios', result: '40/40' },
        ],
      },
    },
  },
};

const completion = (
  did: string[],
  display: unknown,
): StreamEvent => ({
  type: 'structured_completion',
  report: {
    did,
    skipped: [],
    blockers: [],
    open_questions: [],
    audit: 'PASS',
    cite: [],
    tests_run: ['pnpm test: PASS'],
    preview_url: null,
    display,
  },
  raw: '{}',
});

const TAIL_EVENTS: StreamEvent[] = [
  completion(['worker A finished'], CARD),
  completion(['worker B finished'], TABLE),
  completion(['worker C finished'], CARD),
];

const WORKER = {
  id: 'wk-smoke-1',
  projectPath: '/p/proj',
  worktreePath: '/p/proj/.symphony/worktrees/wk-smoke-1',
  role: 'implementer' as const,
  featureIntent: 'auth-refactor',
  taskDescription: 'auth refactor',
  autonomyTier: 1 as const,
  dependsOn: [] as string[],
  status: 'completed' as const,
  createdAt: '2026-05-17T00:00:00.000Z',
};

const fakeMaestro = new FakeMaestro();

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
      list: async () => [WORKER],
      get: async () => WORKER,
      kill: async () => ({ killed: false }),
      tail: async () => ({ events: TAIL_EVENTS, total: TAIL_EVENTS.length }),
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
      report: async () => ({ crashedIds: [], capturedAt: '2026-05-17T00:00:00.000Z' }),
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
  onRequestExit: () => {
    void handle.unmount().then(() => process.exit(0));
  },
});

if (!handle.active) {
  process.stderr.write('runTui did not activate (stdin or stdout not TTY)\n');
  process.exit(2);
}

await handle.exited;
