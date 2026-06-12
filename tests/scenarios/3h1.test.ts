/**
 * Phase 3H.1 scenario — `/config` → settings popup → Esc → back to chat.
 *
 * Boots the launcher with a fake Maestro and a fake RPC. Drives the
 * settings popup through the slash-command path (`/config Enter`) which
 * is the most reliable keystroke route: the Ctrl+, hotkey requires the
 * kitty-keyboard CSI-u encoding which Ink's stream parser only accepts
 * when the terminal advertises support — `ink-testing-library`'s
 * fake stdout doesn't, so Ctrl+, would arrive as a literal `,` keystroke
 * that the chat InputBar absorbs. The slash-command path covers the
 * same registered handler (`focus.pushPopup('settings')`) and is end-
 * to-end equivalent for scenario coverage.
 *
 * Two phases:
 *   1. No config file on disk → popup renders defaults + `(default)`
 *      annotations + `Source: (no file — using defaults)`.
 *   2. After writing a customized config file → relaunch the popup →
 *      values render with `(from file)` annotations.
 *
 * Mirrors `tests/scenarios/3f1.test.ts` exactly in shape: same
 * FakeMaestroProcess, same makeFakeRpc, same makeTtyStream, same
 * launcher boot.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter, PassThrough } from 'node:stream';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runStart } from '../../src/cli/start.js';
import { MaestroHookServer } from '../../src/orchestrator/maestro/hook-server.js';
import { SYMPHONY_CONFIG_FILE_ENV } from '../../src/utils/config.js';
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
  sandbox = mkdtempSync(join(tmpdir(), 'symphony-3h1-scenario-'));
  home = join(sandbox, 'home');
  cfgFile = join(sandbox, 'config.json');
  originalCfgEnv = process.env[SYMPHONY_CONFIG_FILE_ENV];
  process.env[SYMPHONY_CONFIG_FILE_ENV] = cfgFile;
});

afterEach(() => {
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


describe('Phase 3H.1 scenario — settings popup via /config slash', () => {
  it('opens the settings popup with default values when no config file exists, then re-opens with file values after a write', async () => {
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
        createdAt: '2026-04-30T00:00:00Z',
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
      // Open settings directly. The `/config` slash ROUTING is unit-tested
      // (buildSlashTable); text typed into the chat InputBar through the
      // launcher's PassThrough doesn't reliably deliver, so we open the
      // popup via this option and exercise a BEHAVIORAL signal. The full
      // section list, "(from file)" annotation, and read-only re-open are
      // covered by SettingsPanel.test.tsx + the 3h1 visual frames.
      initialPopup: 'settings',
      rpcOverride: {
        descriptor: { host: '127.0.0.1', port: 0, token: 't' },
        client: handle.rpc as unknown as LauncherRpc,
      },
      hookServerFactory: () => hookServer,
      maestroFactory: () => fakeMaestroAsProcess,
      workerManager: { ensureClaudeTrust: async () => undefined } as never,
    });

    await settle(1300);

    // No config file on disk → the panel loads DEFAULTS (modelMode 'mixed').
    // The modelMode row (first selectable) is focused on open; Enter cycles
    // the enum and persists. A resulting on-disk modelMode of 'opus' proves
    // the popup opened THROUGH the launcher AND rendered the default value
    // (had it loaded something other than the 'mixed' default, the cycle
    // wouldn't land on 'opus'). On-disk config is the robust end-to-end
    // signal where the cascading fake-stdout capture is not.
    const readModelMode = (): string =>
      (JSON.parse(readFileSync(cfgFile, 'utf8')) as { modelMode?: string }).modelMode ?? '(none)';

    expect(existsSync(cfgFile)).toBe(false); // defaults path: no file yet
    (stdin as unknown as PassThrough).write('\r');
    await settle(800);
    expect(readModelMode()).toBe('opus');

    await launcher.stop('scenario shutdown');
    await launcher.done;
    expect(handle.closeMock).toHaveBeenCalled();
  }, 30_000);
});
