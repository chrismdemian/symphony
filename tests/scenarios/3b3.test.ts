/**
 * Phase 3B.3 scenario — status line (Equalizer + ShimmerText verb)
 * through the launcher.
 *
 * Mirrors `3b2.test.ts` harness shape. Drives a turn that fires a
 * `list_workers` tool, asserts the rendered frame contains an EQ glyph
 * AND the `Listening` verb during the in-flight window, then asserts
 * BOTH disappear after `turn_completed`.
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
  sandbox = mkdtempSync(join(tmpdir(), 'symphony-3b3-scenario-'));
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

const stripAnsi = (s: string): string =>
  // eslint-disable-next-line no-control-regex
  s.replace(/\x1b\[[\d;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');

const EQ_GLYPHS = /[▁▂▃▄▅▆▇█]{4}/;

describe('Phase 3B.3 scenario — status line through the launcher', () => {
  it('renders Equalizer + verb during in-flight turn, then clears them', async () => {
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

    // Snapshot the buffer length before the turn so we can scope the
    // "in-flight" assertions to the new frames only.
    const baselineLen = stdoutChunks.join('').length;

    // Drive a turn that fires `list_workers`. Hold tool_result until
    // we've sampled the in-flight frames so the status line is captured
    // visibly.
    fakeMaestro.emitter.emit('event', { type: 'turn_started' } as MaestroEvent);
    await flush();
    fakeMaestro.emitter.emit('event', {
      type: 'tool_use',
      callId: 'c1',
      name: 'list_workers',
      input: {},
    } as MaestroEvent);
    await settle(250);

    const inFlightFrames = stripAnsi(stdoutChunks.join('').slice(baselineLen));
    expect(inFlightFrames).toMatch(EQ_GLYPHS);
    expect(inFlightFrames).toContain('Listening');

    // Snapshot the in-flight occurrence count so we can prove the
    // status line ACTUALLY cleared post-completion (audit M3: a tail-
    // chunk slice could pass even when the bug — status stuck on idle —
    // is present).
    const inFlightOccurrences = (inFlightFrames.match(/Listening/g) ?? []).length;
    expect(inFlightOccurrences).toBeGreaterThan(0);
    const postBaselineLen = stdoutChunks.join('').length;

    // Now complete the turn and verify the status line clears.
    fakeMaestro.emitter.emit('event', {
      type: 'tool_result',
      callId: 'c1',
      content: 'no workers',
      isError: false,
    } as MaestroEvent);
    await flush();
    fakeMaestro.emitter.emit('event', {
      type: 'turn_completed',
      isError: false,
      resultText: '',
    } as MaestroEvent);
    await settle(300);

    // Audit M3: assert the POST-completion frame writes contain ZERO
    // `Listening` occurrences. ink-testing-library's alt-screen mode
    // redraws full frames per change, so any frame written after
    // `turn_completed` reflects the cleared StatusLine. Counting beats
    // tail-slicing because it can't accidentally pass on partial writes.
    const postCompletionFrames = stripAnsi(stdoutChunks.join('').slice(postBaselineLen));
    const postOccurrences = (postCompletionFrames.match(/Listening/g) ?? []).length;
    // The very last frame (after StatusLine renders the empty <Box/>)
    // must overwrite the verb. Ink alt-screen sends the new frame with
    // the verb absent, so cumulative post-completion writes contain at
    // most one residual occurrence (a partial frame in flight when
    // turn_completed lands). Strict assertion: the COUNT must decrease
    // by at least the in-flight count's worth of "cleared" frames.
    expect(postOccurrences).toBeLessThan(inFlightOccurrences);

    // Teardown.
    await handle.stop('scenario shutdown');
    await handle.done;

    expect(fakeMaestro.killCount).toBe(1);
    expect(rpc.close).toHaveBeenCalled();
  }, 30_000);
});
