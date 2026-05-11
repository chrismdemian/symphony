/**
 * Phase 3M scenario — Away Mode through the launcher.
 *
 * Drives `runStart` end-to-end with a fake RPC. Verifies:
 *   1. Initial state: status bar has NO "Away Mode" segment.
 *   2. Typing `/away` in chat fires `runtime.setAwayMode({awayMode:true})`
 *      and surfaces the muted-gray status-bar segment.
 *   3. Typing `/away` again fires `runtime.setAwayMode({awayMode:false})`
 *      AND `notifications.flushAwayDigest`. When the flush returns a
 *      digest body, the chat shows a "While you were away: …" system
 *      row authored by the orchestrator (workerName='Symphony').
 *
 * The fake `flushAwayDigest` returns a synthetic digest the test can
 * assert on; the real dispatcher composes this from the worker-exit /
 * question-arrive tally accumulated while awayMode was on (covered by
 * `dispatcher.unit.test.ts` and `away-mode-context.integration.test.ts`).
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
  sandbox = mkdtempSync(join(tmpdir(), 'symphony-3m-scenario-'));
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
  digestResponse: { digest: string | null },
  spies: { setAwayModeCalls: Array<{ awayMode: boolean }>; flushAwayDigestCalls: { count: number } },
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
        flushAwayDigest: vi.fn(async () => {
          spies.flushAwayDigestCalls.count += 1;
          return digestResponse;
        }),
      },
      runtime: {
        setAwayMode: vi.fn(async (args: { awayMode: boolean }) => {
          spies.setAwayModeCalls.push({ awayMode: args.awayMode });
          return { awayMode: args.awayMode };
        }),
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

describe('Phase 3M scenario — Away Mode through the launcher', () => {
  it('toggles via /away: RPC sync + status-bar segment + digest system row', async () => {
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
    const setAwayModeCalls: Array<{ awayMode: boolean }> = [];
    const flushAwayDigestCalls = { count: 0 };
    const rpc = makeFakeRpc(
      projects,
      workers,
      // Simulated digest from the (otherwise-stubbed) dispatcher.
      { digest: '2 completed, 1 failed, 3 questions' },
      { setAwayModeCalls, flushAwayDigestCalls },
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

    // Wait for first poll + mount + initial render.
    await settle(1300);
    const initialFrame = stripAnsi(stdoutChunks.join(''));
    expect(initialFrame).not.toContain('Away Mode');
    // RPC sync has NOT fired yet — initial config is awayMode=false and
    // the prevAwayModeRef detector returns no-op on mount.
    expect(setAwayModeCalls).toEqual([]);

    // Type `/away` + Enter to flip awayMode=true.
    // Per 3J known gotcha: ink's parser treats multi-char stdin chunks
    // as paste-style insert; CR inside the chunk lands as a literal
    // newline in the buffer instead of triggering submit. Split text
    // and Enter into separate writes with a settle between.
    stdin.write('/away');
    await settle(80);
    stdin.write('\r');
    await settle(800);
    const afterOnFrame = stripAnsi(stdoutChunks.join(''));
    expect(afterOnFrame).toContain('Away Mode');
    // Status-bar segment with zero counts (no workers / questions).
    expect(afterOnFrame).toMatch(/Away Mode\s+—\s+0 done/);
    // RPC sync via useEffect false→true edge.
    expect(setAwayModeCalls).toEqual([{ awayMode: true }]);
    // Toast confirms.
    expect(afterOnFrame).toContain('Away mode: on');

    // Type `/away` again to flip back to false.
    stdin.write('/away');
    await settle(80);
    stdin.write('\r');
    await settle(800);
    const afterOffFrame = stripAnsi(stdoutChunks.join(''));
    // RPC sync called with awayMode=false; flushAwayDigest also fired.
    expect(setAwayModeCalls).toEqual([{ awayMode: true }, { awayMode: false }]);
    expect(flushAwayDigestCalls.count).toBeGreaterThanOrEqual(1);
    // Digest system row appears in the chat: "While you were away: …"
    // headline composed from the dispatcher's tally.
    expect(afterOffFrame).toContain('While you were away: 2 completed, 1 failed, 3 questions');
    expect(afterOffFrame).toContain('Away mode: off');
    // Final rendered status bar (the LAST occurrence of "Symphony v")
    // must not be followed by "Away Mode" on its line — verifies the
    // segment hides post-toggle. Cumulative stdoutChunks includes
    // earlier on-state frames; isolating the tail of the most recent
    // bar render is the right thing to look at.
    const finalBarMatch = afterOffFrame.match(/Symphony v[^\n]*$/m);
    expect(finalBarMatch).not.toBeNull();
    expect(finalBarMatch?.[0]).not.toContain('Away Mode');

    // Audit M2 (commit 3): assert segment order on a real rendered
    // bar. Find the FIRST bar frame that contains "Away Mode" (an
    // on-state frame) and verify `Project:` comes before "Away Mode"
    // on the same line. ink wraps wide rows in the test harness so
    // this asserts column order ON A SINGLE LINE.
    const allBarLines = afterOnFrame.split('\n').filter((line) =>
      /Symphony v.*Away Mode/.test(line),
    );
    expect(allBarLines.length).toBeGreaterThan(0);
    const sampleBar = allBarLines[allBarLines.length - 1]!;
    const projectIdx = sampleBar.indexOf('Project:');
    const awayIdx = sampleBar.indexOf('Away Mode');
    expect(projectIdx).toBeGreaterThanOrEqual(0);
    expect(awayIdx).toBeGreaterThan(projectIdx);

    await handle.stop('scenario shutdown');
    await handle.done;
    expect(rpc.close).toHaveBeenCalled();
  }, 30_000);

  it('digest:null branch — toggle off with empty buffer does NOT push a system row', async () => {
    // Audit M3 (commit 3): the happy-path test above asserts the
    // digest body is rendered. This test asserts the inverse — when
    // the dispatcher's tally is empty (no buffered events while away),
    // `flushAwayDigest` returns `{ digest: null }` and the TUI must
    // NOT push a "While you were away: …" row. A future change that
    // silently always returned null would otherwise pass undetected.
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
    const setAwayModeCalls: Array<{ awayMode: boolean }> = [];
    const flushAwayDigestCalls = { count: 0 };
    const rpc = makeFakeRpc(
      projects,
      [],
      { digest: null }, // ← empty buffer
      { setAwayModeCalls, flushAwayDigestCalls },
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

    await settle(1300);

    // /away on
    stdin.write('/away');
    await settle(80);
    stdin.write('\r');
    await settle(800);

    // /away off (no events buffered → flushAwayDigest returns null)
    stdin.write('/away');
    await settle(80);
    stdin.write('\r');
    await settle(800);

    expect(setAwayModeCalls).toEqual([{ awayMode: true }, { awayMode: false }]);
    // Flush WAS called (the TUI always tries on the edge); the
    // dispatcher just had nothing to drain.
    expect(flushAwayDigestCalls.count).toBeGreaterThanOrEqual(1);

    const finalFrame = stripAnsi(stdoutChunks.join(''));
    // NO "While you were away" row anywhere — including the substring.
    expect(finalFrame).not.toContain('While you were away');

    await handle.stop('scenario shutdown');
    await handle.done;
  }, 30_000);
});
