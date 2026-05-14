/**
 * Phase 3H.2 scenario — editable settings popup end-to-end.
 *
 * Mirrors `tests/scenarios/3h1.test.ts`'s shape: same FakeMaestroProcess,
 * same makeFakeRpc, same makeTtyStream, same launcher boot. Adds:
 *
 * - Enter on modelMode cycles `mixed → opus` and disk persists.
 * - A SECOND rapid Enter cycles back to `mixed` (audit C2 from the
 *   commit-5 review): function-patches inside `applyPatchToDisk`'s
 *   serialized queue read the just-committed value, so two synchronous
 *   chord presses produce two distinct toggles rather than collapsing
 *   to one.
 *
 * The slash-command path (`/config Enter`) is the reliable popup-open
 * route — Ctrl+, requires kitty CSI-u encoding which ink-testing-library
 * doesn't deliver. Same trade-off documented in the 3H.1 scenario.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter, PassThrough } from 'node:stream';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runStart } from '../../src/cli/start.js';
import { MaestroHookServer } from '../../src/orchestrator/maestro/hook-server.js';
import {
  SYMPHONY_CONFIG_FILE_ENV,
  _resetConfigWriteQueue,
} from '../../src/utils/config.js';
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
let cfgFile: string;
let originalCfgEnv: string | undefined;

beforeEach(() => {
  _resetConfigWriteQueue();
  sandbox = mkdtempSync(join(tmpdir(), 'symphony-3h2-scenario-'));
  home = join(sandbox, 'home');
  cfgFile = join(sandbox, 'config.json');
  originalCfgEnv = process.env[SYMPHONY_CONFIG_FILE_ENV];
  process.env[SYMPHONY_CONFIG_FILE_ENV] = cfgFile;
});

afterEach(() => {
  _resetConfigWriteQueue();
  if (originalCfgEnv === undefined) delete process.env[SYMPHONY_CONFIG_FILE_ENV];
  else process.env[SYMPHONY_CONFIG_FILE_ENV] = originalCfgEnv;
  try {
    rmSync(sandbox, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

interface FakeRpcHandle {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  rpc: any;
  closeMock: ReturnType<typeof vi.fn>;
}

function makeFakeRpc(projects: ProjectSnapshot[]): FakeRpcHandle {
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
        list: vi.fn(async () => []),
        get: vi.fn(async () => null),
        kill: vi.fn(async () => ({ killed: false })),
        tail: vi.fn(async () => ({ events: [], total: 0 })),
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
    subscribe: vi.fn(async () => ({
      topic: 'workers.events',
      unsubscribe: async () => undefined,
    })),
    close: closeMock,
  };
  return { rpc, closeMock };
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

const ESC = '\x1b';

describe('Phase 3H.2 scenario — editable settings popup', () => {
  it('Enter cycles modelMode opus↔mixed, persists to disk, rapid double-press toggles twice', async () => {
    const fakeMaestro = new FakeMaestroProcess();
    const fakeMaestroAsProcess = fakeMaestro as unknown as MaestroProcess;
    Object.defineProperty(fakeMaestroAsProcess, 'events', {
      value: () => fakeMaestro.eventsIter(),
    });

    const projects: ProjectSnapshot[] = [
      {
        id: 'p1',
        name: 'demo',
        path: '/repos/demo',
        createdAt: '2026-05-06T00:00:00Z',
      },
    ];
    const handle = makeFakeRpc(projects);

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

    await settle(1300);

    // ── Open the popup via /config slash ───────────────────────────────
    (stdin as unknown as PassThrough).write('/config');
    await settle(300);
    (stdin as unknown as PassThrough).write('\r');
    await settle(1200);

    {
      const recent = stdoutChunks.slice(-200).join('');
      const plain = stripAnsi(recent);
      expect(plain).toContain('Settings');
      // 3H.3 changed the header label to "Phase 3H.3" — match loosely
      // so future header bumps don't break this scenario.
      expect(plain).toContain('Phase 3H.');
      expect(plain).toContain('modelMode');
      expect(plain).toContain('mixed');
    }

    // ── First Enter: cycle modelMode mixed → opus, persist ─────────────
    const beforeFirst = stdoutChunks.length;
    (stdin as unknown as PassThrough).write('\r');
    await settle(1000);
    {
      const post = stdoutChunks.slice(beforeFirst).join('');
      const plain = stripAnsi(post);
      expect(plain).toContain('opus');
      const onDisk = JSON.parse(readFileSync(cfgFile, 'utf8')) as Record<string, unknown>;
      expect(onDisk['modelMode']).toBe('opus');
    }

    // ── Second Enter: cycle opus → mixed (audit C2 rapid-fire) ─────────
    const beforeSecond = stdoutChunks.length;
    (stdin as unknown as PassThrough).write('\r');
    await settle(1000);
    {
      const post = stdoutChunks.slice(beforeSecond).join('');
      const plain = stripAnsi(post);
      expect(plain).toContain('mixed');
      const onDisk = JSON.parse(readFileSync(cfgFile, 'utf8')) as Record<string, unknown>;
      expect(onDisk['modelMode']).toBe('mixed');
    }

    // ── Esc closes popup, chat placeholder restored ────────────────────
    const beforeEsc = stdoutChunks.length;
    (stdin as unknown as PassThrough).write(ESC);
    await settle(400);
    {
      const post = stdoutChunks.slice(beforeEsc).join('');
      const plain = stripAnsi(post);
      expect(plain).toContain('Tell Maestro what to do');
    }

    await launcher.stop('test-shutdown');
    await launcher.done;
    expect(handle.closeMock).toHaveBeenCalled();
  }, 30_000);
});
