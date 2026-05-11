/**
 * Phase 3I scenario — pipeline bar + gerund label through the launcher.
 *
 * Drives `runStart` end-to-end with a fake RPC whose `workers.list`
 * mutates between phases. Verifies the bar + label render through the
 * production data-hook → registry → panel chain under a real 1s poll
 * cycle.
 *
 * Color assertions live in unit tests + visual frames — see 3i.md and
 * the comment block at the top of `tests/ui/panels/workers/PipelineBar.test.tsx`.
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
  sandbox = mkdtempSync(join(tmpdir(), 'symphony-3i-scenario-'));
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
  getWorkers: () => readonly WorkerRecordSnapshot[],
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
        list: vi.fn(async () => getWorkers()),
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

function snap(over: Partial<WorkerRecordSnapshot>): WorkerRecordSnapshot {
  return {
    id: 'w',
    projectPath: '/repos/demo',
    worktreePath: '/repos/demo/.symphony/worktrees/w',
    role: 'implementer',
    featureIntent: 'placeholder',
    taskDescription: 'placeholder',
    autonomyTier: 1,
    dependsOn: [],
    status: 'running',
    createdAt: new Date(Date.now() - 60_000).toISOString(),
    ...over,
  };
}

const CELL = '█';

describe('Phase 3I scenario — pipeline bar + gerund label through the launcher', () => {
  it('renders empty, then the bar + labels for mixed-role workers, then a status flip', async () => {
    const fakeMaestro = new FakeMaestroProcess();
    const fakeMaestroAsProcess = fakeMaestro as unknown as MaestroProcess;
    Object.defineProperty(fakeMaestroAsProcess, 'events', {
      value: () => fakeMaestro.eventsIter(),
    });

    const projects: ProjectSnapshot[] = [
      { id: 'p1', name: 'demo', path: '/repos/demo', createdAt: '2026-04-30T00:00:00Z' },
    ];
    let workers: WorkerRecordSnapshot[] = [];
    const rpc = makeFakeRpc(projects, () => workers);

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

    // Phase 1 — empty baseline. No bar cells, no gerund labels.
    await settle(200);
    const emptyFrame = stripAnsi(stdoutChunks.join(''));
    expect(emptyFrame).toContain('Workers');
    expect(emptyFrame).toContain('no workers');
    expect(emptyFrame).not.toContain(CELL);
    expect(emptyFrame).not.toContain('Researching');
    expect(emptyFrame).not.toContain('Implementing');
    expect(emptyFrame).not.toContain('Reviewing');

    // Phase 2 — populate three workers across three different roles +
    // statuses; wait for the next 1s poll tick.
    workers = [
      snap({
        id: 'rs1',
        role: 'researcher',
        featureIntent: 'survey caching libs',
        status: 'running',
        createdAt: new Date(Date.now() - 90_000).toISOString(),
      }),
      snap({
        id: 'im1',
        role: 'implementer',
        featureIntent: 'add LRU cache',
        status: 'running',
        createdAt: new Date(Date.now() - 60_000).toISOString(),
      }),
      snap({
        id: 'rv1',
        role: 'reviewer',
        featureIntent: 'review caching change',
        status: 'completed',
        createdAt: new Date(Date.now() - 30_000).toISOString(),
        completedAt: new Date().toISOString(),
      }),
    ];
    const populatedBaselineLen = stdoutChunks.join('').length;
    await settle(1300);
    const populatedFrame = stripAnsi(stdoutChunks.join('').slice(populatedBaselineLen));

    // Gerund labels per worker role.
    expect(populatedFrame).toContain('Researching');
    expect(populatedFrame).toContain('Implementing');
    expect(populatedFrame).toContain('Reviewing');

    // Feature intent text appears (substring — the panel may truncate
    // the full string under a narrow column with an ellipsis suffix).
    expect(populatedFrame).toContain('survey');
    expect(populatedFrame).toContain('LRU');
    expect(populatedFrame).toContain('caching');

    // 3 rows × 5 cells = 15 total bar glyphs. The PipelineBar pins
    // `flexShrink={0}` so Ink can't drop a cell under a narrow column.
    const populatedCells = (populatedFrame.match(new RegExp(CELL, 'g')) ?? []).length;
    // 3 rows × 5 cells per worker frame. The launcher accumulates
    // multiple frames in `stdoutChunks` and the test slices the union;
    // partial frames during reflow can leave unaligned counts. The
    // material assertion is "every worker row got its 5-cell bar at
    // least once" → ≥ 15 cells in the captured window.
    expect(populatedCells).toBeGreaterThanOrEqual(15);

    // Phase 3 — flip the implementer to failed; the row keeps its bar +
    // label and the panel acquires a `✗` glyph (status dot for failed).
    const preFlipFailures = (populatedFrame.match(/✗/g) ?? []).length;
    expect(preFlipFailures).toBe(0);

    workers = [
      workers[0]!,
      { ...workers[1]!, status: 'failed', completedAt: new Date().toISOString() },
      workers[2]!,
    ];
    const flipBaselineLen = stdoutChunks.join('').length;
    await settle(1300);
    const flipFrame = stripAnsi(stdoutChunks.join('').slice(flipBaselineLen));

    expect(flipFrame).toContain('✗');
    expect(flipFrame).toContain('Implementing');
    // The implementer's row is rewritten by the diff; verify at least
    // one bar cell is still present (bar persists for terminal workers).
    // Cumulative-frame count assertion lives in the populated phase
    // above; per-poll diffs may emit only the changed row.
    expect(flipFrame).toContain(CELL);

    await handle.stop('scenario shutdown');
    await handle.done;

    expect(rpc.close).toHaveBeenCalled();
  }, 30_000);
});
