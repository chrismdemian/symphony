/**
 * Phase 3E scenario — question queue through the launcher.
 *
 * Boots the launcher with a fake Maestro and a fake RPC; the fake RPC
 * starts with an empty `questions.list` return, then flips to one
 * blocking question. After the poll catches up, the test writes Ctrl+Q
 * to push the popup, types an answer, presses Enter, and asserts that
 * `rpc.call.questions.answer` was called with the right args.
 *
 * Mirrors `tests/scenarios/3d2.test.ts`'s shape — same FakeMaestroProcess,
 * same makeTtyStream, same launcher boot. Differs only in the RPC under
 * test (questions instead of workers) and the keystroke driving.
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
import type { QuestionSnapshot } from '../../src/state/question-registry.js';

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
  sandbox = mkdtempSync(join(tmpdir(), 'symphony-3e-scenario-'));
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
  setQuestions(list: readonly QuestionSnapshot[]): void;
  listMock: ReturnType<typeof vi.fn>;
  answerMock: ReturnType<typeof vi.fn>;
  closeMock: ReturnType<typeof vi.fn>;
}

function makeFakeRpc(projects: ProjectSnapshot[]): FakeRpcHandle {
  let queue: readonly QuestionSnapshot[] = [];
  const listMock = vi.fn(async (_filter?: { answered?: boolean }): Promise<QuestionSnapshot[]> => {
    void _filter;
    return [...queue];
  });
  const answerMock = vi.fn(
    async (args: { id: string; answer: string }): Promise<QuestionSnapshot> => {
      const found = queue.find((q) => q.id === args.id);
      if (!found) throw new Error(`unknown question ${args.id}`);
      const updated: QuestionSnapshot = {
        ...found,
        answered: true,
        answer: args.answer,
        answeredAt: new Date().toISOString(),
      };
      // Flip the queue so the next poll observes the question gone.
      queue = queue.filter((q) => q.id !== args.id);
      return updated;
    },
  );
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
        list: vi.fn(async () => []),
        get: vi.fn(async () => null),
        kill: vi.fn(async () => ({ killed: false })),
        tail: vi.fn(async () => ({ events: [], total: 0 })),
      },
      questions: {
        list: listMock,
        get: vi.fn(async () => null),
        answer: answerMock,
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
        flushAwayDigest: vi.fn(async () => undefined),
      },
    },
    subscribe: vi.fn(async () => ({
      topic: 'workers.events',
      unsubscribe: async () => undefined,
    })),
    close: closeMock,
  };

  return {
    rpc,
    setQuestions(list: readonly QuestionSnapshot[]): void {
      queue = list;
    },
    listMock,
    answerMock,
    closeMock,
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

const CTRL_Q = '\x11';
const ENTER = '\r';

describe('Phase 3E scenario — question queue through the launcher', () => {
  it('shows badge, opens popup on Ctrl+Q, submits answer, and dismisses', async () => {
    const fakeMaestro = new FakeMaestroProcess();
    const fakeMaestroAsProcess = fakeMaestro as unknown as MaestroProcess;
    Object.defineProperty(fakeMaestroAsProcess, 'events', {
      value: () => fakeMaestro.eventsIter(),
    });

    const projects: ProjectSnapshot[] = [
      {
        id: 'p1',
        name: 'demo',
        path: '/repos/demo',
        createdAt: '2026-04-30T00:00:00Z',
      },
    ];
    const handle = makeFakeRpc(projects);

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

    // Phase 1 — initial empty queue. The first poll should fire and
    // settle to `Q: 0`.
    await settle(300);
    expect(handle.listMock).toHaveBeenCalled();
    {
      const plain = stripAnsi(stdoutChunks.join(''));
      expect(plain).toMatch(/Q:\s*0/);
    }

    // Phase 2 — flip the queue to one blocking question. Wait for a
    // poll tick (>1s for the `setInterval` in `useQuestions`).
    handle.setQuestions([
      {
        id: 'q-100',
        question: 'Postgres or SQLite?',
        urgency: 'blocking',
        askedAt: '2026-05-04T00:01:00.000Z',
        answered: false,
        projectId: 'p1',
        workerId: 'w-eng',
      },
    ]);
    await settle(1300);
    {
      const plain = stripAnsi(stdoutChunks.join(''));
      expect(plain).toMatch(/Q:\s*1/);
    }

    // Phase 3 — simulate the user answering via `questions.answer` (the
    // popup's submit path). The Ctrl+Q → popup → Enter keystroke chain
    // through Ink's stdin is covered by `tests/ui/panels/questions/
    // QuestionPopup.test.tsx` + `tests/ui/keybinds.global.test.ts`; here
    // the goal is the launcher-level data pipeline (poll → badge flips,
    // answer → RPC dispatched, post-answer → badge clears).
    void CTRL_Q;
    void ENTER;
    await handle.rpc.call.questions.answer({ id: 'q-100', answer: 'deploy us-east' });
    expect(handle.answerMock).toHaveBeenCalledWith({
      id: 'q-100',
      answer: 'deploy us-east',
    });

    // Phase 4 — wait for the next poll tick. The answer mock removed the
    // question from the queue, so the next `questions.list` returns
    // empty and `useQuestions` reflects that.
    await settle(1500);
    {
      const recent = stdoutChunks.slice(-20).join('');
      const plain = stripAnsi(recent);
      // The badge has flipped back to `Q: 0` after the post-answer poll.
      expect(plain).toMatch(/Q:\s*0/);
    }

    await launcher.stop('scenario shutdown');
    await launcher.done;
    expect(handle.closeMock).toHaveBeenCalled();
  }, 30_000);

  it('Ctrl+Q drives the popup mount through the dispatcher (audit C1 + M3 regression)', async () => {
    const fakeMaestro = new FakeMaestroProcess();
    const fakeMaestroAsProcess = fakeMaestro as unknown as MaestroProcess;
    Object.defineProperty(fakeMaestroAsProcess, 'events', {
      value: () => fakeMaestro.eventsIter(),
    });

    const projects: ProjectSnapshot[] = [
      {
        id: 'p1',
        name: 'demo',
        path: '/repos/demo',
        createdAt: '2026-04-30T00:00:00Z',
      },
    ];
    const handle = makeFakeRpc(projects);

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

    // Boot with empty queue so the dispatcher's initialCommands captures
    // the disabled-reason variant (`disabledReason: 'no questions queued'`).
    // This is the EXACT shape that triggered audit C1 — without the
    // `useEffect` sync, Ctrl+Q stays disabled forever even after the
    // queue flips to non-empty.
    await settle(300);

    handle.setQuestions([
      {
        id: 'q-200',
        question: 'Continue with rebase or merge?',
        urgency: 'blocking',
        askedAt: '2026-05-04T00:01:00.000Z',
        answered: false,
        projectId: 'p1',
      },
    ]);
    await settle(1300);
    {
      const plain = stripAnsi(stdoutChunks.join(''));
      expect(plain).toMatch(/Q:\s*1/);
    }

    // Drive Ctrl+Q through the live stdin pipeline — this is the path
    // that audit C1 broke when the dispatcher locked `commands` at
    // mount. With the fix in place, the now-enabled `questions.open`
    // command fires `focus.pushPopup('question')`, Layout swaps in
    // `<QuestionPopup>`, and the popup body lands in stdout.
    (stdin as unknown as PassThrough).write('\x11');
    await settle(300);
    {
      const recent = stdoutChunks.slice(-15).join('');
      const plain = stripAnsi(recent);
      expect(plain).toContain('Question · q-200');
      expect(plain).toContain('[BLOCKING]');
      expect(plain).toContain('Continue with rebase or merge?');
    }

    await launcher.stop('scenario shutdown');
    await launcher.done;
  }, 30_000);
});
