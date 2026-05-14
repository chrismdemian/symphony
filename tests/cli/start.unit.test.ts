import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter, PassThrough } from 'node:stream';
import { request } from 'node:http';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runStart, resolveCliEntryFromHere } from '../../src/cli/start.js';
import { MaestroHookServer } from '../../src/orchestrator/maestro/hook-server.js';
import type {
  HookPayload,
  MaestroProcess,
  MaestroEvent,
  MaestroStartInput,
  MaestroStartResult,
} from '../../src/orchestrator/maestro/index.js';
import type { ProjectSnapshot } from '../../src/projects/types.js';

interface CallLog {
  step: string;
  detail?: string;
}

class FakeMaestroProcess {
  readonly events = new EventEmitter();
  readonly emitter = new EventEmitter();
  startInput: MaestroStartInput | undefined;
  killCount = 0;
  injectIdleCount = 0;

  async start(input: MaestroStartInput): Promise<MaestroStartResult> {
    this.startInput = input;
    return {
      workspace: { cwd: '/fake/cwd', claudeMdPath: '/fake/cwd/CLAUDE.md' },
      session: {
        sessionId: 'fake-session',
        mode: 'fresh',
        reason: 'missing',
      },
      mcpConfigPath: '/fake/cwd/.symphony-mcp.json',
      systemInit: { sessionId: 'fake-session' },
    } as unknown as MaestroStartResult;
  }

  injectIdle(payload: HookPayload): void {
    this.injectIdleCount += 1;
    queueMicrotask(() => this.emitter.emit('event', { type: 'idle', payload } as MaestroEvent));
  }

  on(type: string, listener: (e: unknown) => void): this {
    this.emitter.on(type, listener);
    return this;
  }

  off(type: string, listener: (e: unknown) => void): this {
    this.emitter.off(type, listener);
    return this;
  }

  async kill(): Promise<undefined> {
    this.killCount += 1;
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
  sandbox = mkdtempSync(join(tmpdir(), 'symphony-cli-start-'));
  home = join(sandbox, 'home');
});

afterEach(() => {
  try {
    rmSync(sandbox, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

// Audit M1 (Phase 3A): `LauncherRpc = TuiRpc` widened to include the
// full TUI surface. These tests use PassThrough streams (non-TTY) so
// they hit the readline fallback and don't exercise the wider methods —
// stub them as vi.fn returning trivially-valid shapes for type-check.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FakeRpc = any;

function makeFakeRpc(projects: ProjectSnapshot[]): FakeRpc {
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
        list: vi.fn(async () => []),
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
      recovery: {
        report: vi.fn(async () => ({ crashedIds: [], capturedAt: new Date(0).toISOString() })),
      },
    },
    subscribe: vi.fn(async () => ({ topic: 'noop', unsubscribe: async () => {} })),
    close: vi.fn(async () => undefined),
  };
}

async function postToHook(
  port: number,
  token: string,
  body: Record<string, unknown>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path: '/hook',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-symphony-hook-token': token,
          'x-symphony-hook-event': 'stop',
        },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve());
      },
    );
    req.on('error', reject);
    req.write(JSON.stringify(body));
    req.end();
  });
}

describe('resolveCliEntryFromHere', () => {
  it('resolves index.{ts,js} sibling when parent dir basename is `cli`', () => {
    expect(resolveCliEntryFromHere('/repo/src/cli/start.ts')).toBe(
      join('/repo/src', 'index.ts'),
    );
    expect(resolveCliEntryFromHere('/app/dist/cli/start.js')).toBe(
      join('/app/dist', 'index.js'),
    );
  });

  it('returns self when the entry is already an index.{ts,js} (bundled-inline layout)', () => {
    // tsup with splitting:false inlines `start.ts` into `dist/index.js`;
    // `mcp-server` dispatches from the same file via Commander.
    expect(resolveCliEntryFromHere('/repo/dist/index.js')).toBe('/repo/dist/index.js');
    expect(resolveCliEntryFromHere('/repo/src/index.ts')).toBe('/repo/src/index.ts');
  });

  it('throws with a useful message that points at the override knob', () => {
    let err: unknown;
    try {
      resolveCliEntryFromHere('/some/odd/layout.js');
    } catch (caught) {
      err = caught;
    }
    expect((err as Error).message).toContain('RunStartOptions.cliEntryPath');
  });
});

