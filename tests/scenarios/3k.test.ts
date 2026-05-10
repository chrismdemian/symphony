/**
 * Phase 3K scenario — completion summary through the launcher.
 *
 * Drives `runStart` end-to-end with a fake RPC whose
 * `subscribe('completions.events', ...)` fires a canned
 * `CompletionSummary` once. After mount + first poll cycle, the chat
 * panel should render a system row with the resolved worker name
 * (instrument-allocated, not the server slug), project, status icon,
 * duration, and headline body.
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
import type { CompletionSummary } from '../../src/orchestrator/completion-summarizer-types.js';

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
  sandbox = mkdtempSync(join(tmpdir(), 'symphony-3k-scenario-'));
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
  summary: CompletionSummary;
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
        flushAwayDigest: vi.fn(async () => undefined),
      },
    },
    subscribe: vi.fn(async (topic: string, _args: unknown, listener: (e: unknown) => void) => {
      if (topic === 'completions.events') {
        // Fire one summary asynchronously so the subscribe Promise
        // resolves first (matching the production wire flow where the
        // server acks subscribe before broker.publish runs).
        setImmediate(() => listener(opts.summary));
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

describe('Phase 3K scenario — completion summary through the launcher', () => {
  it('renders a system row in the chat panel when a CompletionSummary fires', async () => {
    const fakeMaestro = new FakeMaestroProcess();
    const fakeMaestroAsProcess = fakeMaestro as unknown as MaestroProcess;
    Object.defineProperty(fakeMaestroAsProcess, 'events', {
      value: () => fakeMaestro.eventsIter(),
    });

    const projects: ProjectSnapshot[] = [
      { id: 'p1', name: 'demo', path: '/repos/demo', createdAt: '2026-04-30T00:00:00Z' },
    ];
    const workers: WorkerRecordSnapshot[] = [
      {
        id: 'wk-1',
        projectPath: '/repos/demo',
        worktreePath: '/repos/demo/.symphony/worktrees/wk-1',
        role: 'implementer',
        featureIntent: 'wire the friend system',
        taskDescription: 'friend system',
        autonomyTier: 1,
        dependsOn: [],
        status: 'completed',
        createdAt: new Date(Date.now() - 60_000).toISOString(),
      },
    ];
    const summary: CompletionSummary = {
      // workerId matches the live worker so the instrument allocator
      // resolves it to a name (Violin / Cello / ...). The server's
      // workerName slug is the fallback path; the TUI overrides.
      workerId: 'wk-1',
      workerName: 'worker-wk-1',
      projectName: 'demo',
      statusKind: 'completed',
      durationMs: 138_000,
      headline: 'wired the friend system endpoints',
      ts: new Date().toISOString(),
      fallback: false,
    };

    const rpc = makeFakeRpc({ projects, workers, summary });

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

    // Wait for first poll cycle (1s for workers list) + the
    // completions.events listener to fire (setImmediate after the
    // subscribe Promise resolves).
    await settle(1500);

    const frame = stripAnsi(stdoutChunks.join(''));
    // Subscribe was called with the right topic.
    const subscribeCalls = (rpc.subscribe as ReturnType<typeof vi.fn>).mock.calls;
    const completionsSubs = subscribeCalls.filter((args) => args[0] === 'completions.events');
    expect(completionsSubs.length).toBeGreaterThanOrEqual(1);

    // System row rendered in chat: glyph + headline.
    expect(frame).toContain('✓');
    expect(frame).toContain('wired the friend system endpoints');
    // Project label in parens.
    expect(frame).toContain('(demo)');
    // Duration formatted.
    expect(frame).toContain('2m 18s');
    // Worker name resolved by instrument allocator (not the server
    // slug `worker-wk-1`). Instrument names start with the canonical
    // pool from `src/ui/data/instruments.ts`.
    const INSTRUMENT_HINTS = ['Violin', 'Cello', 'Viola', 'Flute', 'Oboe', 'Clarinet'];
    expect(INSTRUMENT_HINTS.some((name) => frame.includes(name))).toBe(true);
    // Inverse: the slug fallback should NOT appear (instrument allocator wins).
    expect(frame).not.toContain('worker-wk-1');

    await handle.stop('scenario shutdown');
    await handle.done;
    expect(rpc.close).toHaveBeenCalled();
  }, 30_000);
});
