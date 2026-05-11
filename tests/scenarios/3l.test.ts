/**
 * Phase 3L scenario — task queue panel through the launcher.
 *
 * Drives `runStart` end-to-end with a fake RPC whose `queue.list`
 * returns three pending entries across two projects. Verifies the
 * panel renders the header + numbered rows + "Next →" marker, and
 * that pressing X on a selected queue row fires `queue.cancel` with
 * the right recordId.
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
import type { PendingSpawnSnapshot } from '../../src/rpc/router-impl.js';

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
  sandbox = mkdtempSync(join(tmpdir(), 'symphony-3l-scenario-'));
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

function makeFakeRpc(
  projects: ProjectSnapshot[],
  workers: readonly WorkerRecordSnapshot[],
  getPending: () => readonly PendingSpawnSnapshot[],
  recordCancel: (recordId: string) => void,
): FullFakeRpc {
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
        list: vi.fn(async () => workers),
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
        list: vi.fn(async () => getPending()),
        cancel: vi.fn(async (args: { recordId: string }) => {
          recordCancel(args.recordId);
          return { cancelled: true };
        }),
        reorder: vi.fn(async () => ({ moved: true })),
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
  stream.columns = 140;
  stream.rows = 40;
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

describe('Phase 3L scenario — task queue panel through the launcher', () => {
  it('renders queue rows from queue.list and cancels a selected entry on X', async () => {
    const fakeMaestro = new FakeMaestroProcess();
    const fakeMaestroAsProcess = fakeMaestro as unknown as MaestroProcess;
    Object.defineProperty(fakeMaestroAsProcess, 'events', {
      value: () => fakeMaestro.eventsIter(),
    });

    const projects: ProjectSnapshot[] = [
      { id: 'p1', name: 'MathScrabble', path: '/repos/MathScrabble', createdAt: '2026-04-30T00:00:00Z' },
      { id: 'p2', name: 'CRE Pipeline', path: '/repos/CRE Pipeline', createdAt: '2026-04-30T00:00:00Z' },
    ];
    const workers: WorkerRecordSnapshot[] = [
      {
        id: 'wk-1',
        projectPath: '/repos/MathScrabble',
        worktreePath: '/repos/MathScrabble/.symphony/worktrees/wk-1',
        role: 'implementer',
        featureIntent: 'work in progress',
        taskDescription: 'work',
        autonomyTier: 1,
        dependsOn: [],
        status: 'running',
        createdAt: new Date(Date.now() - 60_000).toISOString(),
      },
    ];
    let pending: PendingSpawnSnapshot[] = [
      {
        recordId: 'r1',
        projectPath: '/repos/MathScrabble',
        featureIntent: 'add filters',
        taskDescription: 'add filters',
        enqueuedAt: 1000,
      },
      {
        recordId: 'r2',
        projectPath: '/repos/CRE Pipeline',
        featureIntent: 'fix scraper timeout',
        taskDescription: 'fix scraper timeout',
        enqueuedAt: 1100,
      },
      {
        recordId: 'r3',
        projectPath: '/repos/MathScrabble',
        featureIntent: 'update auth',
        taskDescription: 'update auth',
        enqueuedAt: 1200,
      },
    ];
    const cancelledIds: string[] = [];
    const rpc = makeFakeRpc(
      projects,
      workers,
      () => pending,
      (recordId) => {
        cancelledIds.push(recordId);
        // Simulate server-side drop on cancel so the next poll reflects it.
        pending = pending.filter((p) => p.recordId !== recordId);
      },
    );

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

    // Wait for the first poll cycle (workers + queue).
    await settle(1300);
    const initialFrame = stripAnsi(stdoutChunks.join(''));
    expect(initialFrame).toContain('Workers');
    expect(initialFrame).toContain('Queue');
    expect(initialFrame).toContain('(3 pending)');
    expect(initialFrame).toContain('Next →');
    expect(initialFrame).toContain('add filters');
    expect(initialFrame).toContain('fix scraper timeout');
    expect(initialFrame).toContain('update auth');
    expect(initialFrame).toContain('(MathScrabble)');
    expect(initialFrame).toContain('(CRE Pipeline)');

    // queue.list must have been polled at least once.
    const queueListCalls = (rpc.call.queue.list as ReturnType<typeof vi.fn>).mock.calls;
    expect(queueListCalls.length).toBeGreaterThanOrEqual(1);

    // Navigate to the queue: Tab to focus workers panel; reconcile
    // pre-selects worker wk-1; j → queue-header; j → r1 row.
    stdin.write('\t');
    await settle(50);
    stdin.write('j');
    await settle(50);
    stdin.write('j');
    await settle(50);
    // Cancel the selected queued task.
    stdin.write('X');
    // Allow the RPC + state flow to settle, then the next poll picks up
    // the post-cancel pending list (now 2 entries).
    await settle(1300);

    expect(cancelledIds).toEqual(['r1']);
    const finalFrame = stripAnsi(stdoutChunks.join(''));
    // The queue header reflects the new count somewhere in the
    // accumulated stdout (multiple frames stitched together).
    expect(finalFrame).toContain('(2 pending)');
    // Success toast surfaces the cancelled intent.
    expect(finalFrame).toContain('cancelled queued: add filters');

    await handle.stop('scenario shutdown');
    await handle.done;
    expect(rpc.close).toHaveBeenCalled();
  }, 30_000);
});
