/**
 * Phase 7C scenario — plugin management through the launcher.
 *
 * Drives `runStart` end-to-end with a fake RPC whose `plugins.list`
 * returns canned `PluginListItem`s. Types `/plugins` into the chat
 * InputBar and asserts the PluginsPanel popup renders the rows, then
 * navigates to a plugin row and toggles it (asserting `plugins.setEnabled`
 * fires over RPC). Mirrors `tests/scenarios/3r.test.ts`.
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
import type { PluginListItem } from '../../src/rpc/router-impl.js';

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
  sandbox = mkdtempSync(join(tmpdir(), 'symphony-7c-scenario-'));
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

const ISO = '2026-06-03T12:00:00.000Z';

function pluginItem(over: Partial<PluginListItem> = {}): PluginListItem {
  return {
    id: over.id ?? 'echo',
    name: over.name ?? 'Echo',
    version: over.version ?? '1.0.0',
    enabled: over.enabled ?? false,
    source: over.source ?? '/repos/echo',
    installedAt: over.installedAt ?? ISO,
    ...over,
  };
}

function makeFakeRpc(opts: { projects: ProjectSnapshot[]; plugins: PluginListItem[] }): FullFakeRpc {
  let pluginList = opts.plugins.map((p) => ({ ...p }));
  const setEnabled = vi.fn(async ({ id, enabled }: { id: string; enabled: boolean }) => {
    pluginList = pluginList.map((p) => (p.id === id ? { ...p, enabled } : p));
    return { id, enabled };
  });
  const install = vi.fn(async ({ source }: { source: string }) => {
    pluginList = [...pluginList, pluginItem({ id: 'installed', name: 'Installed', version: '2.0.0', source })];
    return { id: 'installed', name: 'Installed', version: '2.0.0', reinstall: false };
  });
  const remove = vi.fn(async ({ id }: { id: string }) => {
    pluginList = pluginList.filter((p) => p.id !== id);
    return { id, removedRow: true, removedDir: true };
  });
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
        graph: vi.fn(async () => ({ nodes: [], edges: [], cycles: [] })),
      },
      workers: {
        list: vi.fn(async () => []),
        get: vi.fn(async () => null),
        kill: vi.fn(async () => ({ killed: false })),
        tail: vi.fn(async () => ({ events: [], total: 0 })),
        diff: vi.fn(async () => null),
      },
      questions: {
        list: vi.fn(async () => []),
        get: vi.fn(async () => null),
        answer: vi.fn(async () => null),
      },
      waves: { list: vi.fn(async () => []), get: vi.fn(async () => null) },
      mode: {
        get: vi.fn(async () => ({ mode: 'plan' as const })),
        setModel: vi.fn(async () => ({ modelMode: 'opus' as const, warnings: [] })),
      },
      queue: {
        list: vi.fn(async () => []),
        cancel: vi.fn(async () => ({ cancelled: false, reason: 'not in queue' })),
        reorder: vi.fn(async () => ({ moved: false, reason: 'not in queue' })),
      },
      notifications: { flushAwayDigest: vi.fn(async () => ({ digest: null })) },
      runtime: { setAwayMode: vi.fn(async () => undefined) },
      recovery: {
        report: vi.fn(async () => ({ crashedIds: [], capturedAt: '1970-01-01T00:00:00.000Z' })),
      },
      audit: { list: vi.fn(async () => []), count: vi.fn(async () => 0) },
      plugins: {
        list: vi.fn(async () => pluginList.map((p) => ({ ...p }))),
        setEnabled,
        install,
        remove,
      },
    },
    subscribe: vi.fn(async (topic: string) => ({ topic, unsubscribe: async () => {} })),
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

const baseProjects: ProjectSnapshot[] = [
  { id: 'p1', name: 'MathScrabble', path: '/repos/ms', createdAt: ISO },
];

async function boot(rpc: FullFakeRpc): Promise<{
  handle: Awaited<ReturnType<typeof runStart>>;
  stdin: PassThrough;
  frames: () => string;
}> {
  const fakeMaestro = new FakeMaestroProcess();
  const fakeMaestroAsProcess = fakeMaestro as unknown as MaestroProcess;
  Object.defineProperty(fakeMaestroAsProcess, 'events', {
    value: () => fakeMaestro.eventsIter(),
  });
  const stdin = makeTtyStream(true) as NodeJS.ReadStream;
  const stdout = makeTtyStream(false) as NodeJS.WriteStream;
  const stderr = new PassThrough();
  const stdoutChunks: string[] = [];
  (stdout as unknown as PassThrough).on('data', (c: Buffer) => stdoutChunks.push(c.toString('utf8')));
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
  return {
    handle,
    stdin: stdin as unknown as PassThrough,
    frames: () => stripAnsi(stdoutChunks.join('')),
  };
}

describe('Phase 7C scenario — plugin management through the launcher', () => {
  it('opens the PluginsPanel via /plugins and renders installed plugins', async () => {
    const rpc = makeFakeRpc({
      projects: baseProjects,
      plugins: [
        pluginItem({ id: 'notifier-example', name: 'Notifier', enabled: true }),
        pluginItem({ id: 'echo', name: 'Echo', enabled: false }),
      ],
    });
    const { handle, stdin, frames } = await boot(rpc);
    await settle(800);

    stdin.write('/plugins');
    await settle(80);
    stdin.write('\r');
    await settle(1200);

    expect((rpc.call.plugins.list as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(1);
    const frame = frames();
    expect(frame).toContain('Plugins');
    expect(frame).toContain('master switch');
    expect(frame).toContain('Notifier');
    expect(frame).toContain('Echo');
    expect(frame).toContain('✓ enabled');
    expect(frame).toContain('○ disabled');

    await handle.stop('scenario shutdown');
    await handle.done;
    expect(rpc.close).toHaveBeenCalled();
  }, 30_000);

  it('toggling a plugin row fires plugins.setEnabled over RPC', async () => {
    const rpc = makeFakeRpc({
      projects: baseProjects,
      plugins: [pluginItem({ id: 'echo', name: 'Echo', enabled: false })],
    });
    const { handle, stdin, frames } = await boot(rpc);
    await settle(800);

    stdin.write('/plugins');
    await settle(80);
    stdin.write('\r');
    await settle(800);

    // ↓ from the master row to the first plugin row, then Space to toggle.
    stdin.write('\x1b[B');
    await settle(120);
    stdin.write(' ');
    await settle(800);

    const calls = (rpc.call.plugins.setEnabled as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls[0]?.[0]).toEqual({ id: 'echo', enabled: true });
    expect(frames()).toContain('✓ enabled');

    await handle.stop('scenario shutdown');
    await handle.done;
  }, 30_000);

  it('installing via "i" → source → Enter fires plugins.install over RPC', async () => {
    const rpc = makeFakeRpc({ projects: baseProjects, plugins: [] });
    const { handle, stdin, frames } = await boot(rpc);
    await settle(800);

    stdin.write('/plugins');
    await settle(80);
    stdin.write('\r');
    await settle(800);

    stdin.write('i'); // open install input
    await settle(150);
    stdin.write('./my-plugin'); // type the source (one chunk → appended whole)
    await settle(150);
    stdin.write('\r'); // submit
    await settle(800);

    const calls = (rpc.call.plugins.install as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls[0]?.[0]).toEqual({ source: './my-plugin' });
    expect(frames()).toContain('Installed');

    await handle.stop('scenario shutdown');
    await handle.done;
  }, 30_000);

  it('removing via "x" → Enter fires plugins.remove over RPC', async () => {
    const rpc = makeFakeRpc({
      projects: baseProjects,
      plugins: [pluginItem({ id: 'echo', name: 'Echo', enabled: false })],
    });
    const { handle, stdin, frames } = await boot(rpc);
    await settle(800);

    stdin.write('/plugins');
    await settle(80);
    stdin.write('\r');
    await settle(800);

    stdin.write('\x1b[B'); // ↓ master → Echo
    await settle(120);
    stdin.write('x'); // confirm-remove mode
    await settle(150);
    expect(frames()).toContain('Remove plugin');
    stdin.write('\r'); // confirm
    await settle(800);

    const calls = (rpc.call.plugins.remove as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls[0]?.[0]).toEqual({ id: 'echo' });
    expect(frames()).toContain('No plugins installed');

    await handle.stop('scenario shutdown');
    await handle.done;
  }, 30_000);
});
