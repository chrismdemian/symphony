/**
 * Phase 3N.2 production scenario — session totals segment through the
 * launcher.
 *
 * Drives `runStart` end-to-end with a fake RPC whose `stats.session()`
 * starts at zero and flips to non-zero between polls. Verifies:
 *   1. Initial state: status bar has NO `↑ … · $…` segment.
 *   2. After the fake totals become non-zero, the next poll cycle
 *      surfaces the segment in stdout with the formatted token + cost
 *      values from `formatTokenCount` + `formatCostUsd`.
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
  sandbox = mkdtempSync(join(tmpdir(), 'symphony-3n2-scenario-'));
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
  totalsRef: { current: SessionTotals },
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
        // Returns the current ref-tracked totals so the test can flip
        // them mid-run and observe the next poll surface them.
        session: vi.fn(async () => totalsRef.current),
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

describe('Phase 3N.2 scenario — session totals segment through the launcher', () => {
  it('hides segment on splash; surfaces once stats.session returns non-zero', async () => {
    const fakeMaestro = new FakeMaestroProcess();
    const fakeMaestroAsProcess = fakeMaestro as unknown as MaestroProcess;
    Object.defineProperty(fakeMaestroAsProcess, 'events', {
      value: () => fakeMaestro.eventsIter(),
    });

    const projects: ProjectSnapshot[] = [
      {
        id: 'p1',
        name: 'MathScrabble',
        path: '/repos/MathScrabble',
        createdAt: '2026-04-30T00:00:00Z',
      },
    ];
    const workers: WorkerRecordSnapshot[] = [];
    const totalsRef: { current: SessionTotals } = {
      current: {
        totalTokens: 0,
        totalCostUsd: 0,
        workerCount: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    };
    const rpc = makeFakeRpc(projects, workers, totalsRef);

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
      // Settle to first poll cycle. With zero totals, segment is hidden.
      await settle(1300);
      const initialPlain = stripAnsi(stdoutChunks.join(''));
      const initialOccurrences = initialPlain.split('↑').length - 1;
      // Zero occurrences of the segment glyph during splash.
      expect(initialOccurrences).toBe(0);
      expect(initialPlain).not.toMatch(/\$\d/);

      // Flip the fake — next poll will return non-zero totals.
      totalsRef.current = {
        totalTokens: 47_120,
        totalCostUsd: 0.42,
        workerCount: 2,
        cacheReadTokens: 12_000,
        cacheWriteTokens: 100,
      };

      // Wait for the 1s polling tick to fire stats.session again and
      // for the next render to flush.
      await settle(1300);

      const postPlain = stripAnsi(stdoutChunks.join(''));
      // The segment now renders with both formatted values present.
      // Look for the substring across the full transcript — Ink may
      // emit multiple frames; any one of them with the segment counts.
      expect(postPlain).toContain('↑ 47K');
      expect(postPlain).toContain('$0.42');
      // stats.session was called at least twice — once on mount, once
      // after the 1s tick.
      expect((rpc.call.stats.session as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(2);
    } finally {
      await handle.stop();
    }
  }, 30_000);
});
