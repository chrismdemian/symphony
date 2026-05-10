/**
 * Phase 3F.1 scenario — palette + help + worker selector via the launcher.
 *
 * Boots the launcher with a fake Maestro and a fake RPC. Drives all
 * three new popups (palette, help, worker-select) through Ink's stdin
 * and asserts the rendered stdout reflects each transition.
 *
 * Mirrors `tests/scenarios/3e.test.ts` exactly — same FakeMaestro, same
 * makeTtyStream, same launcher boot. Differs in:
 *   - workers RPC returns 2 records so `Workers: 2` lights up and
 *     Ctrl+W is enabled.
 *   - questions RPC stays empty.
 *   - keystrokes drive Ctrl+P / `?` / Ctrl+W.
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
  sandbox = mkdtempSync(join(tmpdir(), 'symphony-3f1-scenario-'));
  home = join(sandbox, 'home');
});

afterEach(() => {
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

function makeFakeRpc(
  projects: ProjectSnapshot[],
  workers: WorkerRecordSnapshot[],
): FakeRpcHandle {
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
        list: vi.fn(async () => workers),
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
        flushAwayDigest: vi.fn(async () => undefined),
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

const CTRL_P = '\x10';
const CTRL_W = '\x17';
const ESC = '\x1b';

function makeWorker(over: Partial<WorkerRecordSnapshot>): WorkerRecordSnapshot {
  return {
    id: over.id ?? 'w-1',
    projectPath: '/repos/demo',
    worktreePath: `/repos/demo/.symphony/worktrees/${over.id ?? 'w-1'}`,
    role: 'implementer',
    featureIntent: over.featureIntent ?? 'demo work',
    taskDescription: 'task',
    autonomyTier: 1,
    dependsOn: [],
    status: 'running',
    createdAt: '2026-05-04T00:00:00.000Z',
    ...over,
  } as WorkerRecordSnapshot;
}

describe('Phase 3F.1 scenario — palette/help/worker-select via launcher', () => {
  it('Ctrl+P opens palette, types filter, Esc closes', async () => {
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
    const workers = [
      makeWorker({ id: 'w-1', featureIntent: 'frontend redesign' }),
      makeWorker({ id: 'w-2', featureIntent: 'api refactor' }),
    ];
    const handle = makeFakeRpc(projects, workers);

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

    // Initial settle.
    await settle(1300);
    {
      const plain = stripAnsi(stdoutChunks.join(''));
      expect(plain).toMatch(/Workers:\s*2/);
    }

    // Ctrl+P → palette opens.
    (stdin as unknown as PassThrough).write(CTRL_P);
    await settle(400);
    {
      const recent = stdoutChunks.slice(-30).join('');
      const plain = stripAnsi(recent);
      expect(plain).toContain('Command palette');
      // Bottom hint includes Esc/Enter row.
      expect(plain).toMatch(/Esc to close/);
    }

    // Type 'next' to filter.
    (stdin as unknown as PassThrough).write('next');
    await settle(300);
    {
      const recent = stdoutChunks.slice(-30).join('');
      const plain = stripAnsi(recent);
      expect(plain).toContain('next panel');
      // Filter narrowed the list — header shows "1 of 7" with one match.
      expect(plain).toMatch(/Command palette · 1 of/);
    }

    // Mark the boundary so we can assert against frames produced
    // AFTER the Esc, not against the palette frames still in the
    // accumulated chunk log.
    const beforeEscLength = stdoutChunks.length;
    (stdin as unknown as PassThrough).write(ESC);
    await settle(400);
    {
      const post = stdoutChunks.slice(beforeEscLength).join('');
      const plain = stripAnsi(post);
      // After Esc, the chat panel's input placeholder is rendered —
      // proves the popup unmounted and the main split is back.
      expect(plain).toContain('Tell Maestro what to do');
    }

    await launcher.stop('scenario shutdown');
    await launcher.done;
    expect(handle.closeMock).toHaveBeenCalled();
  }, 30_000);

  it('Ctrl+W → filter → Enter selects worker AND switches focus to workers panel (audit M2)', async () => {
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
    const workers = [
      makeWorker({ id: 'w-1', featureIntent: 'frontend redesign' }),
      makeWorker({ id: 'w-target', featureIntent: 'rest endpoint refactor' }),
    ];
    const handle = makeFakeRpc(projects, workers);

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

    // Ctrl+W opens the worker selector.
    (stdin as unknown as PassThrough).write(CTRL_W);
    await settle(400);
    {
      const recent = stdoutChunks.slice(-30).join('');
      const plain = stripAnsi(recent);
      expect(plain).toContain('Select worker');
    }

    // Type 'rest' to filter to the target worker.
    const beforeFilterLength = stdoutChunks.length;
    (stdin as unknown as PassThrough).write('rest');
    await settle(400);
    {
      const post = stdoutChunks.slice(beforeFilterLength).join('');
      const plain = stripAnsi(post);
      expect(plain).toContain('rest endpoint refactor');
    }

    // Enter selects + switches focus to the workers panel atomically.
    const beforeEnterLength = stdoutChunks.length;
    (stdin as unknown as PassThrough).write('\r');
    // Worker selector unmount + panel re-render takes a few render
    // cycles. 800ms covers the slowest CI machine.
    await settle(800);
    {
      const post = stdoutChunks.slice(beforeEnterLength).join('');
      const plain = stripAnsi(post);
      // Bottom keybind bar should now show workers-scope commands —
      // `j: next`, `k: prev`, `Enter: collapse`, `K: kill`. If the
      // popPopup + setMain race fired (audit M2), the bar would
      // continue to show chat-scope commands instead.
      expect(plain).toMatch(/j:\s*next|kill/);
    }

    await launcher.stop('scenario shutdown');
    await launcher.done;
  }, 30_000);

  it('? opens help overlay; Ctrl+W opens worker selector', async () => {
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
    const workers = [
      makeWorker({ id: 'w-1', featureIntent: 'frontend redesign' }),
      makeWorker({ id: 'w-2', featureIntent: 'api refactor' }),
    ];
    const handle = makeFakeRpc(projects, workers);

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

    // `?` opens the help overlay (main-scope command — chat is the
    // active main panel, so the dispatcher fires it).
    (stdin as unknown as PassThrough).write('?');
    await settle(400);
    {
      const recent = stdoutChunks.slice(-40).join('');
      const plain = stripAnsi(recent);
      expect(plain).toContain('Help · keybinds');
      expect(plain).toContain('Global');
    }

    // Esc closes help.
    (stdin as unknown as PassThrough).write(ESC);
    await settle(400);

    // Ctrl+W opens worker selector.
    (stdin as unknown as PassThrough).write(CTRL_W);
    await settle(400);
    {
      const recent = stdoutChunks.slice(-30).join('');
      const plain = stripAnsi(recent);
      expect(plain).toContain('Select worker');
      expect(plain).toContain('frontend redesign');
    }

    await launcher.stop('scenario shutdown');
    await launcher.done;
  }, 30_000);
});