describe('runStart wiring (unit)', () => {
  it('calls projects.list, installs the hook, then starts Maestro — in that order', async () => {
    const calls: CallLog[] = [];
    const fakeMaestro = new FakeMaestroProcess();
    // Patch the events() method to delegate to our async iterator
    const fakeMaestroAsProcess = fakeMaestro as unknown as MaestroProcess;
    Object.defineProperty(fakeMaestroAsProcess, 'events', {
      value: () => fakeMaestro.eventsIter(),
    });
    const projects: ProjectSnapshot[] = [
      { id: 'p1', name: 'demo', path: '/repos/demo', createdAt: '2026-04-29T00:00:00Z' },
    ];
    const rpc = makeFakeRpc(projects);
    const projectsListSpy = rpc.call.projects.list;

    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();

    const hookServer = new MaestroHookServer({ token: 'fixed-tok' });
    const handle = await runStart({
      home,
      cliEntryPath: '/fake/cli/entry.js',
      io: { stdin, stdout, stderr },
      skipSignalHandlers: true,
      rpcOverride: { descriptor: { host: '127.0.0.1', port: 0, token: 't' }, client: rpc },
      hookServerFactory: () => hookServer,
      maestroFactory: () => {
        calls.push({ step: 'maestro-factory' });
        return fakeMaestroAsProcess;
      },
      // Override workerManager so the default factory doesn't try to read ~/.claude.json
      workerManager: { ensureClaudeTrust: async () => undefined } as never,
    });

    // The fake Maestro's start() resolved synchronously, so by now the hook
    // and projects.list have all run.
    expect(projectsListSpy).toHaveBeenCalledTimes(1);
    expect(fakeMaestro.startInput).toBeDefined();
    expect(fakeMaestro.startInput?.extraEnv?.['SYMPHONY_HOOK_PORT']).toBe(
      String(hookServer.getPort()),
    );
    expect(fakeMaestro.startInput?.extraEnv?.['SYMPHONY_HOOK_TOKEN']).toBe('fixed-tok');
    expect(fakeMaestro.startInput?.promptVars.registeredProjects).toContain('demo');
    expect(fakeMaestro.startInput?.promptVars.projectName).toBe('demo');

    // Hook was installed in the workspace's .claude dir.
    const settingsPath = join(home, '.symphony', 'maestro', '.claude', 'settings.local.json');
    expect(existsSync(settingsPath)).toBe(true);
    expect(readFileSync(settingsPath, 'utf8')).toContain('SYMPHONY_HOOK_PORT');

    // Trigger a real Stop hook arrival via HTTP → it should call injectIdle.
    await postToHook(hookServer.getPort(), hookServer.getToken(), {
      session_id: 'fake-session',
      stop_reason: 'end_turn',
    });
    // Allow the hook server's emit + injectIdle's queueMicrotask to flush.
    await new Promise((r) => setImmediate(r));
    expect(fakeMaestro.injectIdleCount).toBe(1);

    // Tear down.
    await handle.stop('test-shutdown');
    await handle.done;

    // Hook removed.
    expect(readFileSync(settingsPath, 'utf8')).not.toContain('SYMPHONY_HOOK_PORT');
    expect(fakeMaestro.killCount).toBe(1);
    // RPC client closed.
    expect(rpc.close).toHaveBeenCalled();
  });

  it("formats `(none)` for `registered_projects` when no projects exist", async () => {
    const fakeMaestro = new FakeMaestroProcess();
    const fakeMaestroAsProcess = fakeMaestro as unknown as MaestroProcess;
    Object.defineProperty(fakeMaestroAsProcess, 'events', {
      value: () => fakeMaestro.eventsIter(),
    });
    const rpc = makeFakeRpc([]);

    const handle = await runStart({
      home,
      cliEntryPath: '/fake/cli/entry.js',
      io: { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() },
      skipSignalHandlers: true,
      rpcOverride: { descriptor: { host: '127.0.0.1', port: 0, token: 't' }, client: rpc },
      hookServerFactory: () => new MaestroHookServer({ token: 'tok' }),
      maestroFactory: () => fakeMaestroAsProcess,
      workerManager: {} as never,
    });

    expect(fakeMaestro.startInput?.promptVars.registeredProjects).toBe('(none)');
    expect(fakeMaestro.startInput?.promptVars.projectName).toBe('(no project)');

    await handle.stop();
    await handle.done;
  });

  it('on stop(), tears down in reverse order: hook uninstalled → maestro killed → hook server stopped → rpc closed', async () => {
    const order: string[] = [];
    const fakeMaestro = new FakeMaestroProcess();
    const fakeMaestroAsProcess = fakeMaestro as unknown as MaestroProcess;
    Object.defineProperty(fakeMaestroAsProcess, 'events', {
      value: () => fakeMaestro.eventsIter(),
    });

    // Spy on kill via the FakeMaestroProcess.
    const origKill = fakeMaestro.kill.bind(fakeMaestro);
    fakeMaestro.kill = async (): Promise<undefined> => {
      order.push('maestro.kill');
      return origKill();
    };

    const hookServer = new MaestroHookServer({ token: 'tok' });
    const origStop = hookServer.stop.bind(hookServer);
    hookServer.stop = async (): Promise<void> => {
      order.push('hookServer.stop');
      return origStop();
    };

    const rpc = makeFakeRpc([]);
    rpc.close = vi.fn(async () => {
      order.push('rpc.close');
    });

    const handle = await runStart({
      home,
      cliEntryPath: '/fake/cli/entry.js',
      io: { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() },
      skipSignalHandlers: true,
      rpcOverride: { descriptor: { host: '127.0.0.1', port: 0, token: 't' }, client: rpc },
      hookServerFactory: () => hookServer,
      maestroFactory: () => fakeMaestroAsProcess,
      workerManager: {} as never,
    });

    // Settings file exists with SYMPHONY_HOOK_PORT before stop.
    const settingsPath = join(home, '.symphony', 'maestro', '.claude', 'settings.local.json');
    expect(readFileSync(settingsPath, 'utf8')).toContain('SYMPHONY_HOOK_PORT');

    await handle.stop();
    await handle.done;

    // Cleanup steps run in stack order (reverse of registration). Expected
    // (last → first): readline → uninstall → maestro.kill → hookServer.stop
    // → rpc.close. We don't track readline, but the rest must follow.
    const idxMaestro = order.indexOf('maestro.kill');
    const idxHook = order.indexOf('hookServer.stop');
    const idxRpc = order.indexOf('rpc.close');
    expect(idxMaestro).toBeLessThan(idxHook);
    expect(idxHook).toBeLessThan(idxRpc);

    // Hook entry was stripped.
    expect(readFileSync(settingsPath, 'utf8')).not.toContain('SYMPHONY_HOOK_PORT');
  });

  /*
   * Phase 3H.2 commit 5 audit M3: defaultProjectPath validation
   * branches.
   */
  it('threads validated defaultProjectPath into MaestroFactory deps (audit C1)', async () => {
    const projectDir = join(sandbox, 'valid-project');
    const { mkdirSync, writeFileSync } = await import('node:fs');
    mkdirSync(projectDir);
    mkdirSync(join(projectDir, '.git'));
    writeFileSync(join(projectDir, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');

    const cfgFile = join(sandbox, 'symphony-config.json');
    writeFileSync(
      cfgFile,
      JSON.stringify({ schemaVersion: 1, defaultProjectPath: projectDir }, null, 2),
      'utf8',
    );
    const prevEnv = process.env['SYMPHONY_CONFIG_FILE'];
    process.env['SYMPHONY_CONFIG_FILE'] = cfgFile;

    try {
      const fakeMaestro = new FakeMaestroProcess();
      const fakeMaestroAsProcess = fakeMaestro as unknown as MaestroProcess;
      Object.defineProperty(fakeMaestroAsProcess, 'events', {
        value: () => fakeMaestro.eventsIter(),
      });
      let factoryDeps: { defaultProjectPath?: string } | undefined;
      const handle = await runStart({
        home,
        cliEntryPath: '/fake/cli/entry.js',
        io: { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() },
        skipSignalHandlers: true,
        rpcOverride: { descriptor: { host: '127.0.0.1', port: 0, token: 't' }, client: makeFakeRpc([]) },
        hookServerFactory: () => new MaestroHookServer({ token: 'tok' }),
        maestroFactory: (deps) => {
          factoryDeps = deps;
          return fakeMaestroAsProcess;
        },
        workerManager: {} as never,
      });

      expect(factoryDeps?.defaultProjectPath).toBe(projectDir);

      await handle.stop();
      await handle.done;
    } finally {
      if (prevEnv === undefined) delete process.env['SYMPHONY_CONFIG_FILE'];
      else process.env['SYMPHONY_CONFIG_FILE'] = prevEnv;
    }
  });

  it('omits defaultProjectPath when path does not exist (warn + fall through)', async () => {
    const cfgFile = join(sandbox, 'symphony-config.json');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(
      cfgFile,
      JSON.stringify(
        { schemaVersion: 1, defaultProjectPath: join(sandbox, 'does-not-exist') },
        null,
        2,
      ),
      'utf8',
    );
    const prevEnv = process.env['SYMPHONY_CONFIG_FILE'];
    process.env['SYMPHONY_CONFIG_FILE'] = cfgFile;

    try {
      const fakeMaestro = new FakeMaestroProcess();
      const fakeMaestroAsProcess = fakeMaestro as unknown as MaestroProcess;
      Object.defineProperty(fakeMaestroAsProcess, 'events', {
        value: () => fakeMaestro.eventsIter(),
      });
      let factoryDeps: { defaultProjectPath?: string } | undefined;
      const stderr = new PassThrough();
      const stderrBufs: string[] = [];
      stderr.on('data', (chunk: Buffer) => stderrBufs.push(chunk.toString('utf8')));

      const handle = await runStart({
        home,
        cliEntryPath: '/fake/cli/entry.js',
        io: { stdin: new PassThrough(), stdout: new PassThrough(), stderr },
        skipSignalHandlers: true,
        rpcOverride: { descriptor: { host: '127.0.0.1', port: 0, token: 't' }, client: makeFakeRpc([]) },
        hookServerFactory: () => new MaestroHookServer({ token: 'tok' }),
        maestroFactory: (deps) => {
          factoryDeps = deps;
          return fakeMaestroAsProcess;
        },
        workerManager: {} as never,
      });

      expect(factoryDeps?.defaultProjectPath).toBeUndefined();
      expect(stderrBufs.join('')).toMatch(/not a valid git repo/);

      await handle.stop();
      await handle.done;
    } finally {
      if (prevEnv === undefined) delete process.env['SYMPHONY_CONFIG_FILE'];
      else process.env['SYMPHONY_CONFIG_FILE'] = prevEnv;
    }
  });

  it('omits defaultProjectPath when path exists but lacks .git', async () => {
    const projectDir = join(sandbox, 'plain-dir');
    const { mkdirSync, writeFileSync } = await import('node:fs');
    mkdirSync(projectDir);
    const cfgFile = join(sandbox, 'symphony-config.json');
    writeFileSync(
      cfgFile,
      JSON.stringify({ schemaVersion: 1, defaultProjectPath: projectDir }, null, 2),
      'utf8',
    );
    const prevEnv = process.env['SYMPHONY_CONFIG_FILE'];
    process.env['SYMPHONY_CONFIG_FILE'] = cfgFile;

    try {
      const fakeMaestro = new FakeMaestroProcess();
      const fakeMaestroAsProcess = fakeMaestro as unknown as MaestroProcess;
      Object.defineProperty(fakeMaestroAsProcess, 'events', {
        value: () => fakeMaestro.eventsIter(),
      });
      let factoryDeps: { defaultProjectPath?: string } | undefined;
      const handle = await runStart({
        home,
        cliEntryPath: '/fake/cli/entry.js',
        io: { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() },
        skipSignalHandlers: true,
        rpcOverride: { descriptor: { host: '127.0.0.1', port: 0, token: 't' }, client: makeFakeRpc([]) },
        hookServerFactory: () => new MaestroHookServer({ token: 'tok' }),
        maestroFactory: (deps) => {
          factoryDeps = deps;
          return fakeMaestroAsProcess;
        },
        workerManager: {} as never,
      });
      expect(factoryDeps?.defaultProjectPath).toBeUndefined();
      await handle.stop();
      await handle.done;
    } finally {
      if (prevEnv === undefined) delete process.env['SYMPHONY_CONFIG_FILE'];
      else process.env['SYMPHONY_CONFIG_FILE'] = prevEnv;
    }
  });

  it('omits defaultProjectPath when config does not set it', async () => {
    const fakeMaestro = new FakeMaestroProcess();
    const fakeMaestroAsProcess = fakeMaestro as unknown as MaestroProcess;
    Object.defineProperty(fakeMaestroAsProcess, 'events', {
      value: () => fakeMaestro.eventsIter(),
    });
    let factoryDeps: { defaultProjectPath?: string } | undefined;
    const handle = await runStart({
      home,
      cliEntryPath: '/fake/cli/entry.js',
      io: { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() },
      skipSignalHandlers: true,
      rpcOverride: { descriptor: { host: '127.0.0.1', port: 0, token: 't' }, client: makeFakeRpc([]) },
      hookServerFactory: () => new MaestroHookServer({ token: 'tok' }),
      maestroFactory: (deps) => {
        factoryDeps = deps;
        return fakeMaestroAsProcess;
      },
      workerManager: {} as never,
    });
    expect(factoryDeps?.defaultProjectPath).toBeUndefined();
    await handle.stop();
    await handle.done;
  });
});

/**
 * Phase 3Q — Reliability. SIGHUP / uncaughtException / unhandledRejection
 * routing, final "State saved" message, recovery RPC call.
 */
describe('runStart 3Q reliability', () => {
  it('calls rpc.call.recovery.report() after RPC connect and logs count when > 0', async () => {
    const fakeMaestro = new FakeMaestroProcess();
    const fakeMaestroAsProcess = fakeMaestro as unknown as MaestroProcess;
    Object.defineProperty(fakeMaestroAsProcess, 'events', {
      value: () => fakeMaestro.eventsIter(),
    });
    const rpc = makeFakeRpc([]);
    rpc.call.recovery.report = vi.fn(async () => ({
      crashedIds: ['w-1', 'w-2', 'w-3'],
      capturedAt: '2026-05-14T10:00:00.000Z',
    }));

    const stderr = new PassThrough();
    const stderrBufs: string[] = [];
    stderr.on('data', (c: Buffer) => stderrBufs.push(c.toString('utf8')));

    const handle = await runStart({
      home,
      cliEntryPath: '/fake/cli/entry.js',
      io: { stdin: new PassThrough(), stdout: new PassThrough(), stderr },
      skipSignalHandlers: true,
      rpcOverride: { descriptor: { host: '127.0.0.1', port: 0, token: 't' }, client: rpc },
      hookServerFactory: () => new MaestroHookServer({ token: 'tok' }),
      maestroFactory: () => fakeMaestroAsProcess,
      workerManager: {} as never,
    });

    expect(rpc.call.recovery.report).toHaveBeenCalledTimes(1);
    expect(stderrBufs.join('')).toMatch(/recovered 3 crashed workers from previous session/);

    await handle.stop();
    await handle.done;
  });

  it('omits recovery log line when crashedIds is empty', async () => {
    const fakeMaestro = new FakeMaestroProcess();
    const fakeMaestroAsProcess = fakeMaestro as unknown as MaestroProcess;
    Object.defineProperty(fakeMaestroAsProcess, 'events', {
      value: () => fakeMaestro.eventsIter(),
    });
    const rpc = makeFakeRpc([]);

    const stderr = new PassThrough();
    const stderrBufs: string[] = [];
    stderr.on('data', (c: Buffer) => stderrBufs.push(c.toString('utf8')));

    const handle = await runStart({
      home,
      cliEntryPath: '/fake/cli/entry.js',
      io: { stdin: new PassThrough(), stdout: new PassThrough(), stderr },
      skipSignalHandlers: true,
      rpcOverride: { descriptor: { host: '127.0.0.1', port: 0, token: 't' }, client: rpc },
      hookServerFactory: () => new MaestroHookServer({ token: 'tok' }),
      maestroFactory: () => fakeMaestroAsProcess,
      workerManager: {} as never,
    });

    expect(stderrBufs.join('')).not.toMatch(/recovered .* crashed worker/);

    await handle.stop();
    await handle.done;
  });

  it('writes "State saved" message on stderr after every cleanup step has run', async () => {
    const fakeMaestro = new FakeMaestroProcess();
    const fakeMaestroAsProcess = fakeMaestro as unknown as MaestroProcess;
    Object.defineProperty(fakeMaestroAsProcess, 'events', {
      value: () => fakeMaestro.eventsIter(),
    });
    const rpc = makeFakeRpc([]);

    const stderr = new PassThrough();
    const stderrBufs: string[] = [];
    stderr.on('data', (c: Buffer) => stderrBufs.push(c.toString('utf8')));

    const handle = await runStart({
      home,
      cliEntryPath: '/fake/cli/entry.js',
      io: { stdin: new PassThrough(), stdout: new PassThrough(), stderr },
      skipSignalHandlers: true,
      rpcOverride: { descriptor: { host: '127.0.0.1', port: 0, token: 't' }, client: rpc },
      hookServerFactory: () => new MaestroHookServer({ token: 'tok' }),
      maestroFactory: () => fakeMaestroAsProcess,
      workerManager: {} as never,
    });

    await handle.stop('test-shutdown');
    await handle.done;

    const out = stderrBufs.join('');
    expect(out).toMatch(/State saved\. Run `symphony start` to resume\./);
    // Ordering: the final message comes AFTER the diagnostic shutdown
    // logs (cleanup steps log via `[symphony start] cleanup ...`).
    const idxShutdown = out.indexOf('shutting down');
    const idxFinal = out.indexOf('State saved');
    expect(idxShutdown).toBeGreaterThanOrEqual(0);
    expect(idxFinal).toBeGreaterThan(idxShutdown);
  });

  it('registers SIGHUP / uncaughtException / unhandledRejection handlers and removes them on stop', async () => {
    const fakeMaestro = new FakeMaestroProcess();
    const fakeMaestroAsProcess = fakeMaestro as unknown as MaestroProcess;
    Object.defineProperty(fakeMaestroAsProcess, 'events', {
      value: () => fakeMaestro.eventsIter(),
    });

    const before = {
      sighup: process.listenerCount('SIGHUP'),
      uncaught: process.listenerCount('uncaughtException'),
      rejection: process.listenerCount('unhandledRejection'),
    };

    const handle = await runStart({
      home,
      cliEntryPath: '/fake/cli/entry.js',
      io: { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() },
      // skipSignalHandlers omitted → defaults to false → handlers register
      rpcOverride: { descriptor: { host: '127.0.0.1', port: 0, token: 't' }, client: makeFakeRpc([]) },
      hookServerFactory: () => new MaestroHookServer({ token: 'tok' }),
      maestroFactory: () => fakeMaestroAsProcess,
      workerManager: {} as never,
    });

    expect(process.listenerCount('SIGHUP')).toBe(before.sighup + 1);
    expect(process.listenerCount('uncaughtException')).toBe(before.uncaught + 1);
    expect(process.listenerCount('unhandledRejection')).toBe(before.rejection + 1);

    await handle.stop();
    await handle.done;

    expect(process.listenerCount('SIGHUP')).toBe(before.sighup);
    expect(process.listenerCount('uncaughtException')).toBe(before.uncaught);
    expect(process.listenerCount('unhandledRejection')).toBe(before.rejection);
  });

  it('SIGHUP triggers graceful stop', async () => {
    const fakeMaestro = new FakeMaestroProcess();
    const fakeMaestroAsProcess = fakeMaestro as unknown as MaestroProcess;
    Object.defineProperty(fakeMaestroAsProcess, 'events', {
      value: () => fakeMaestro.eventsIter(),
    });

    const stderr = new PassThrough();
    const stderrBufs: string[] = [];
    stderr.on('data', (c: Buffer) => stderrBufs.push(c.toString('utf8')));

    const handle = await runStart({
      home,
      cliEntryPath: '/fake/cli/entry.js',
      io: { stdin: new PassThrough(), stdout: new PassThrough(), stderr },
      // skipSignalHandlers omitted → handlers active
      rpcOverride: { descriptor: { host: '127.0.0.1', port: 0, token: 't' }, client: makeFakeRpc([]) },
      hookServerFactory: () => new MaestroHookServer({ token: 'tok' }),
      maestroFactory: () => fakeMaestroAsProcess,
      workerManager: {} as never,
    });

    // Emit SIGHUP — the runStart-registered handler runs `void stop('SIGHUP')`.
    process.emit('SIGHUP');
    await handle.done;

    const out = stderrBufs.join('');
    expect(out).toMatch(/shutting down: SIGHUP/);
    expect(out).toMatch(/State saved/);
    expect(fakeMaestro.killCount).toBe(1);
  });
});
