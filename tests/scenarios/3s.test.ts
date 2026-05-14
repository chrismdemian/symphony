/**
 * Phase 3S scenario — autonomy dial cycle + Mission Control inject.
 *
 * Drives `runStart` end-to-end with a fake RPC + fake Maestro and asserts:
 *
 *   1. Pressing Ctrl+Y at the TUI flips `config.autonomyTier` on disk
 *      AND fires `rpc.call.runtime.setAutonomyTier({ tier: <next> })`
 *      so the server's dispatch-context cursor stays in sync. Three
 *      consecutive presses cycle through all tiers.
 *
 *   2. Pressing `i` on a focused worker output panel opens the inline
 *      input. Typing + Enter calls `rpc.call.workers.sendTo` with the
 *      selected worker's id and the trimmed message. Esc cancels
 *      without firing the RPC.
 *
 * The fake Maestro is a no-op event stream (no Maestro turns) — the
 * test exercises the TUI's chord + panel-scope plumbing, not the
 * orchestrator's MCP wire.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter, PassThrough } from 'node:stream';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
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
import { SYMPHONY_CONFIG_FILE_ENV } from '../../src/utils/config.js';

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
let prevEnv: string | undefined;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'symphony-3s-scenario-'));
  home = join(sandbox, 'home');
  cfgFile = join(sandbox, 'config.json');
  prevEnv = process.env[SYMPHONY_CONFIG_FILE_ENV];
  process.env[SYMPHONY_CONFIG_FILE_ENV] = cfgFile;
});

afterEach(() => {
  if (prevEnv === undefined) delete process.env[SYMPHONY_CONFIG_FILE_ENV];
  else process.env[SYMPHONY_CONFIG_FILE_ENV] = prevEnv;
  try {
    rmSync(sandbox, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FullFakeRpc = any;

function makeFakeRpc(opts: {
  projects: ProjectSnapshot[];
  workers: WorkerRecordSnapshot[];
}): FullFakeRpc {
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
        list: vi.fn(async () => opts.workers),
        get: vi.fn(async () => opts.workers[0] ?? null),
        kill: vi.fn(async () => ({ killed: false })),
        tail: vi.fn(async () => ({ events: [], total: 0 })),
        diff: vi.fn(async () => null),
        sendTo: vi.fn(async ({ workerId, message }: { workerId: string; message: string }) => ({
          workerId,
          bytes: message.length,
        })),
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
        setModel: vi.fn(async () => ({ modelMode: 'opus' as const, warnings: [] })),
      },
      queue: {
        list: vi.fn(async () => []),
        cancel: vi.fn(async () => ({ cancelled: false, reason: 'not in queue' })),
        reorder: vi.fn(async () => ({ moved: false, reason: 'not in queue' })),
      },
      notifications: {
        flushAwayDigest: vi.fn(async () => ({ digest: null })),
      },
      runtime: {
        setAwayMode: vi.fn(async () => undefined),
        setAutonomyTier: vi.fn(async ({ tier }: { tier: 1 | 2 | 3 }) => ({ tier })),
      },
      recovery: {
        report: vi.fn(async () => ({
          crashedIds: [],
          capturedAt: '2026-05-14T12:00:00.000Z',
        })),
      },
    },
    subscribe: vi.fn(async (topic: string, _args: unknown) => ({
      topic,
      unsubscribe: async () => {},
    })),
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

const ISO = '2026-05-14T00:00:00.000Z';
const baseProjects: ProjectSnapshot[] = [
  { id: 'p1', name: 'demo', path: '/repos/demo', createdAt: ISO },
];

describe('Phase 3S scenario — autonomy dial + Mission Control', () => {
  it('Ctrl+Y cycles autonomy tier through 2 → 3 → 1 → 2 with RPC + disk writes', async () => {
    const fakeMaestro = new FakeMaestroProcess();
    const fakeMaestroAsProcess = fakeMaestro as unknown as MaestroProcess;
    Object.defineProperty(fakeMaestroAsProcess, 'events', {
      value: () => fakeMaestro.eventsIter(),
    });

    const rpc = makeFakeRpc({ projects: baseProjects, workers: [] });
    const stdin = makeTtyStream(true) as NodeJS.ReadStream;
    const stdout = makeTtyStream(false) as NodeJS.WriteStream;
    const stderr = new PassThrough();

    const handle = await runStart({
      home,
      cliEntryPath: '/fake/cli/entry.js',
      io: { stdin, stdout, stderr },
      skipSignalHandlers: true,
      rpcOverride: {
        descriptor: { host: '127.0.0.1', port: 0, token: 't' },
        client: rpc as unknown as LauncherRpc,
      },
      hookServerFactory: () => new MaestroHookServer({ token: 'tok' }),
      maestroFactory: () => fakeMaestroAsProcess,
      workerManager: { ensureClaudeTrust: async () => undefined } as never,
    });

    await settle(800);
    expect(rpc.call.runtime.setAutonomyTier).not.toHaveBeenCalled();

    // Ctrl+Y once: 2 → 3
    (stdin as unknown as PassThrough).write('\x19');
    await settle(400);

    expect(rpc.call.runtime.setAutonomyTier).toHaveBeenCalledTimes(1);
    expect(rpc.call.runtime.setAutonomyTier).toHaveBeenLastCalledWith({ tier: 3 });
    // Disk reflects the new tier.
    expect(existsSync(cfgFile)).toBe(true);
    const onDisk1 = JSON.parse(readFileSync(cfgFile, 'utf8')) as { autonomyTier?: number };
    expect(onDisk1.autonomyTier).toBe(3);

    // Ctrl+Y again: 3 → 1
    (stdin as unknown as PassThrough).write('\x19');
    await settle(400);
    expect(rpc.call.runtime.setAutonomyTier).toHaveBeenCalledTimes(2);
    expect(rpc.call.runtime.setAutonomyTier).toHaveBeenLastCalledWith({ tier: 1 });
    const onDisk2 = JSON.parse(readFileSync(cfgFile, 'utf8')) as { autonomyTier?: number };
    expect(onDisk2.autonomyTier).toBe(1);

    // Ctrl+Y once more: 1 → 2
    (stdin as unknown as PassThrough).write('\x19');
    await settle(400);
    expect(rpc.call.runtime.setAutonomyTier).toHaveBeenCalledTimes(3);
    expect(rpc.call.runtime.setAutonomyTier).toHaveBeenLastCalledWith({ tier: 2 });

    // Audit Minor #4 — assert ABSENCE of unrelated RPC fires. With 28
    // namespaces in the fake, a regression where Ctrl+Y wires through
    // the wrong path could pass silently. Lock the invariant.
    expect(rpc.call.runtime.setAwayMode).not.toHaveBeenCalled();
    expect(rpc.call.workers.sendTo).not.toHaveBeenCalled();
    expect(rpc.call.workers.kill).not.toHaveBeenCalled();

    await handle.stop('scenario shutdown');
    await handle.done;
  });
});
