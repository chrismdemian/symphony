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
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
      rpcOverride: {
        descriptor: { host: '127.0.0.1', port: 0, token: 't' },
        client: handle.rpc as unknown as LauncherRpc,
      },
      hookServerFactory: () => hookServer,
      maestroFactory: () => fakeMaestroAsProcess,
      workerManager: { ensureClaudeTrust: async () => undefined } as never,
    });

    await settle(1300);

    // ── Phase 1: no config file → defaults ─────────────────────────────
    // Type the slash command, settle so InputBar registers the chars,
    // then send Enter separately. ink-testing-library's stdin can
    // batch the chunks unhelpfully when text + \r are written together,
    // and the chat panel's InputBar may not see the \r until a render
    // cycle has flushed.
    (stdin as unknown as PassThrough).write('/config');
    await settle(300);
    (stdin as unknown as PassThrough).write('\r');
    await settle(1200);
    {
      const recent = stdoutChunks.slice(-200).join('');
      const plain = stripAnsi(recent);
      expect(plain).toContain('Settings');
      // Phase 3H.2 changed the header label from "Phase 3H.1
      // (read-only)" → "Phase 3H.2" when the editable popup shipped.
      // The 3H.1 scenario validates the open/close contract via the
      // slash command, NOT the version-string label.
      expect(plain).toContain('Phase 3H.');
      // Section headers in document order.
      expect(plain).toContain('Model');
      expect(plain).toContain('Workers');
      expect(plain).toContain('Appearance');
      expect(plain).toContain('Notifications');
      expect(plain).toContain('Project');
      expect(plain).toContain('Advanced');
      // Default values.
      expect(plain).toContain('mixed');
      expect(plain).toContain('symphony');
      // Source line in the "no file" variant.
      expect(plain).toContain('(no file');
    }

    const beforeEscLength = stdoutChunks.length;
    (stdin as unknown as PassThrough).write(ESC);
    await settle(400);
    {
      const post = stdoutChunks.slice(beforeEscLength).join('');
      const plain = stripAnsi(post);
      expect(plain).toContain('Tell Maestro what to do');
    }

    // ── Phase 2: write a config file → re-open → file values ──────────
    writeFileSync(
      cfgFile,
      JSON.stringify({ schemaVersion: 1, modelMode: 'opus', maxConcurrentWorkers: 8 }, null, 2),
      'utf8',
    );

    const beforeReopen = stdoutChunks.length;
    (stdin as unknown as PassThrough).write('/config');
    await settle(300);
    (stdin as unknown as PassThrough).write('\r');
    await settle(1200);
    {
      const post = stdoutChunks.slice(beforeReopen).join('');
      const plain = stripAnsi(post);
      // The popup must re-render with the file's values. We assert
      // the customized values appear AND the (from file) annotation
      // is present somewhere in the popup body.
      expect(plain).toContain('opus');
      expect(plain).toContain('(from file)');
    }

    await launcher.stop('scenario shutdown');
    await launcher.done;
    expect(handle.closeMock).toHaveBeenCalled();
  }, 30_000);
});
