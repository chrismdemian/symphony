/**
 * Phase 3A scenario test — TUI launcher integration.
 *
 * See `tests/scenarios/3a.md` for the Given / When / Then.
 *
 * Same harness pattern as `tests/cli/start.unit.test.ts` (FakeMaestroProcess
 * + makeFakeRpc), but with a TTY-flagged stdout so the TUI engagement
 * path runs end-to-end through Ink's render. The unit suite covers the
 * readline fallback (PassThrough has `isTTY === undefined`); this scenario
 * proves the new TUI path is wired up correctly.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter, PassThrough } from 'node:stream';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runStart } from '../../src/cli/start.js';
import { MaestroHookServer } from '../../src/orchestrator/maestro/hook-server.js';
import type {
  HookPayload,
  MaestroProcess,
  MaestroEvent,
  MaestroStartInput,
  MaestroStartResult,
} from '../../src/orchestrator/maestro/index.js';
import type { LauncherRpc } from '../../src/cli/start.js';
import type { ProjectSnapshot } from '../../src/projects/types.js';

class FakeMaestroProcess {
  readonly emitter = new EventEmitter();
  startInput: MaestroStartInput | undefined;
  startCount = 0;
  killCount = 0;
  injectIdleCount = 0;

  async start(input: MaestroStartInput): Promise<MaestroStartResult> {
    this.startCount += 1;
    this.startInput = input;
    return {
      workspace: { cwd: '/fake/cwd', claudeMdPath: '/fake/cwd/CLAUDE.md' },
      session: {
        sessionId: 'fake-session',
        mode: 'fresh',
        reason: 'missing',
      },
      mcpConfigPath: '/fake/cwd/.symphony-mcp.json',
      systemInit: { sessionId: 'fake-session-uuid-1234' },
    } as unknown as MaestroStartResult;
  }

  injectIdle(payload: HookPayload): void {
    this.injectIdleCount += 1;
    queueMicrotask(() => this.emitter.emit('event', { type: 'idle', payload } as MaestroEvent));
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
  sandbox = mkdtempSync(join(tmpdir(), 'symphony-3a-scenario-'));
  home = join(sandbox, 'home');
});

afterEach(() => {
  try {
    rmSync(sandbox, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

// Untyped — the production cast at the runStart seam is `as unknown as
// LauncherRpc`, so we replicate that pattern in the test rather than
// fight `vi.fn`'s mock-type inference.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FullFakeRpc = any;

function makeFakeRpc(projects: ProjectSnapshot[]): FullFakeRpc {
  return {
    call: {
      projects: {
        list: vi.fn(async () => projects),
        get: vi.fn(async () => null),
        register: vi.fn(async () => {
          throw new Error('unused in test');
        }),
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
  // Ink calls these on stdin during render setup.
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

describe('Phase 3A scenario — TUI launcher integration', () => {
  it('engages the Ink TUI when stdout is a TTY, then tears down cleanly on stop()', async () => {
    const fakeMaestro = new FakeMaestroProcess();
    const fakeMaestroAsProcess = fakeMaestro as unknown as MaestroProcess;
    Object.defineProperty(fakeMaestroAsProcess, 'events', {
      value: () => fakeMaestro.eventsIter(),
    });
    const projects: ProjectSnapshot[] = [
      { id: 'p1', name: 'demo', path: '/repos/demo', createdAt: '2026-04-29T00:00:00Z' },
    ];
    const rpc = makeFakeRpc(projects);

    const stdin = makeTtyStream(true) as NodeJS.ReadStream;
    const stdout = makeTtyStream(false) as NodeJS.WriteStream;
    const stderr = new PassThrough();

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
      // Override workerManager so the default factory doesn't try to read ~/.claude.json
      workerManager: { ensureClaudeTrust: async () => undefined } as never,
    });

    expect(fakeMaestro.startCount).toBe(1);

    // Hook installed in workspace.
    const settingsPath = join(home, '.symphony', 'maestro', '.claude', 'settings.local.json');
    expect(existsSync(settingsPath)).toBe(true);
    expect(readFileSync(settingsPath, 'utf8')).toContain('SYMPHONY_HOOK_PORT');

    // RPC was called for projects.list (Phase 1) and the TUI's data hooks.
    expect(rpc.call.projects.list).toHaveBeenCalled();

    // Allow Ink microtasks to settle (data hooks fire useEffect after first paint).
    await new Promise((r) => setImmediate(r));

    // Tear down via stop() — same path Ctrl+C takes through the Ink keybind.
    await handle.stop('scenario shutdown');
    await handle.done;

    // Hook uninstalled.
    expect(readFileSync(settingsPath, 'utf8')).not.toContain('SYMPHONY_HOOK_PORT');
    // Maestro killed once.
    expect(fakeMaestro.killCount).toBe(1);
    // RPC client closed.
    expect(rpc.close).toHaveBeenCalled();
  }, 30_000);

  it('keeps using readline fallback when stdout is non-TTY (regression — 2C.2 path)', async () => {
    const fakeMaestro = new FakeMaestroProcess();
    const fakeMaestroAsProcess = fakeMaestro as unknown as MaestroProcess;
    Object.defineProperty(fakeMaestroAsProcess, 'events', {
      value: () => fakeMaestro.eventsIter(),
    });
    const rpc = makeFakeRpc([]);

    // Plain PassThrough = no isTTY → falls back to readline.
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();

    const hookServer = new MaestroHookServer({ token: 'tok' });
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

    expect(fakeMaestro.startCount).toBe(1);

    // The launcher's `log()` writes "non-TTY stdout detected" to stderr in
    // the readline-fallback branch. Drain stderr to assert the fallback ran.
    const collected: string[] = [];
    stderr.on('data', (chunk: Buffer) => collected.push(chunk.toString('utf8')));
    await new Promise((r) => setImmediate(r));

    await handle.stop('scenario shutdown');
    await handle.done;

    const stderrText = collected.join('');
    expect(stderrText).toContain('non-TTY stdio detected');
    expect(fakeMaestro.killCount).toBe(1);
  }, 15_000);
});
