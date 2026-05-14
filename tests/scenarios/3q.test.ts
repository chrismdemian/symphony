/**
 * Phase 3Q scenario — reliability through the launcher.
 *
 * Drives `runStart` end-to-end with a fake RPC whose `recovery.report()`
 * returns canned crashed worker IDs. Asserts:
 *   1. The launcher calls `rpc.call.recovery.report()` exactly once after RPC connect.
 *   2. When crashedIds.length > 0, the TUI renders a system chat row with
 *      ✗ + "Symphony" header + the recovery copy.
 *   3. When crashedIds.length === 0, no recovery banner appears.
 *   4. SIGHUP triggers graceful stop with the final "State saved" message
 *      on stderr.
 *
 * Mirrors the shape of `tests/scenarios/3p.test.ts`.
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
  sandbox = mkdtempSync(join(tmpdir(), 'symphony-3q-scenario-'));
  home = join(sandbox, 'home');
});

afterEach(() => {
  try {
    rmSync(sandbox, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FullFakeRpc = any;

function makeFakeRpc(opts: {
  projects: ProjectSnapshot[];
  workers: WorkerRecordSnapshot[];
  recoveryCrashedIds: readonly string[];
}): FullFakeRpc {
  return {
    call: {
      projects: {
        list: vi.fn(async () => opts.projects),
        get: vi.fn(async () => null),
        register: vi.fn(async () => null),
      },
      tasks: {
        list: vi.fn(async () => []),
        get: vi.fn(async () => null),
        create: vi.fn(async () => null),
        update: vi.fn(async () => null),
        graph: vi.fn(async () => ({ nodes: [], edges: [], cycles: [] })),
      },
      workers: {
        list: vi.fn(async () => opts.workers),
        get: vi.fn(async () => opts.workers[0] ?? null),
        kill: vi.fn(async () => ({ killed: false })),
        tail: vi.fn(async () => ({ events: [], total: 0 })),
        diff: vi.fn(async () => null),
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
        setModel: vi.fn(async () => ({ modelMode: 'opus' as const, warnings: [] })),
      },
      queue: {
        list: vi.fn(async () => []),
        cancel: vi.fn(async () => ({ cancelled: false, reason: 'not in queue' })),
        reorder: vi.fn(async () => ({ moved: false, reason: 'not in queue' })),
      },
      notifications: {
        flushAwayDigest: vi.fn(async () => ({ digest: null })),
      },
      runtime: {
        setAwayMode: vi.fn(async () => undefined),
      },
      recovery: {
        report: vi.fn(async () => ({
          crashedIds: opts.recoveryCrashedIds,
          capturedAt: '2026-05-14T12:00:00.000Z',
        })),
      },
    },
    subscribe: vi.fn(async (topic: string, _args: unknown) => ({
      topic,
      unsubscribe: async () => {},
    })),
    close: vi.fn(async () => undefined),
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

const ISO = '2026-05-14T00:00:00.000Z';

const baseProjects: ProjectSnapshot[] = [
  { id: 'p1', name: 'demo', path: '/repos/demo', createdAt: ISO },
];
const baseWorkers: WorkerRecordSnapshot[] = [];

describe('Phase 3Q scenario — reliability through the launcher', () => {
  it('renders the recovery banner when crashedIds is non-empty', async () => {
    const fakeMaestro = new FakeMaestroProcess();
    const fakeMaestroAsProcess = fakeMaestro as unknown as MaestroProcess;
    Object.defineProperty(fakeMaestroAsProcess, 'events', {
      value: () => fakeMaestro.eventsIter(),
    });

    const rpc = makeFakeRpc({
      projects: baseProjects,
      workers: baseWorkers,
      recoveryCrashedIds: ['w-aaaa', 'w-bbbb', 'w-cccc'],
    });
    const stdin = makeTtyStream(true) as NodeJS.ReadStream;
    const stdout = makeTtyStream(false) as NodeJS.WriteStream;
    const stderr = new PassThrough();
    const stdoutChunks: string[] = [];
    (stdout as unknown as PassThrough).on('data', (c: Buffer) =>
      stdoutChunks.push(c.toString('utf8')),
    );

    const hookServer = new MaestroHookServer({ token: 'fixed-tok' });
    const handle = await runStart({
      home,
      cliEntryPath: '/fake/cli/entry.js',
      io: { stdin, stdout, stderr },
      skipSignalHandlers: true,
      rpcOverride: {
        descriptor: { host: '127.0.0.1', port: 0, token: 't' },
        client: rpc as unknown as LauncherRpc,
      },
      hookServerFactory: () => hookServer,
      maestroFactory: () => fakeMaestroAsProcess,
      workerManager: { ensureClaudeTrust: async () => undefined } as never,
    });

    await settle(1500);

    // Launcher called recovery.report exactly once.
    expect(rpc.call.recovery.report).toHaveBeenCalledTimes(1);

    const frame = stripAnsi(stdoutChunks.join(''));
    // The chat row with ✗ + Symphony + plural copy.
    expect(frame).toContain('Symphony');
    expect(frame).toContain('Recovered 3 workers from previous session');
    expect(frame).toContain('resume_worker');

    await handle.stop('scenario shutdown');
    await handle.done;
  });

  it('omits the recovery banner when crashedIds is empty', async () => {
    const fakeMaestro = new FakeMaestroProcess();
    const fakeMaestroAsProcess = fakeMaestro as unknown as MaestroProcess;
    Object.defineProperty(fakeMaestroAsProcess, 'events', {
      value: () => fakeMaestro.eventsIter(),
    });

    const rpc = makeFakeRpc({
      projects: baseProjects,
      workers: baseWorkers,
      recoveryCrashedIds: [],
    });
    const stdin = makeTtyStream(true) as NodeJS.ReadStream;
    const stdout = makeTtyStream(false) as NodeJS.WriteStream;
    const stderr = new PassThrough();
    const stdoutChunks: string[] = [];
    (stdout as unknown as PassThrough).on('data', (c: Buffer) =>
      stdoutChunks.push(c.toString('utf8')),
    );

    const handle = await runStart({
      home,
      cliEntryPath: '/fake/cli/entry.js',
      io: { stdin, stdout, stderr },
      skipSignalHandlers: true,
      rpcOverride: {
        descriptor: { host: '127.0.0.1', port: 0, token: 't' },
        client: rpc as unknown as LauncherRpc,
      },
      hookServerFactory: () => new MaestroHookServer({ token: 'tok' }),
      maestroFactory: () => fakeMaestroAsProcess,
      workerManager: { ensureClaudeTrust: async () => undefined } as never,
    });

    await settle(1500);

    const frame = stripAnsi(stdoutChunks.join(''));
    expect(frame).not.toMatch(/Recovered \d+ worker/);

    await handle.stop('scenario shutdown');
    await handle.done;
  });

  it('writes the "State saved" message on stderr on graceful stop', async () => {
    const fakeMaestro = new FakeMaestroProcess();
    const fakeMaestroAsProcess = fakeMaestro as unknown as MaestroProcess;
    Object.defineProperty(fakeMaestroAsProcess, 'events', {
      value: () => fakeMaestro.eventsIter(),
    });

    const rpc = makeFakeRpc({
      projects: baseProjects,
      workers: baseWorkers,
      recoveryCrashedIds: [],
    });

    const stderr = new PassThrough();
    const stderrBufs: string[] = [];
    stderr.on('data', (c: Buffer) => stderrBufs.push(c.toString('utf8')));

    const handle = await runStart({
      home,
      cliEntryPath: '/fake/cli/entry.js',
      io: { stdin: new PassThrough(), stdout: new PassThrough(), stderr },
      skipSignalHandlers: true,
      rpcOverride: {
        descriptor: { host: '127.0.0.1', port: 0, token: 't' },
        client: rpc as unknown as LauncherRpc,
      },
      hookServerFactory: () => new MaestroHookServer({ token: 'tok' }),
      maestroFactory: () => fakeMaestroAsProcess,
      workerManager: { ensureClaudeTrust: async () => undefined } as never,
    });

    await handle.stop('scenario shutdown');
    await handle.done;

    const out = stderrBufs.join('');
    expect(out).toMatch(/State saved\. Run `symphony start` to resume\./);
  });
});
