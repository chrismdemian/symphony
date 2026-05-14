/**
 * Phase 3O.1 scenario — auto-merge gate through the launcher.
 *
 * Drives `runStart` end-to-end with a fake RPC whose
 * `subscribe('auto-merge.events', ...)` fires a sequence of canned
 * `AutoMergeEvent`s. After mount + first poll cycle, the chat panel
 * should render a system row per event with the right glyph + headline.
 *
 * Covers all three modes:
 *   - 'ask'  → an `asked` event + a follow-up `merged` event (simulating
 *              y-answer-then-merge), then verify both system rows.
 *   - 'never' → a `ready` event surfaced as a muted timeout-glyph row.
 *   - 'failed' → a `failed` event surfaced as red.
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
import type { AutoMergeEvent } from '../../src/orchestrator/auto-merge-types.js';

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
  sandbox = mkdtempSync(join(tmpdir(), 'symphony-3o1-scenario-'));
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
  events: AutoMergeEvent[];
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
      recovery: { report: vi.fn(async () => ({ crashedIds: [], capturedAt: '1970-01-01T00:00:00.000Z' })) },
    },
    subscribe: vi.fn(async (topic: string, _args: unknown, listener: (e: unknown) => void) => {
      if (topic === 'auto-merge.events') {
        // Fire all canned events asynchronously so the subscribe Promise
        // resolves first (matches production wire flow: server acks
        // subscribe before broker.publish runs).
        setImmediate(() => {
          for (const ev of opts.events) listener(ev);
        });
      }
      return {
        topic,
        unsubscribe: async () => {},
      };
    }),
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

const baseProjects: ProjectSnapshot[] = [
  { id: 'p1', name: 'demo', path: '/repos/demo', createdAt: '2026-05-13T00:00:00Z' },
];
const baseWorkers: WorkerRecordSnapshot[] = [
  {
    id: 'wk-1',
    projectPath: '/repos/demo',
    worktreePath: '/repos/demo/.symphony/worktrees/wk-1',
    role: 'implementer',
    featureIntent: 'auto-merge probe',
    taskDescription: 'auto-merge probe',
    autonomyTier: 1,
    dependsOn: [],
    status: 'completed',
    createdAt: new Date(Date.now() - 60_000).toISOString(),
  },
];

describe('Phase 3O.1 scenario — auto-merge events through the launcher', () => {
  it("renders a 'merged' system row when subscribe fires a merged event", async () => {
    const fakeMaestro = new FakeMaestroProcess();
    const fakeMaestroAsProcess = fakeMaestro as unknown as MaestroProcess;
    Object.defineProperty(fakeMaestroAsProcess, 'events', {
      value: () => fakeMaestro.eventsIter(),
    });

    const events: AutoMergeEvent[] = [
      {
        kind: 'merged',
        workerId: 'wk-1',
        branch: 'feature/foo',
        projectName: 'demo',
        mergeTo: 'master',
        headline: "Merged 'feature/foo' into master (abc1234)",
        mergeSha: 'abc1234def5678901234567890abcdefdeadbeef',
        ts: new Date().toISOString(),
      },
    ];
    const rpc = makeFakeRpc({ projects: baseProjects, workers: baseWorkers, events });
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

    // Wait for first poll cycle (1s) + the subscribe listener to fire.
    await settle(1500);

    const frame = stripAnsi(stdoutChunks.join(''));

    // Subscribe to auto-merge.events was issued.
    const subscribeCalls = (rpc.subscribe as ReturnType<typeof vi.fn>).mock.calls;
    const autoMergeSubs = subscribeCalls.filter((args) => args[0] === 'auto-merge.events');
    expect(autoMergeSubs.length).toBeGreaterThanOrEqual(1);

    // Merged row surfaced with the ✓ success glyph.
    expect(frame).toContain("Merged 'feature/foo' into master");
    expect(frame).toContain('✓');

    await handle.stop('scenario shutdown');
    await handle.done;
    expect(rpc.close).toHaveBeenCalled();
  }, 30_000);

  it("renders an 'asked' system row when subscribe fires an asked event", async () => {
    const fakeMaestro = new FakeMaestroProcess();
    const fakeMaestroAsProcess = fakeMaestro as unknown as MaestroProcess;
    Object.defineProperty(fakeMaestroAsProcess, 'events', {
      value: () => fakeMaestro.eventsIter(),
    });

    const events: AutoMergeEvent[] = [
      {
        kind: 'asked',
        workerId: 'wk-1',
        branch: 'feature/foo',
        projectName: 'demo',
        mergeTo: 'master',
        headline: "Worker on 'feature/foo' is ready. Merge into master? (open question popup with Ctrl+Q · reply y / n)",
        ts: new Date().toISOString(),
      },
    ];
    const rpc = makeFakeRpc({ projects: baseProjects, workers: baseWorkers, events });
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

    const frame = stripAnsi(stdoutChunks.join(''));
    expect(frame).toContain('Merge into master');
    // Asked row uses the ⏱ warning glyph (mapped from kind='asked').
    expect(frame).toContain('⏱');

    await handle.stop('scenario shutdown');
    await handle.done;
  }, 30_000);

  it("renders a 'ready' system row when autoMerge='never' fires the event", async () => {
    const fakeMaestro = new FakeMaestroProcess();
    const fakeMaestroAsProcess = fakeMaestro as unknown as MaestroProcess;
    Object.defineProperty(fakeMaestroAsProcess, 'events', {
      value: () => fakeMaestro.eventsIter(),
    });

    const events: AutoMergeEvent[] = [
      {
        kind: 'ready',
        workerId: 'wk-1',
        branch: 'feature/bar',
        projectName: 'demo',
        mergeTo: 'master',
        headline: "Worker on 'feature/bar' is ready for manual merge",
        ts: new Date().toISOString(),
      },
    ];
    const rpc = makeFakeRpc({ projects: baseProjects, workers: baseWorkers, events });
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

    const frame = stripAnsi(stdoutChunks.join(''));
    expect(frame).toContain('ready for manual merge');
    expect(frame).toContain('⏱');

    await handle.stop('scenario shutdown');
    await handle.done;
  }, 30_000);

  it("renders a 'failed' system row when a merge fails", async () => {
    const fakeMaestro = new FakeMaestroProcess();
    const fakeMaestroAsProcess = fakeMaestro as unknown as MaestroProcess;
    Object.defineProperty(fakeMaestroAsProcess, 'events', {
      value: () => fakeMaestro.eventsIter(),
    });

    const events: AutoMergeEvent[] = [
      {
        kind: 'failed',
        workerId: 'wk-1',
        branch: 'feature/baz',
        projectName: 'demo',
        mergeTo: 'master',
        headline: "Merge of 'feature/baz' into master failed: MergeConflictError: conflict · branch left for review",
        reason: 'MergeConflictError: conflict',
        ts: new Date().toISOString(),
      },
    ];
    const rpc = makeFakeRpc({ projects: baseProjects, workers: baseWorkers, events });
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

    const frame = stripAnsi(stdoutChunks.join(''));
    expect(frame).toContain('failed');
    // The 'failed' row uses the ✗ error glyph.
    expect(frame).toContain('✗');

    await handle.stop('scenario shutdown');
    await handle.done;
  }, 30_000);
});
