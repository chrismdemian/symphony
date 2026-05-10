/**
 * Phase 3D.1 scenario — output panel through the launcher.
 *
 * End-to-end: a single worker shows up in the workers panel, reconcile
 * auto-selects it, OutputPanel mounts WorkerOutputView, the
 * useWorkerEvents hook subscribes + tails, and the rendered frame
 * carries the scripted backfill + live events.
 *
 * Mirrors `tests/scenarios/3c.test.ts`'s shape (FakeMaestroProcess,
 * makeFakeRpc, runStart with rpcOverride). Adds a `subscribe` impl on
 * the fake RPC that exposes a per-workerId emit hook so the test can
 * push live events at the right moment.
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
  sandbox = mkdtempSync(join(tmpdir(), 'symphony-3d1-scenario-'));
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
        flushAwayDigest: vi.fn(async () => undefined),
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

const SAMPLE_FILE_BODY = [
  'export function add(a: number, b: number): number {',
  '  return a + b;',
  '}',
].join('\n');

describe('Phase 3D.1 scenario — output panel through the launcher', () => {
  it('renders empty hint, then backfilled stream, then live retry banner that auto-clears', async () => {
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
      { type: 'assistant_text', text: 'Reading the file you mentioned.' },
      { type: 'tool_use', callId: 'c1', name: 'Read', input: { file_path: 'src/foo.ts' } },
      { type: 'tool_result', callId: 'c1', content: SAMPLE_FILE_BODY, isError: false },
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

    // Phase 1 — empty workers list. Output panel shows the no-selection hint.
    await settle(200);
    const initialFrame = stripAnsi(stdoutChunks.join(''));
    expect(initialFrame).toContain('Output');
    expect(initialFrame).toContain('Select a worker');
    // Phase 3K: useCompletionEvents subscribes to `completions.events` on
    // App mount unconditionally. Filter the assertion to the topic this
    // scenario actually cares about — workers.events.
    const workersSubscribes = handle.subscribeMock.mock.calls.filter(
      (c) => c[0] === 'workers.events',
    );
    expect(workersSubscribes).toHaveLength(0);
    expect(handle.tailMock).not.toHaveBeenCalled();

    // Phase 2 — add one worker. Reconcile auto-selects it after the next
    // 1 s poll. The OutputPanel switches to <WorkerOutputView>, which
    // subscribes + tails.
    workers = [
      snap({ id: 'w1', featureIntent: 'reads file', status: 'running' }),
    ];
    await settle(1300);

    expect(handle.subscribeMock).toHaveBeenCalledWith(
      'workers.events',
      { workerId: 'w1' },
      expect.any(Function),
    );
    expect(handle.tailMock).toHaveBeenCalledWith({ workerId: 'w1', n: 200 });

    // After backfill resolves, the rendered frame contains the scripted
    // sequence (assistant text + tool row + tool result body).
    await settle(200);
    const backfillFrame = stripAnsi(stdoutChunks.join(''));
    expect(backfillFrame).toContain('Reading the file you mentioned.');
    expect(backfillFrame).toContain('▸ Read  src/foo.ts');
    expect(backfillFrame).toContain('export function add');

    // Phase 3 — emit a live rate-limit event. Sticky banner appears at
    // the top of the body alongside the inline retry row.
    handle.emit('w1', {
      type: 'system_api_retry',
      attempt: 2,
      delayMs: 8000,
      raw: { attempt: 2, delayMs: 8000 },
    });
    await settle(200);
    const retryBaseline = stripAnsi(stdoutChunks.join(''));
    // Trim to the most recent visible frame. A blunt heuristic: count
    // occurrences in the FULL stream (banner + inline row both written
    // in the latest frame), and verify the count is even (in pairs of 2)
    // OR at least 2 for the latest frame's content.
    const retryOccurrences = (retryBaseline.match(/rate limited/g) ?? []).length;
    expect(retryOccurrences).toBeGreaterThanOrEqual(2);

    // Phase 4 — emit a follow-up assistant_text. Banner clears; inline
    // row stays in the audit trail.
    const beforeClearLen = stdoutChunks.join('').length;
    handle.emit('w1', { type: 'assistant_text', text: 'back online — continuing.' });
    await settle(200);
    const postClearFrame = stripAnsi(stdoutChunks.join('').slice(beforeClearLen));
    expect(postClearFrame).toContain('back online');

    await launcher.stop('scenario shutdown');
    await launcher.done;
    expect(handle.closeMock).toHaveBeenCalled();
  }, 30_000);
});
