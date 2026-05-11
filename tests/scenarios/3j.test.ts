/**
 * Phase 3J scenario — diff preview through the launcher.
 *
 * Drives `runStart` end-to-end with a fake RPC whose `workers.diff`
 * returns a canned diff result. After mount, presses `D` (the toggle)
 * via stdin and verifies the diff header + colorized lines appear in
 * stdout. Then presses `D` again to verify the view returns to streaming
 * output mode.
 *
 * Status: Symphony's launcher's stdin path drives Ink's `useInput` chain
 * directly. Unlike `ink-testing-library`'s synthetic stdin, real
 * PassThrough → Ink stdin works under React 19 strict mode for
 * subsequent keystrokes when the tree restructures.
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
import type { WorkersDiffResult } from '../../src/rpc/router-impl.js';

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
  sandbox = mkdtempSync(join(tmpdir(), 'symphony-3j-scenario-'));
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

function makeFakeRpc(opts: {
  projects: ProjectSnapshot[];
  getWorkers: () => readonly WorkerRecordSnapshot[];
  getDiff: () => WorkersDiffResult;
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
      },
      workers: {
        list: vi.fn(async () => opts.getWorkers()),
        get: vi.fn(async () => opts.getWorkers()[0] ?? null),
        kill: vi.fn(async () => ({ killed: false })),
        tail: vi.fn(async () => ({ events: [], total: 0 })),
        diff: vi.fn(async () => opts.getDiff()),
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

describe('Phase 3J scenario — diff preview through the launcher', () => {
  it('toggles to diff view on D and back on second D', async () => {
    const fakeMaestro = new FakeMaestroProcess();
    const fakeMaestroAsProcess = fakeMaestro as unknown as MaestroProcess;
    Object.defineProperty(fakeMaestroAsProcess, 'events', {
      value: () => fakeMaestro.eventsIter(),
    });

    const projects: ProjectSnapshot[] = [
      { id: 'p1', name: 'demo', path: '/repos/demo', createdAt: '2026-04-30T00:00:00Z' },
    ];
    const workers: WorkerRecordSnapshot[] = [
      {
        id: 'wk-1',
        projectPath: '/repos/demo',
        worktreePath: '/repos/demo/.symphony/worktrees/wk-1',
        role: 'implementer',
        featureIntent: 'add LRU cache',
        taskDescription: 'add LRU',
        autonomyTier: 1,
        dependsOn: [],
        status: 'running',
        createdAt: new Date(Date.now() - 60_000).toISOString(),
      },
    ];
    const diffResult: WorkersDiffResult = {
      resolvedBase: 'main',
      mergeBaseSha: 'abc1234567890abcdef1234567890abcdef12345',
      branch: 'feature/lru',
      diff: '--- a/src/cache.ts\n+++ b/src/cache.ts\n@@ -1 +1,3 @@\n-old\n+const cache = new LRU();\n+export { cache };\n',
      bytes: 90,
      truncated: false,
      cappedAt: null,
      files: [{ path: 'src/cache.ts', status: 'M' }],
    };

    const rpc = makeFakeRpc({
      projects,
      getWorkers: () => workers,
      getDiff: () => diffResult,
    });

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

    // Wait for the first poll cycle so the worker shows up in the panel.
    await settle(1300);

    // Select the worker (Tab from chat to workers, then j/Space, etc.)
    // — simpler path: send Ctrl+W (open worker selector) then Enter.
    // Even simpler: rely on Workers panel auto-selecting the only
    // running worker. Phase 3C's selection auto-picks the first running
    // worker by default.
    const baselinePostMount = stdoutChunks.join('').length;

    // Tab to focus output panel (chat → workers → output).
    // Send each keystroke separately — Ink's parser treats multi-char
    // chunks as a paste-style insert, not a sequence of key events.
    (stdin as unknown as PassThrough).write('\t');
    await settle(150);
    (stdin as unknown as PassThrough).write('\t');
    await settle(150);

    // Press 'D' to toggle to diff view.
    (stdin as unknown as PassThrough).write('D');
    await settle(800);

    const afterToggleFrame = stripAnsi(stdoutChunks.join('').slice(baselinePostMount));
    expect(rpc.call.workers.diff).toHaveBeenCalled();
    expect(afterToggleFrame).toContain('Diff vs main');
    expect(afterToggleFrame).toContain('+const cache');

    // Press 'D' again to toggle back.
    const baselinePreToggleBack = stdoutChunks.join('').length;
    (stdin as unknown as PassThrough).write('D');
    await settle(500);
    const afterToggleBackFrame = stripAnsi(
      stdoutChunks.join('').slice(baselinePreToggleBack),
    );
    // After toggling back, the diff header may persist in older frames
    // (cumulative buffer), so we check that the streaming output panel
    // has rendered something *new* (the worker output panel's empty
    // hint or any output rows). The strongest signal is that pressing
    // 'r' now is a no-op — refresh is only registered in diff mode.
    void afterToggleBackFrame;
    const diffCallsBeforeR = (rpc.call.workers.diff as ReturnType<typeof vi.fn>).mock.calls
      .length;
    (stdin as unknown as PassThrough).write('r');
    await settle(300);
    const diffCallsAfterR = (rpc.call.workers.diff as ReturnType<typeof vi.fn>).mock.calls
      .length;
    expect(diffCallsAfterR).toBe(diffCallsBeforeR);

    await handle.stop('scenario shutdown');
    await handle.done;
    expect(rpc.close).toHaveBeenCalled();
  }, 30_000);
});
