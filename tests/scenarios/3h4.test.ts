/**
 * Phase 3H.4 scenario — keybind override editor end-to-end.
 *
 * Mirrors the 3H.3 scenario shape (FakeMaestroProcess, makeFakeRpc,
 * makeTtyStream, runStart launcher). Drives:
 *   /config → arrow nav → Enter (keybindOverrides row) → Enter on a
 *   command row → press F → assert disk override → press r → assert
 *   disk reset → Esc Esc → exit.
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
  sandbox = mkdtempSync(join(tmpdir(), 'symphony-3h4-scenario-'));
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
const DOWN = '\x1b[B';
const UP = '\x1b[A';

describe('Phase 3H.4 scenario — keybind override editor end-to-end', () => {
  it(
    'opens editor, captures new chord for app.help, persists, then resets',
    async () => {
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

      // ── Open settings popup via /config slash command ─────────────────
      (stdin as unknown as PassThrough).write('/config');
      await settle(300);
      (stdin as unknown as PassThrough).write('\r');
      await settle(1200);

      {
        const recent = stdoutChunks.slice(-200).join('');
        const plain = stripAnsi(recent);
        expect(plain).toContain('Settings');
        expect(plain).toContain('keybindOverrides');
      }

      // ── Navigate to keybindOverrides (last value row).
      // Value rows in order:
      //   0. modelMode
      //   1. maxConcurrentWorkers
      //   2. theme.name
      //   3. theme.autoFallback16Color
      //   4. notifications.enabled
      //   5. awayMode
      //   6. defaultProjectPath
      //   7. leaderTimeoutMs
      //   8. schemaVersion
      //   9. keybindOverrides ← target
      // 9 down arrows from default selection (modelMode at index 0).
      for (let i = 0; i < 9; i += 1) {
        (stdin as unknown as PassThrough).write(DOWN);
        await settle(80);
      }

      // ── Enter pushes the keybind-list popup.
      (stdin as unknown as PassThrough).write('\r');
      await settle(800);

      {
        const recent = stdoutChunks.slice(-200).join('');
        const plain = stripAnsi(recent);
        expect(plain).toContain('Keybind editor');
        expect(plain).toContain('help');
        expect(plain).toContain('?');
      }

      // ── Navigate to the `help` command row (`app.help`). The list
      // is sorted by scope then title. The first row at this point
      // depends on the actual command set; we navigate down until
      // selection lands on `help`. To avoid flakiness, use the row
      // sort (global → main → specific), and 'help' is in 'main' scope
      // (Phase 3F.1 migrated app.help to main). Other 'main' commands:
      // 'questions' / 'select worker'. So 'help' would be after
      // global cmds + before/after questions/select. Easier: just
      // navigate down step by step and check via frame contents that
      // we eventually pick the right row by detecting `▸ help`.
      let foundHelp = false;
      for (let attempt = 0; attempt < 30 && !foundHelp; attempt += 1) {
        const recent = stdoutChunks.slice(-200).join('');
        const plain = stripAnsi(recent);
        if (/▸\s+help\b/.test(plain)) {
          foundHelp = true;
          break;
        }
        (stdin as unknown as PassThrough).write(DOWN);
        await settle(80);
      }
      expect(foundHelp).toBe(true);

      // ── Enter arms capture mode.
      (stdin as unknown as PassThrough).write('\r');
      await settle(500);
      {
        const recent = stdoutChunks.slice(-200).join('');
        const plain = stripAnsi(recent);
        expect(plain).toContain('Capture key');
      }

      // ── Press 'F' — captures `{kind:'char', char:'F'}`. No conflicts
      // (no other command binds 'F'). Commit + write to disk.
      (stdin as unknown as PassThrough).write('F');
      await settle(1200);

      {
        const onDisk = JSON.parse(readFileSync(cfgFile, 'utf8')) as Record<string, unknown>;
        const overrides = onDisk['keybindOverrides'] as Record<string, unknown> | undefined;
        expect(overrides).toBeDefined();
        expect(overrides?.['app.help']).toEqual({ kind: 'char', char: 'F' });
      }

      // ── Editor returned to list mode, help row now shows F + (override).
      // Navigate until ▸ help renders, then assert the row content.
      let postCommitHelpFound = false;
      for (let attempt = 0; attempt < 30 && !postCommitHelpFound; attempt += 1) {
        const recent = stdoutChunks.slice(-300).join('');
        const plain = stripAnsi(recent);
        if (/▸\s+help\b.*\bF\b.*\(override\)/.test(plain)) {
          postCommitHelpFound = true;
          break;
        }
        // The capture popup auto-popped, returning to list mode with
        // selection on the help row. If our regex doesn't see it yet,
        // a small jiggle (UP/DOWN) re-renders.
        (stdin as unknown as PassThrough).write(UP);
        await settle(60);
        (stdin as unknown as PassThrough).write(DOWN);
        await settle(60);
      }
      expect(postCommitHelpFound).toBe(true);

      // ── Press 'r' to reset.
      (stdin as unknown as PassThrough).write('r');
      await settle(1200);

      {
        const onDisk = JSON.parse(readFileSync(cfgFile, 'utf8')) as Record<string, unknown>;
        const overrides = onDisk['keybindOverrides'] as Record<string, unknown> | undefined;
        // After reset, the entry is gone.
        expect(overrides ?? {}).toEqual({});
      }

      // ── Esc closes editor → back to settings popup.
      (stdin as unknown as PassThrough).write(ESC);
      await settle(400);
      {
        const recent = stdoutChunks.slice(-200).join('');
        const plain = stripAnsi(recent);
        expect(plain).toContain('Settings');
      }

      // ── Esc closes settings → back to chat.
      (stdin as unknown as PassThrough).write(ESC);
      await settle(400);
      {
        const recent = stdoutChunks.slice(-200).join('');
        const plain = stripAnsi(recent);
        expect(plain).toContain('Tell Maestro what to do');
      }

      await launcher.stop('test-shutdown');
      await launcher.done;
      expect(handle.closeMock).toHaveBeenCalled();
    },
    60_000,
  );
});
