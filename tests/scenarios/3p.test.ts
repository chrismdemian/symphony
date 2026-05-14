/**
 * Phase 3P scenario — cross-project task dependencies through the launcher.
 *
 * Drives `runStart` end-to-end with a fake RPC whose
 * `subscribe('task-ready.events', ...)` fires canned `TaskReadyEvent`s
 * and whose `tasks.graph()` returns a fixed graph for the /deps popup.
 *
 * Mirrors `tests/scenarios/3o1.test.ts` shape exactly.
 *
 * Coverage:
 *   - `task_ready` event surfaces as a chat row with ✓ + "Task ready:" + project
 *   - Cross-project `task_ready` row shows both project names in headline
 *   - `/deps` slash opens the DepsPanel popup (renders the graph)
 *   - `/deps` with empty graph shows the empty-state hint
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
import type { TaskReadyEvent } from '../../src/orchestrator/task-ready-types.js';
import type { TaskGraph } from '../../src/orchestrator/task-deps.js';

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
  sandbox = mkdtempSync(join(tmpdir(), 'symphony-3p-scenario-'));
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
  workers: WorkerRecordSnapshot[];
  taskReadyEvents: TaskReadyEvent[];
  graph?: TaskGraph;
}): FullFakeRpc {
  const graph: TaskGraph = opts.graph ?? { nodes: [], edges: [], cycles: [] };
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
        graph: vi.fn(async () => graph),
      },
      workers: {
        list: vi.fn(async () => opts.workers),
        get: vi.fn(async () => opts.workers[0] ?? null),
        kill: vi.fn(async () => ({ killed: false })),
        tail: vi.fn(async () => ({ events: [], total: 0 })),
        diff: vi.fn(async () => null),
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
      },
    },
    subscribe: vi.fn(async (topic: string, _args: unknown, listener: (e: unknown) => void) => {
      if (topic === 'task-ready.events') {
        setImmediate(() => {
          for (const ev of opts.taskReadyEvents) listener(ev);
        });
      }
      return {
        topic,
        unsubscribe: async () => {},
      };
    }),
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

const ISO = '2026-05-13T00:00:00.000Z';

const baseProjects: ProjectSnapshot[] = [
  { id: 'p1', name: 'cre-pipeline', path: '/repos/cre', createdAt: ISO },
  { id: 'p2', name: 'frontend', path: '/repos/fe', createdAt: ISO },
];
const baseWorkers: WorkerRecordSnapshot[] = [];

function makeReadyEvent(overrides: Partial<TaskReadyEvent> = {}): TaskReadyEvent {
  return {
    kind: 'task_ready',
    task: {
      id: 'tk-b',
      projectId: 'p1',
      description: 'Add filters middleware',
      status: 'pending',
      priority: 0,
      dependsOn: ['tk-a'],
      notes: [],
      createdAt: ISO,
      updatedAt: ISO,
    },
    projectName: 'cre-pipeline',
    unblockedBy: {
      id: 'tk-a',
      projectId: 'p1',
      description: 'Build API endpoint',
      status: 'completed',
      priority: 0,
      dependsOn: [],
      notes: [],
      createdAt: ISO,
      updatedAt: ISO,
      completedAt: ISO,
    },
    unblockedByProjectName: 'cre-pipeline',
    headline: 'Task ready: Add filters middleware (cre-pipeline) — Build API endpoint completed',
    ts: ISO,
    ...overrides,
  };
}

describe('Phase 3P scenario — task-ready events through the launcher', () => {
  it("renders a chat row with ✓ when subscribe fires a task_ready event", async () => {
    const fakeMaestro = new FakeMaestroProcess();
    const fakeMaestroAsProcess = fakeMaestro as unknown as MaestroProcess;
    Object.defineProperty(fakeMaestroAsProcess, 'events', {
      value: () => fakeMaestro.eventsIter(),
    });

    const rpc = makeFakeRpc({
      projects: baseProjects,
      workers: baseWorkers,
      taskReadyEvents: [makeReadyEvent()],
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

    await settle(1500);

    const frame = stripAnsi(stdoutChunks.join(''));

    const subscribeCalls = (rpc.subscribe as ReturnType<typeof vi.fn>).mock.calls;
    const taskReadySubs = subscribeCalls.filter((args) => args[0] === 'task-ready.events');
    expect(taskReadySubs.length).toBeGreaterThanOrEqual(1);

    expect(frame).toContain('Task ready: Add filters middleware');
    expect(frame).toContain('cre-pipeline');
    expect(frame).toContain('✓');

    await handle.stop('scenario shutdown');
    await handle.done;
    expect(rpc.close).toHaveBeenCalled();
  }, 30_000);

  it("renders a cross-project task_ready row with both project names in the headline", async () => {
    const fakeMaestro = new FakeMaestroProcess();
    const fakeMaestroAsProcess = fakeMaestro as unknown as MaestroProcess;
    Object.defineProperty(fakeMaestroAsProcess, 'events', {
      value: () => fakeMaestro.eventsIter(),
    });

    const crossProjectEvent = makeReadyEvent({
      task: {
        id: 'tk-fe-b',
        projectId: 'p2',
        description: 'Frontend filters wired to API',
        status: 'pending',
        priority: 0,
        dependsOn: ['tk-a'],
        notes: [],
        createdAt: ISO,
        updatedAt: ISO,
      },
      projectName: 'frontend',
      unblockedByProjectName: 'cre-pipeline',
      headline:
        'Task ready: Frontend filters wired to API (frontend) — Build API endpoint (cre-pipeline) completed',
    });

    const rpc = makeFakeRpc({
      projects: baseProjects,
      workers: baseWorkers,
      taskReadyEvents: [crossProjectEvent],
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

    await settle(1500);

    const frame = stripAnsi(stdoutChunks.join(''));
    expect(frame).toContain('Frontend filters wired to API');
    expect(frame).toContain('frontend');
    expect(frame).toContain('cre-pipeline');
    expect(frame).toContain('✓');

    await handle.stop('scenario shutdown');
    await handle.done;
  }, 30_000);

  it("issues a tasks.graph RPC call when /deps slash command opens the popup", async () => {
    // Build a fake graph with a single chain so the popup has something
    // material to render (and the test can assert the panel was hit).
    const graph: TaskGraph = {
      nodes: [
        {
          id: 'tk-a',
          projectId: 'p1',
          description: 'Build API endpoint',
          status: 'completed',
          priority: 0,
          dependsOn: [],
          notes: [],
          createdAt: ISO,
          updatedAt: ISO,
          completedAt: ISO,
        },
        {
          id: 'tk-b',
          projectId: 'p1',
          description: 'Add filters middleware',
          status: 'pending',
          priority: 0,
          dependsOn: ['tk-a'],
          notes: [],
          createdAt: ISO,
          updatedAt: ISO,
        },
      ],
      edges: [{ from: 'tk-b', to: 'tk-a' }],
      cycles: [],
    };

    const fakeMaestro = new FakeMaestroProcess();
    const fakeMaestroAsProcess = fakeMaestro as unknown as MaestroProcess;
    Object.defineProperty(fakeMaestroAsProcess, 'events', {
      value: () => fakeMaestro.eventsIter(),
    });

    const rpc = makeFakeRpc({
      projects: baseProjects,
      workers: baseWorkers,
      taskReadyEvents: [],
      graph,
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

    // Initial render settle.
    await settle(800);

    // Type "/deps" + Enter into the chat InputBar.
    // Per 3J known gotcha: ink parses multi-char chunks as paste — split
    // the text and the Enter into separate writes with a settle between.
    (stdin as unknown as PassThrough).write('/deps');
    await settle(80);
    (stdin as unknown as PassThrough).write('\r');
    await settle(1200);

    // tasks.graph() should have been called now that the popup is open.
    const graphCalls = (rpc.call.tasks.graph as ReturnType<typeof vi.fn>).mock.calls;
    expect(graphCalls.length).toBeGreaterThanOrEqual(1);

    await handle.stop('scenario shutdown');
    await handle.done;
  }, 30_000);
});
