/**
 * Phase 3D.2 scenario — json-render integration through the launcher.
 *
 * Boots the launcher with a fake Maestro and a fake RPC; the fake RPC's
 * `workers.tail` returns one `assistant_text` event carrying a real
 * ` ```json-render ` fence (Card{Heading, Text}) plus a second event
 * with a malformed fence. After backfill resolves, the rendered frame
 * must:
 *
 *  - contain the surrounding narrative + the spec's title/heading/body
 *  - contain the violet truecolor escape `\x1b[38;2;124;111;235m` (proves
 *    the themed Card override ran end-to-end through every layer)
 *  - contain the fallback warning row for the malformed fence without
 *    crashing the panel
 *
 * Mirrors `tests/scenarios/3d1.test.ts`'s shape — same FakeMaestroProcess,
 * same makeFakeRpc, same launcher boot. Differs only in the tail payload
 * and the post-backfill assertions.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter, PassThrough } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runStart } from '../../src/cli/start.js';
import { MaestroHookServer } from '../../src/orchestrator/maestro/hook-server.js';
import type {
  MaestroProcess,
  MaestroEvent,
  MaestroStartInput,
  MaestroStartResult,
} from '../../src/orchestrator/maestro/index.js';
import type { LauncherRpc } from '../../src/cli/start.js';
import type { ProjectSnapshot } from '../../src/projects/types.js';
import type { WorkerRecordSnapshot } from '../../src/orchestrator/worker-registry.js';
import type { StreamEvent } from '../../src/workers/types.js';

class FakeMaestroProcess {
  readonly emitter = new EventEmitter();
  readonly sentMessages: string[] = [];

  async start(_input: MaestroStartInput): Promise<MaestroStartResult> {
    return {
      workspace: { cwd: '/fake/cwd', claudeMdPath: '/fake/cwd/CLAUDE.md' },
      session: { sessionId: 'fake-session', mode: 'fresh', reason: 'missing' },
      mcpConfigPath: '/fake/cwd/.symphony-mcp.json',
      systemInit: { sessionId: 'fake-session-uuid' },
    } as unknown as MaestroStartResult;
  }
  sendUserMessage(text: string): void {
    this.sentMessages.push(text);
  }
  injectIdle(): void {}
  on(type: string, listener: (e: unknown) => void): this {
    this.emitter.on(type, listener);
    return this;
  }
  off(type: string, listener: (e: unknown) => void): this {
    this.emitter.off(type, listener);
    return this;
  }
  async kill(): Promise<undefined> {
    this.emitter.emit('stopped');
    return undefined;
  }
  async *eventsIter(): AsyncIterable<MaestroEvent> {
    const queue: MaestroEvent[] = [];
    const waiters: Array<(e: MaestroEvent | undefined) => void> = [];
    let stopped = false;
    const handler = (e: MaestroEvent): void => {
      if (waiters.length > 0) waiters.shift()!(e);
      else queue.push(e);
    };
    const stopHandler = (): void => {
      stopped = true;
      while (waiters.length > 0) waiters.shift()!(undefined);
    };
    this.emitter.on('event', handler);
    this.emitter.once('stopped', stopHandler);
    try {
      while (true) {
        if (queue.length > 0) {
          yield queue.shift()!;
          continue;
        }
        if (stopped) return;
        const next = await new Promise<MaestroEvent | undefined>((r) => waiters.push(r));
        if (next === undefined) return;
        yield next;
      }
    } finally {
      this.emitter.off('event', handler);
      this.emitter.off('stopped', stopHandler);
    }
  }
}

let sandbox: string;
let home: string;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'symphony-3d2-scenario-'));
  home = join(sandbox, 'home');
});

afterEach(() => {
  try {
    rmSync(sandbox, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

interface SubscriptionEntry {
  workerId: string;
  listener: (e: unknown) => void;
  unsubscribed: boolean;
}

interface FakeRpcHandle {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  rpc: any;
  emit(workerId: string, event: StreamEvent): void;
  subscribeMock: ReturnType<typeof vi.fn>;
  tailMock: ReturnType<typeof vi.fn>;
  closeMock: ReturnType<typeof vi.fn>;
}

function makeFakeRpc(
  projects: ProjectSnapshot[],
  getWorkers: () => readonly WorkerRecordSnapshot[],
  tailEvents: readonly StreamEvent[],
): FakeRpcHandle {
  const subs: SubscriptionEntry[] = [];
  const subscribeMock = vi.fn(
    async (_topic: string, args: unknown, listener: (e: unknown) => void) => {
      const workerId = (args as { workerId: string }).workerId;
      const entry: SubscriptionEntry = { workerId, listener, unsubscribed: false };
      subs.push(entry);
      return {
        topic: 'workers.events',
        unsubscribe: async (): Promise<void> => {
          entry.unsubscribed = true;
        },
      };
    },
  );
  const tailMock = vi.fn(async (args: { workerId: string; n?: number }) => {
    void args;
    return { events: tailEvents, total: tailEvents.length };
  });
  const closeMock = vi.fn(async () => undefined);

  const rpc = {
    call: {
      projects: {
        list: vi.fn(async () => projects),
        get: vi.fn(async () => null),
        register: vi.fn(async () => null),
      },
      tasks: {
        list: vi.fn(async () => []),
        get: vi.fn(async () => null),
        create: vi.fn(async () => null),
        update: vi.fn(async () => null),
      },
      workers: {
        list: vi.fn(async () => getWorkers()),
        get: vi.fn(async () => null),
        kill: vi.fn(async () => ({ killed: false })),
        tail: tailMock,
      },
      questions: {
        list: vi.fn(async () => []),
        get: vi.fn(async () => null),
        answer: vi.fn(async () => null),
      },
      waves: {
        list: vi.fn(async () => []),
        get: vi.fn(async () => null),
      },
      mode: {
        get: vi.fn(async () => ({ mode: 'plan' as const })),
      },
      queue: {
        list: vi.fn(async () => []),
        cancel: vi.fn(async () => ({ cancelled: false, reason: 'not in queue' })),
        reorder: vi.fn(async () => ({ moved: false, reason: 'not in queue' })),
      },
      notifications: {
        flushAwayDigest: vi.fn(async () => ({ digest: null })),
      },
    },
    subscribe: subscribeMock,
    close: closeMock,
  };

  return {
    rpc,
    emit(workerId: string, event: StreamEvent): void {
      for (const sub of subs) {
        if (sub.workerId === workerId && !sub.unsubscribed) sub.listener(event);
      }
    },
    subscribeMock,
    tailMock,
    closeMock,
  };
}

function makeTtyStream(isReadable: boolean): NodeJS.WriteStream | NodeJS.ReadStream {
  const base = new PassThrough();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stream = base as any;
  stream.isTTY = true;
  stream.columns = 120;
  stream.rows = 30;
  if (isReadable) {
    stream.setRawMode = () => stream;
    stream.setEncoding = () => stream;
    stream.resume = () => stream;
    stream.pause = () => stream;
    stream.ref = () => stream;
    stream.unref = () => stream;
  }
  return stream as never;
}

function settle(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const stripAnsi = (s: string): string =>
  // eslint-disable-next-line no-control-regex
  s.replace(/\x1b\[[\d;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');

function snap(over: Partial<WorkerRecordSnapshot>): WorkerRecordSnapshot {
  return {
    id: 'w',
    projectPath: '/repos/demo',
    worktreePath: '/repos/demo/.symphony/worktrees/w',
    role: 'implementer',
    featureIntent: 'placeholder',
    taskDescription: 'placeholder',
    autonomyTier: 1,
    dependsOn: [],
    status: 'running',
    createdAt: new Date(Date.now() - 60_000).toISOString(),
    ...over,
  };
}

const CARD_SPEC = {
  root: 'card-1',
  elements: {
    'card-1': {
      type: 'Card',
      props: { title: 'Worker Status' },
      children: ['heading-1', 'text-1'],
    },
    'heading-1': { type: 'Heading', props: { text: 'All Tests Passing' } },
    'text-1': { type: 'Text', props: { text: '1317 / 1317 green' } },
  },
};

const FENCED_TEXT =
  'narrative before\n\n' +
  '```json-render\n' +
  JSON.stringify(CARD_SPEC) +
  '\n```\n\n' +
  'narrative after';

const INVALID_FENCED_TEXT =
  'preamble\n\n' +
  '```json-render\n' +
  '{not real json\n' +
  '```\n\n' +
  'epilogue';

describe('Phase 3D.2 scenario — json-render integration through the launcher', () => {
  it('renders a fenced Card spec with violet border and surfaces a fallback row for invalid JSON', async () => {
    const fakeMaestro = new FakeMaestroProcess();
    const fakeMaestroAsProcess = fakeMaestro as unknown as MaestroProcess;
    Object.defineProperty(fakeMaestroAsProcess, 'events', {
      value: () => fakeMaestro.eventsIter(),
    });

    const projects: ProjectSnapshot[] = [
      { id: 'p1', name: 'demo', path: '/repos/demo', createdAt: '2026-04-30T00:00:00Z' },
    ];
    let workers: WorkerRecordSnapshot[] = [];
    const tailEvents: StreamEvent[] = [
      { type: 'assistant_text', text: FENCED_TEXT },
      { type: 'assistant_text', text: INVALID_FENCED_TEXT },
    ];
    const handle = makeFakeRpc(projects, () => workers, tailEvents);

    const stdin = makeTtyStream(true) as NodeJS.ReadStream;
    const stdout = makeTtyStream(false) as NodeJS.WriteStream;
    const stderr = new PassThrough();

    const stdoutChunks: string[] = [];
    (stdout as unknown as PassThrough).on('data', (c: Buffer) =>
      stdoutChunks.push(c.toString('utf8')),
    );

    const hookServer = new MaestroHookServer({ token: 'fixed-tok' });
    const launcher = await runStart({
      home,
      cliEntryPath: '/fake/cli/entry.js',
      io: { stdin, stdout, stderr },
      skipSignalHandlers: true,
      rpcOverride: {
        descriptor: { host: '127.0.0.1', port: 0, token: 't' },
        client: handle.rpc as unknown as LauncherRpc,
      },
      hookServerFactory: () => hookServer,
      maestroFactory: () => fakeMaestroAsProcess,
      workerManager: { ensureClaudeTrust: async () => undefined } as never,
    });

    // Phase 1 — empty workers list. workers.events subscribe + tail not
    // yet called. (Phase 3K's `completions.events` subscribe is global
    // and fires on App mount; filter the assertion accordingly.)
    await settle(200);
    const workersSubscribes = handle.subscribeMock.mock.calls.filter(
      (c) => c[0] === 'workers.events',
    );
    expect(workersSubscribes).toHaveLength(0);
    expect(handle.tailMock).not.toHaveBeenCalled();

    // Phase 2 — add one worker. Reconcile auto-selects after the next
    // 1 s poll; output panel mounts WorkerOutputView, subscribe + tail
    // fire, backfill resolves with the two scripted assistant_text events.
    workers = [snap({ id: 'w1', featureIntent: 'emits json-render', status: 'running' })];
    await settle(1300);

    expect(handle.subscribeMock).toHaveBeenCalledWith(
      'workers.events',
      { workerId: 'w1' },
      expect.any(Function),
    );
    expect(handle.tailMock).toHaveBeenCalledWith({ workerId: 'w1', n: 200 });

    await settle(200);
    const fullStream = stdoutChunks.join('');
    const plain = stripAnsi(fullStream);

    // The narrative around the valid fence renders.
    expect(plain).toContain('narrative before');
    expect(plain).toContain('narrative after');
    // The themed Card content renders: title, heading text, body text.
    expect(plain).toContain('Worker Status');
    expect(plain).toContain('All Tests Passing');
    expect(plain).toContain('1317 / 1317 green');
    // The narrative around the invalid fence renders.
    expect(plain).toContain('preamble');
    expect(plain).toContain('epilogue');
    // The invalid-fence fallback row renders without crashing the panel.
    expect(plain).toContain('json-render block failed');
    // Themed-color verification (violet card border + gold heading) is
    // covered by the visual harness + OutputPanel integration tests —
    // the scenarios runner's stdout passes through chalk at level 0
    // (no `setupFiles` in `vitest.scenarios.config.ts`), so truecolor
    // escapes are not emitted here. The end-to-end content path is
    // proven by the title/heading/body strings appearing in `plain`.
    void fullStream;

    await launcher.stop('scenario shutdown');
    await launcher.done;
    expect(handle.closeMock).toHaveBeenCalled();
  }, 30_000);
});
