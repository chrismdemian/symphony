/**
 * Phase 3B.2 scenario test — tool call summaries + ANSI stripping
 * through the launcher.
 *
 * Mirrors `3b1.test.ts` harness shape (FakeMaestroProcess + makeFakeRpc
 * + TTY-flagged PassThroughs). Drives a turn that fires a tool, asserts
 * the rendered frame carries `▸ list_workers` and the ANSI-stripped
 * result body. See `3b2.md` for the explicit coverage limits — slash
 * commands and scrolling are covered at the unit level.
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

class FakeMaestroProcess {
  readonly emitter = new EventEmitter();
  readonly sentMessages: string[] = [];
  startCount = 0;
  killCount = 0;
  eventsIterCount = 0;

  async start(_input: MaestroStartInput): Promise<MaestroStartResult> {
    this.startCount += 1;
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

  injectIdle(): void {
    // unused
  }

  on(type: string, listener: (e: unknown) => void): this {
    this.emitter.on(type, listener);
    return this;
  }

  off(type: string, listener: (e: unknown) => void): this {
    this.emitter.off(type, listener);
    return this;
  }

  async kill(): Promise<undefined> {
    this.killCount += 1;
    this.emitter.emit('stopped');
    return undefined;
  }

  async *eventsIter(): AsyncIterable<MaestroEvent> {
    this.eventsIterCount += 1;
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
  sandbox = mkdtempSync(join(tmpdir(), 'symphony-3b2-scenario-'));
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

function makeFakeRpc(projects: ProjectSnapshot[]): FullFakeRpc {
  return {
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
        list: vi.fn(async () => []),
        get: vi.fn(async () => null),
        kill: vi.fn(async () => ({ killed: false })),
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
      recovery: { report: vi.fn(async () => ({ crashedIds: [], capturedAt: '1970-01-01T00:00:00.000Z' })) },
    },
    subscribe: vi.fn(async () => ({ topic: 'noop', unsubscribe: async () => {} })),
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

function flush(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}

function settle(ms = 80): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe('Phase 3B.2 scenario — tool call summaries through the launcher', () => {
  it('renders the tool summary line and ANSI-stripped result body in the frame', async () => {
    const fakeMaestro = new FakeMaestroProcess();
    const fakeMaestroAsProcess = fakeMaestro as unknown as MaestroProcess;
    Object.defineProperty(fakeMaestroAsProcess, 'events', {
      value: () => fakeMaestro.eventsIter(),
    });

    const projects: ProjectSnapshot[] = [
      { id: 'p1', name: 'demo', path: '/repos/demo', createdAt: '2026-04-30T00:00:00Z' },
    ];
    const rpc = makeFakeRpc(projects);

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

    await settle(150);

    // Plan §3B S3 invariant — single iterator opened by provider.
    expect(fakeMaestro.eventsIterCount).toBe(1);

    // Drive a full turn that fires a tool with ANSI in the result.
    fakeMaestro.emitter.emit('event', { type: 'turn_started' } as MaestroEvent);
    await flush();
    fakeMaestro.emitter.emit('event', {
      type: 'assistant_text',
      text: 'Looking up workers.',
    } as MaestroEvent);
    await flush();
    fakeMaestro.emitter.emit('event', {
      type: 'tool_use',
      callId: 'c1',
      name: 'list_workers',
      input: {},
    } as MaestroEvent);
    await flush();
    fakeMaestro.emitter.emit('event', {
      type: 'tool_result',
      callId: 'c1',
      content: '\x1b[32mhello\x1b[0m world',
      isError: false,
    } as MaestroEvent);
    await flush();
    fakeMaestro.emitter.emit('event', {
      type: 'assistant_text',
      text: 'No workers running.',
    } as MaestroEvent);
    await flush();
    fakeMaestro.emitter.emit('event', {
      type: 'turn_completed',
      isError: false,
      resultText: '',
    } as MaestroEvent);
    await settle(300);

    const rendered = stdoutChunks.join('');
    // Tool summary header carries the tool name. Empty input → no
    // value follows the name, just the status glyph.
    expect(rendered).toContain('▸ list_workers');
    // ANSI-stripped result body lands.
    expect(rendered).toContain('hello world');
    // Flanking text blocks both render.
    expect(rendered).toContain('Looking up workers.');
    expect(rendered).toContain('No workers running.');

    // Teardown.
    await handle.stop('scenario shutdown');
    await handle.done;

    expect(fakeMaestro.killCount).toBe(1);
    expect(rpc.close).toHaveBeenCalled();
  }, 30_000);
});
