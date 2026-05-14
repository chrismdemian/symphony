/**
 * Phase 3F.4 scenario — markdown fence detector + syntax highlighter +
 * diff colorizer through the launcher's worker output panel.
 *
 * Mirrors `tests/scenarios/3d2.test.ts` (json-render scenario): same
 * FakeMaestroProcess, same makeFakeRpc with `workers.tail` returning
 * scripted assistant_text events. Differs in the payload — fenced ts
 * + diff blocks instead of json-render — and the post-backfill
 * assertions check for tokenized content.
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
import type { StreamEvent } from '../../src/workers/types.js';

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
  sandbox = mkdtempSync(join(tmpdir(), 'symphony-3f4-scenario-'));
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
  tailMock: ReturnType<typeof vi.fn>;
  closeMock: ReturnType<typeof vi.fn>;
}

function makeFakeRpc(
  projects: ProjectSnapshot[],
  getWorkers: () => readonly WorkerRecordSnapshot[],
  tailEvents: readonly StreamEvent[],
): FakeRpcHandle {
  const subs: Array<{ workerId: string; unsubscribed: boolean }> = [];
  const tailMock = vi.fn(async (args: { workerId: string; n?: number }) => {
    void args;
    return { events: tailEvents, total: tailEvents.length };
  });
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
        list: vi.fn(async () => getWorkers()),
        get: vi.fn(async () => null),
        kill: vi.fn(async () => ({ killed: false })),
        tail: tailMock,
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
    subscribe: vi.fn(
      async (_topic: string, args: unknown, _listener: (e: unknown) => void) => {
        const workerId = (args as { workerId: string }).workerId;
        const entry = { workerId, unsubscribed: false };
        subs.push(entry);
        return {
          topic: 'workers.events',
          unsubscribe: async () => {
            entry.unsubscribed = true;
          },
        };
      },
    ),
    close: closeMock,
  };

  return { rpc, tailMock, closeMock };
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
  } as WorkerRecordSnapshot;
}

const TS_BLOCK_TEXT =
  'narrative before\n\n' +
  '```ts\n' +
  "const greeting: string = 'hello';\n" +
  'const n: number = 42;\n' +
  '```\n\n' +
  'narrative after';

const DIFF_BLOCK_TEXT =
  'change summary:\n\n' +
  '```diff\n' +
  '@@ -1,2 +1,2 @@\n' +
  '-old line\n' +
  '+new line\n' +
  '```';

describe('Phase 3F.4 scenario — markdown highlighter + diff colorizer', () => {
  it('renders fenced ts code + diff block content through the worker output panel', async () => {
    const fakeMaestro = new FakeMaestroProcess();
    const fakeMaestroAsProcess = fakeMaestro as unknown as MaestroProcess;
    Object.defineProperty(fakeMaestroAsProcess, 'events', {
      value: () => fakeMaestro.eventsIter(),
    });

    const projects: ProjectSnapshot[] = [
      { id: 'p1', name: 'demo', path: '/repos/demo', createdAt: '2026-04-30T00:00:00Z' },
    ];
    let workers: WorkerRecordSnapshot[] = [];
    const tailEvents: StreamEvent[] = [
      { type: 'assistant_text', text: TS_BLOCK_TEXT },
      { type: 'assistant_text', text: DIFF_BLOCK_TEXT },
    ];
    const handle = makeFakeRpc(projects, () => workers, tailEvents);

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

    await settle(200);
    expect(handle.tailMock).not.toHaveBeenCalled();

    workers = [snap({ id: 'w1', featureIntent: 'emits markdown', status: 'running' })];
    await settle(1500);

    expect(handle.tailMock).toHaveBeenCalledWith({ workerId: 'w1', n: 200 });

    await settle(200);
    const fullStream = stdoutChunks.join('');
    const plain = stripAnsi(fullStream);

    // Narrative renders.
    expect(plain).toContain('narrative before');
    expect(plain).toContain('narrative after');
    expect(plain).toContain('change summary');

    // ts code-block content renders (text preserved through token splitting).
    expect(plain).toContain('const');
    expect(plain).toContain("'hello'");
    expect(plain).toContain('42');
    expect(plain).toContain('greeting');

    // diff content renders line-by-line.
    expect(plain).toContain('@@ -1,2 +1,2 @@');
    expect(plain).toContain('-old line');
    expect(plain).toContain('+new line');

    await launcher.stop('scenario shutdown');
    await launcher.done;
    expect(handle.closeMock).toHaveBeenCalled();
  }, 30_000);
});
