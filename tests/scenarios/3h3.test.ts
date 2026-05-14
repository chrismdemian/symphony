/**
 * Phase 3H.3 scenario — notifications + awayMode toggle end-to-end.
 *
 * Mirrors the 3H.2 scenario shape: same FakeMaestroProcess, same
 * makeFakeRpc (extended with the `notifications` namespace), same
 * makeTtyStream, same launcher boot. Drives the settings popup via
 * the slash-command path (`/config Enter`) and asserts disk
 * persistence + the awayMode true→false RPC trigger.
 *
 * Why slash + not Ctrl+, : Ctrl+, requires kitty CSI-u encoding which
 * ink-testing-library doesn't deliver. Same trade-off documented in
 * the 3H.1 / 3H.2 scenarios.
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
  sandbox = mkdtempSync(join(tmpdir(), 'symphony-3h3-scenario-'));
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
  flushAwayDigestMock: ReturnType<typeof vi.fn>;
}

function makeFakeRpc(projects: ProjectSnapshot[]): FakeRpcHandle {
  const closeMock = vi.fn(async () => undefined);
  // Phase 3M — flushAwayDigest return shape changed from void to
  // { digest: string | null }. The 3H.3 test only asserts the call
  // count (not the result), but the App.tsx useEffect now reads
  // result.digest, so undefined would throw. Return a benign null.
  const flushAwayDigestMock = vi.fn(async () => ({ digest: null }));
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
        flushAwayDigest: flushAwayDigestMock,
      },
      // Phase 3M — App.tsx's awayMode useEffect fires `runtime.setAwayMode`
      // on every change. Without the namespace, the call would throw and
      // crash the React tree. Resolve to a benign echo.
      runtime: {
        setAwayMode: vi.fn(async (args: { awayMode: boolean }) => ({
          awayMode: args.awayMode,
        })),
      },
      recovery: { report: vi.fn(async () => ({ crashedIds: [], capturedAt: '1970-01-01T00:00:00.000Z' })) },
    },
    subscribe: vi.fn(async () => ({
      topic: 'workers.events',
      unsubscribe: async () => undefined,
    })),
    close: closeMock,
  };
  return { rpc, closeMock, flushAwayDigestMock };
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
const DOWN = '\x1b[B';

describe('Phase 3H.3 scenario — notifications + awayMode wiring', () => {
  it('toggles notifications.enabled and awayMode; awayMode true→false fires flushAwayDigest', async () => {
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
      expect(plain).toContain('notifications.enabled');
      expect(plain).toContain('awayMode');
    }

    // ── Navigate to notifications.enabled.
    // Value rows in order (nav skips 'header' rows; 'value' rows with
    // editKind 'readonly' are still navigable):
    //   0. modelMode                    (enum)
    //   1. maxConcurrentWorkers         (int)
    //   2. theme.name                   (readonly)
    //   3. theme.autoFallback16Color    (bool)
    //   4. notifications.enabled        (bool) ← target
    //   5. awayMode                     (bool) ← target 2
    // Default selection is index 0 (modelMode). Four DOWN arrows lands
    // on notifications.enabled. Settle briefly between presses so the
    // raw-mode stdin handler advances reducer state for each key.
    for (let i = 0; i < 4; i += 1) {
      (stdin as unknown as PassThrough).write(DOWN);
       
      await settle(80);
    }

    // Space toggles bool. After this notifications.enabled = true.
    (stdin as unknown as PassThrough).write(' ');
    await settle(800);
    {
      const onDisk = JSON.parse(readFileSync(cfgFile, 'utf8')) as Record<string, unknown>;
      const notif = onDisk['notifications'] as Record<string, unknown> | undefined;
      expect(notif?.['enabled']).toBe(true);
    }

    // ── Navigate down once to awayMode, Space to toggle on. Need a
    // longer settle after the prior Space because SettingsPanel's
    // committingRef mutex (audit M1/M2) blocks input while the disk
    // write is in flight; the DOWN keystroke would otherwise be a
    // no-op on the previous row.
    await settle(800);
    (stdin as unknown as PassThrough).write(DOWN);
    await settle(500);
    (stdin as unknown as PassThrough).write(' ');
    await settle(1500);
    {
      const onDisk = JSON.parse(readFileSync(cfgFile, 'utf8')) as Record<string, unknown>;
      expect(onDisk['awayMode']).toBe(true);
    }

    // The true→false edge has NOT happened yet; flush should not have
    // been called.
    expect(handle.flushAwayDigestMock).not.toHaveBeenCalled();

    // ── Toggle awayMode back off — this is the edge that fires flush.
    (stdin as unknown as PassThrough).write(' ');
    await settle(800);
    {
      const onDisk = JSON.parse(readFileSync(cfgFile, 'utf8')) as Record<string, unknown>;
      expect(onDisk['awayMode']).toBe(false);
    }
    // The TUI's useEffect on awayMode detected true→false and invoked
    // the RPC procedure. settle() above gives React commit + the
    // microtask chain time to fire.
    expect(handle.flushAwayDigestMock).toHaveBeenCalledTimes(1);

    // ── Esc closes popup, chat placeholder restored.
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
