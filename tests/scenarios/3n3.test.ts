/**
 * Phase 3N.3 production scenario — `/stats` popup through the launcher.
 *
 * Drives `runStart` end-to-end with a fake RPC providing the `stats`
 * namespace. Verifies:
 *   1. Initial state: no `/stats` popup visible.
 *   2. Typing `/stats` + Enter pushes the popup; the launcher's render
 *      stream contains the panel chrome ("Session statistics", "By
 *      project", "Recent workers") + at least one project row.
 *   3. The fake RPC's `stats.byProject`/`byWorker`/`session` are each
 *      called as a result of the popup mount.
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
import type {
  StatsByProjectRow,
  StatsByWorkerRow,
} from '../../src/rpc/router-impl.js';
import type { SessionTotals } from '../../src/orchestrator/session-totals.js';

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
  sandbox = mkdtempSync(join(tmpdir(), 'symphony-3n3-scenario-'));
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
  statsResponses: {
    session: SessionTotals;
    byProject: readonly StatsByProjectRow[];
    byWorker: readonly StatsByWorkerRow[];
  },
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
        list: vi.fn(async () => []),
        cancel: vi.fn(async () => ({ cancelled: false })),
        reorder: vi.fn(async () => ({ moved: false })),
      },
      notifications: {
        flushAwayDigest: vi.fn(async () => ({ digest: null })),
      },
      runtime: {
        setAwayMode: vi.fn(async (args: { awayMode: boolean }) => ({ awayMode: args.awayMode })),
      },
      stats: {
        session: vi.fn(async () => statsResponses.session),
        byProject: vi.fn(async () => statsResponses.byProject),
        byWorker: vi.fn(async () => statsResponses.byWorker),
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

describe('Phase 3N.3 scenario — /stats popup through the launcher', () => {
  it('typing /stats pushes the popup and the panel hits all three stats procedures', async () => {
    const fakeMaestro = new FakeMaestroProcess();
    const fakeMaestroAsProcess = fakeMaestro as unknown as MaestroProcess;
    Object.defineProperty(fakeMaestroAsProcess, 'events', {
      value: () => fakeMaestro.eventsIter(),
    });

    const projects: ProjectSnapshot[] = [
      {
        id: 'p1',
        name: 'symphony',
        path: '/repos/symphony',
        createdAt: '2026-04-30T00:00:00Z',
      },
    ];
    const workers: WorkerRecordSnapshot[] = [];
    const statsResponses = {
      session: {
        totalTokens: 47_000,
        totalCostUsd: 0.42,
        workerCount: 2,
        cacheReadTokens: 12_000,
        cacheWriteTokens: 100,
      },
      byProject: [
        {
          projectId: 'p1',
          projectName: 'symphony',
          workerCount: 2,
          totalTokens: 47_000,
          totalCostUsd: 0.42,
          cacheReadTokens: 12_000,
          cacheWriteTokens: 100,
        },
      ] as readonly StatsByProjectRow[],
      byWorker: [
        {
          workerId: 'wk-1',
          projectId: 'p1',
          projectName: 'symphony',
          featureIntent: 'token-tracking',
          role: 'implementer',
          status: 'completed',
          createdAt: '2026-05-11T12:00:00.000Z',
          completedAt: '2026-05-11T12:01:30.000Z',
          costUsd: 0.42,
          inputTokens: 40_000,
          outputTokens: 7_000,
          cacheReadTokens: 12_000,
          cacheWriteTokens: 100,
        },
      ] as readonly StatsByWorkerRow[],
    };
    const rpc = makeFakeRpc(projects, workers, statsResponses);

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

    try {
      // Settle initial mount.
      await settle(1300);
      const initialPlain = stripAnsi(stdoutChunks.join(''));
      // No stats popup yet.
      expect(initialPlain).not.toContain('Session statistics');

      // Reset stdoutChunks so the assertion window is post-/stats.
      stdoutChunks.length = 0;

      // Type `/stats` + Enter to open the popup. Per 3J known gotcha:
      // ink parses multi-char stdin chunks as paste insert; CR inside a
      // chunk lands as a literal newline. Split into 6 char + 1 enter.
      stdin.write('/stats');
      await settle(50);
      stdin.write('\r');
      // Wait for: handle slash → pushPopup → mount StatsPanel → poll
      // resolves → re-render.
      await settle(1500);

      const postPlain = stripAnsi(stdoutChunks.join(''));
      // Panel chrome present.
      expect(postPlain).toContain('Session statistics');
      expect(postPlain).toContain('By project');
      expect(postPlain).toContain('Recent workers');
      // Project row content visible.
      expect(postPlain).toContain('symphony');
      // Token + cost from the headline visible somewhere in stream.
      expect(postPlain).toContain('47K');
      expect(postPlain).toContain('$0.42');

      // All three procedures were called.
      const { stats } = rpc.call;
      expect((stats.session as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(1);
      expect((stats.byProject as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(1);
      expect((stats.byWorker as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(1);
    } finally {
      await handle.stop();
    }
  }, 30_000);
});
