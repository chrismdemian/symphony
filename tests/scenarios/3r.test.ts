/**
 * Phase 3R scenario — audit log through the launcher.
 *
 * Drives `runStart` end-to-end with a fake RPC whose `audit.list`
 * returns canned `AuditEntry`s. Types `/log` into the chat InputBar
 * and asserts the LogPanel popup renders the entries, then types a
 * filter and asserts the filter row reflects it.
 *
 * Mirrors `tests/scenarios/3p.test.ts` shape (FakeMaestroProcess +
 * makeFakeRpc + makeTtyStream).
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
import type { AuditEntry } from '../../src/state/audit-store.js';

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
  sandbox = mkdtempSync(join(tmpdir(), 'symphony-3r-scenario-'));
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

const ISO = '2026-05-14T12:00:00.000Z';

function makeFakeRpc(opts: {
  projects: ProjectSnapshot[];
  auditEntries: AuditEntry[];
}): FullFakeRpc {
  const auditList = vi.fn(async () => opts.auditEntries);
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
        report: vi.fn(async () => ({
          crashedIds: [],
          capturedAt: '1970-01-01T00:00:00.000Z',
        })),
      },
      audit: {
        list: auditList,
        count: vi.fn(async () => opts.auditEntries.length),
      },
    },
    subscribe: vi.fn(async (topic: string) => ({
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

const stripAnsi = (s: string): string =>
  // eslint-disable-next-line no-control-regex
  s.replace(/\x1b\[[\d;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');

const baseProjects: ProjectSnapshot[] = [
  { id: 'p1', name: 'MathScrabble', path: '/repos/ms', createdAt: ISO },
];

function entry(
  id: number,
  kind: AuditEntry['kind'],
  headline: string,
  severity: AuditEntry['severity'] = 'info',
): AuditEntry {
  return {
    id,
    ts: ISO,
    kind,
    severity,
    projectId: 'p1',
    workerId: null,
    taskId: null,
    toolName: null,
    headline,
    payload: {},
  };
}

describe('Phase 3R scenario — audit log through the launcher', () => {
  it('opens the LogPanel via /log and renders audit entries', async () => {
    const fakeMaestro = new FakeMaestroProcess();
    const fakeMaestroAsProcess = fakeMaestro as unknown as MaestroProcess;
    Object.defineProperty(fakeMaestroAsProcess, 'events', {
      value: () => fakeMaestro.eventsIter(),
    });

    const rpc = makeFakeRpc({
      projects: baseProjects,
      auditEntries: [
        entry(3, 'merge_performed', 'merged feature/friend-list → master'),
        entry(2, 'worker_completed', 'completed: add friend-list UI'),
        entry(1, 'worker_failed', 'failed: flaky integration test', 'error'),
      ],
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

    await settle(800);

    // Type "/log" + Enter (3J gotcha: split text and Enter, settle between).
    (stdin as unknown as PassThrough).write('/log');
    await settle(80);
    (stdin as unknown as PassThrough).write('\r');
    await settle(1200);

    const auditCalls = (rpc.call.audit.list as ReturnType<typeof vi.fn>).mock.calls;
    expect(auditCalls.length).toBeGreaterThanOrEqual(1);

    const frame = stripAnsi(stdoutChunks.join(''));
    expect(frame).toContain('Audit log');
    expect(frame).toContain('merged feature/friend-list');
    expect(frame).toContain('completed: add friend-list UI');
    expect(frame).toContain('failed: flaky integration test');

    await handle.stop('scenario shutdown');
    await handle.done;
    expect(rpc.close).toHaveBeenCalled();
  }, 30_000);

  it('typing a filter into the LogPanel reflects in the filter row', async () => {
    const fakeMaestro = new FakeMaestroProcess();
    const fakeMaestroAsProcess = fakeMaestro as unknown as MaestroProcess;
    Object.defineProperty(fakeMaestroAsProcess, 'events', {
      value: () => fakeMaestro.eventsIter(),
    });

    const rpc = makeFakeRpc({
      projects: baseProjects,
      auditEntries: [entry(1, 'merge_performed', 'merged X → master')],
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

    await settle(800);
    (stdin as unknown as PassThrough).write('/log');
    await settle(80);
    (stdin as unknown as PassThrough).write('\r');
    await settle(800);

    // Type a filter one char at a time (ink delivers each as input).
    for (const ch of '--type merge') {
      (stdin as unknown as PassThrough).write(ch);
      await settle(30);
    }
    await settle(800);

    const frame = stripAnsi(stdoutChunks.join(''));
    expect(frame).toContain('filter>');
    expect(frame).toContain('--type merge');

    await handle.stop('scenario shutdown');
    await handle.done;
  }, 30_000);
});
