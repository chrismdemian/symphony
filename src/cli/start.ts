import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { promises as fsp } from 'node:fs';

import { RpcClient } from '../rpc/client.js';
import type { SymphonyRouter } from '../rpc/router-impl.js';
import type { ProjectSnapshot } from '../projects/types.js';
import { WorkerManager } from '../workers/manager.js';
import {
  MaestroProcess,
  MaestroHookServer,
  installStopHook,
  uninstallStopHook,
  ensureMaestroWorkspace,
  awaitRpcReady,
  type MaestroEvent,
  type MaestroPromptVars,
  type HookPayload,
} from '../orchestrator/maestro/index.js';

const isWin32 = process.platform === 'win32';
const SHUTDOWN_DEADLINE_MS = 5_000;

export interface RunStartOptions {
  /** Pass `--in-memory` to the bootstrap mcp-server (debug). Default false. */
  inMemory?: boolean;
  /** Override the bootstrap mcp-server bind port (0 = ephemeral). */
  rpcPort?: number;
  /** Override `cliEntryPath` (tests). Default derived from `import.meta.url`. */
  cliEntryPath?: string;
  /** Override the Node binary used for the bootstrap subprocess. */
  nodeBinary?: string;
  /**
   * Override the spawn factory (tests). Production calls `child_process.spawn`.
   * The factory MUST return a `ChildProcess` whose `stderr` carries the
   * `symphony.rpc.ready` advert.
   */
  spawnBootstrap?: BootstrapSpawnFn;
  /** Override input/output streams (tests). Default `process.stdin`/`process.stdout`. */
  io?: {
    stdin: NodeJS.ReadableStream;
    stdout: NodeJS.WritableStream;
    stderr?: NodeJS.WritableStream;
  };
  /** Override `os.homedir()` for the Maestro workspace + claude trust file. */
  home?: string;
  /**
   * Skip installing `SIGINT` / `SIGTERM` handlers on the parent process.
   * Tests set this to avoid leaking handlers across vitest runs.
   */
  skipSignalHandlers?: boolean;
  /** Override the WorkerManager (tests). */
  workerManager?: WorkerManager;
  /** Override the MaestroProcess factory (tests). */
  maestroFactory?: MaestroFactory;
  /** Override the MaestroHookServer factory (tests). */
  hookServerFactory?: () => MaestroHookServer;
  /**
   * Override `awaitRpcReady`/`RpcClient.connect` for tests. When set, the
   * launcher skips spawning a real bootstrap subprocess. Used only by the
   * unit suite — the production path always spawns + awaits.
   */
  rpcOverride?: {
    descriptor: { host: string; port: number; token: string };
    client: LauncherRpc;
  };
}

/**
 * Minimal RPC surface the launcher actually consumes. The production path
 * passes an `RpcClient<SymphonyRouter>` (structurally compatible); tests
 * inject a fake matching this shape so they don't need to construct the
 * full router (which carries 5+ namespaces).
 */
export interface LauncherRpc {
  call: {
    projects: {
      list: (args: Record<string, unknown>) => Promise<ProjectSnapshot[]>;
    };
  };
  close: () => Promise<void>;
}

export type BootstrapSpawnFn = (
  args: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv },
) => ChildProcess;

export type MaestroFactory = (deps: {
  workerManager: WorkerManager;
  cliEntryPath: string;
  nodeBinary: string;
  home?: string;
  inMemory?: boolean;
}) => MaestroProcess;

export interface RunStartHandle {
  readonly stop: (reason?: string) => Promise<void>;
  /** Resolves when the readline loop exits (Ctrl+D or graceful shutdown). */
  readonly done: Promise<void>;
}

/**
 * `symphony start` entry point. Boots a long-lived Maestro subprocess, wires
 * the Stop-hook receiver, and runs a throwaway readline chat loop until the
 * Phase 3 TUI lands.
 *
 * Topology mirrors the 2C.1 scenario test (`tests/scenarios/2c1.test.ts:62-83`):
 *  - launcher spawns `node <cli> mcp-server --rpc-token-file <tmp>` for the
 *    bootstrap RPC channel (used to RPC-resolve `{registered_projects}`)
 *  - Maestro's MCP child (spawned by Claude via `--mcp-config`) runs as a
 *    second mcp-server with the default `~/.symphony/rpc.json` descriptor
 *  - Both share state via SQLite WAL. `--in-memory` is a debug flag only.
 *
 * Returns a handle whose `done` promise resolves when the loop exits cleanly
 * (Ctrl+D, SIGTERM, or `stop()`). Always cleans up: uninstalls the hook,
 * kills Maestro, stops the hook server, closes RPC, kills the bootstrap.
 */
export async function runStart(options: RunStartOptions = {}): Promise<RunStartHandle> {
  const cliEntryPath = options.cliEntryPath ?? defaultCliEntryPath();
  const nodeBinary = options.nodeBinary ?? process.execPath;
  const stdin = options.io?.stdin ?? process.stdin;
  const stdout = options.io?.stdout ?? process.stdout;
  const stderr = options.io?.stderr ?? process.stderr;

  const cleanup: Array<{ label: string; run: () => Promise<void> }> = [];
  let stopping = false;
  let resolveDone: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  const log = (line: string): void => {
    stderr.write(`[symphony start] ${line}\n`);
  };

  const stop = async (reason?: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    if (reason !== undefined) log(`shutting down: ${reason}`);
    const deadline = setTimeout(() => {
      log(`graceful shutdown exceeded ${SHUTDOWN_DEADLINE_MS}ms — forcing exit`);
      try {
        process.exit(1);
      } catch {
        // already exiting
      }
    }, SHUTDOWN_DEADLINE_MS);
    deadline.unref?.();
    while (cleanup.length > 0) {
      const step = cleanup.pop()!;
      try {
        await step.run();
      } catch (err) {
        log(`cleanup step '${step.label}' failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    clearTimeout(deadline);
    resolveDone();
  };

  const sigintHandler = (): void => {
    void stop('SIGINT');
  };
  const sigtermHandler = (): void => {
    void stop('SIGTERM');
  };
  if (options.skipSignalHandlers !== true) {
    process.once('SIGINT', sigintHandler);
    process.once('SIGTERM', sigtermHandler);
    cleanup.push({
      label: 'remove signal handlers',
      run: async () => {
        process.off('SIGINT', sigintHandler);
        process.off('SIGTERM', sigtermHandler);
      },
    });
  }

  // ── 1. Bootstrap mcp-server subprocess ─────────────────────────────────
  let rpcDescriptorPath: string | undefined;
  let rpc: LauncherRpc;
  if (options.rpcOverride !== undefined) {
    rpc = options.rpcOverride.client;
    cleanup.push({
      label: 'close RPC client',
      run: async () => {
        await rpc.close().catch(() => {});
      },
    });
  } else {
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'symphony-start-'));
    rpcDescriptorPath = path.join(tmpDir, 'rpc.json');
    cleanup.push({
      label: 'remove tmp RPC descriptor',
      run: async () => {
        await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      },
    });

    const bootstrapArgs = [
      cliEntryPath,
      'mcp-server',
      '--rpc-port',
      String(options.rpcPort ?? 0),
      '--rpc-token-file',
      rpcDescriptorPath,
    ];
    if (options.inMemory === true) bootstrapArgs.push('--in-memory');
    log(`spawning bootstrap mcp-server: ${nodeBinary} ${bootstrapArgs.join(' ')}`);

    const bootstrap = (options.spawnBootstrap ?? defaultSpawnBootstrap(nodeBinary))(
      bootstrapArgs,
      {
        env: { ...process.env, NODE_NO_WARNINGS: '1' },
      },
    );
    bootstrap.stdout?.on('data', () => {});
    // Mirror the bootstrap's stderr through to ours so the user sees errors.
    bootstrap.stderr?.on('data', (chunk: Buffer) => {
      stderr.write(`[bootstrap] ${chunk.toString('utf8')}`);
    });
    cleanup.push({
      label: 'kill bootstrap mcp-server',
      run: async () => {
        // Audit M6: attach the exit listener BEFORE checking exitCode. If
        // the child exited mid-await, the once('exit') listener registered
        // after-the-fact never fires and we hang until the deadline.
        const exitPromise = new Promise<void>((resolve) => {
          if (bootstrap.exitCode !== null || bootstrap.signalCode !== null) {
            resolve();
            return;
          }
          bootstrap.once('exit', () => resolve());
        });
        if (bootstrap.exitCode !== null || bootstrap.signalCode !== null) return;
        const sigKillTimer = setTimeout(() => {
          try {
            bootstrap.kill('SIGKILL');
          } catch {
            // already dead
          }
        }, 3_000);
        sigKillTimer.unref?.();
        try {
          bootstrap.kill('SIGTERM');
        } catch {
          // already dead
        }
        await exitPromise;
        clearTimeout(sigKillTimer);
      },
    });

    const bootstrapPid = bootstrap.pid;
    const descriptor = await awaitRpcReady({
      descriptorPath: rpcDescriptorPath,
      ...(bootstrapPid !== undefined ? { acceptOnlyPid: bootstrapPid } : {}),
    });
    log(`bootstrap RPC ready at ws://${descriptor.host}:${descriptor.port}/`);

    rpc = (await RpcClient.connect<SymphonyRouter>({
      url: `ws://${descriptor.host}:${descriptor.port}/`,
      token: descriptor.token,
    })) as unknown as LauncherRpc;
    cleanup.push({
      label: 'close RPC client',
      run: async () => {
        await rpc.close().catch(() => {});
      },
    });
  }

  // ── 2. Resolve `{registered_projects}` via RPC ─────────────────────────
  const projects = await rpc.call.projects.list({});
  const registeredProjects =
    projects.length === 0
      ? '(none)'
      : projects.map((p) => `- ${p.name} → ${p.path}`).join('\n');

  // ── 3. Maestro workspace + Stop hook installation ──────────────────────
  const workspaceOpts = options.home !== undefined ? { home: options.home } : {};
  const workspace = await ensureMaestroWorkspace(workspaceOpts);
  const claudeDir = path.join(workspace.cwd, '.claude');

  const hookServer = (options.hookServerFactory ?? (() => new MaestroHookServer()))();
  const { port: hookPort, token: hookToken } = await hookServer.start();
  cleanup.push({
    label: 'stop hook server',
    run: async () => {
      await hookServer.stop().catch(() => {});
    },
  });

  // ── 4. Spawn Maestro (constructed first so the hook listener can wire
  //      injectIdle BEFORE installStopHook makes the server reachable) ────
  const workerManager =
    options.workerManager ?? defaultWorkerManager(options.home ?? process.env['HOME'] ?? process.env['USERPROFILE'] ?? '');
  const maestroFactoryDeps: Parameters<MaestroFactory>[0] = {
    workerManager,
    cliEntryPath,
    nodeBinary,
  };
  if (options.home !== undefined) maestroFactoryDeps.home = options.home;
  if (options.inMemory === true) maestroFactoryDeps.inMemory = true;
  const maestro = (options.maestroFactory ?? defaultMaestroFactory)(maestroFactoryDeps);
  cleanup.push({
    label: 'kill Maestro',
    run: async () => {
      await maestro.kill('SIGTERM').catch(() => {});
    },
  });

  // Audit M1: register the listener BEFORE installStopHook so any Stop
  // POST that arrives between hook-install and maestro.start is observable
  // (would otherwise 200-fan-out-to-zero-listeners and silently drop).
  // Audit M3: also push a dedicated listener-deregistration cleanup step
  // BEFORE maestro.kill so a hook fire during kill() doesn't drop into
  // injectIdle's `stoppedFlag` no-op (debug confusion only — but worth it).
  const idleHandler = (payload: HookPayload): void => {
    maestro.injectIdle(payload);
  };
  hookServer.on('stop', idleHandler);
  cleanup.push({
    label: "deregister hookServer 'stop' listener",
    run: async () => {
      hookServer.off('stop', idleHandler);
    },
  });

  await installStopHook({ claudeDir, port: hookPort });
  cleanup.push({
    label: 'uninstall Stop hook',
    run: async () => {
      await uninstallStopHook({ claudeDir }).catch(() => {});
    },
  });

  const promptVars: MaestroPromptVars = {
    projectName: projects.length > 0 ? projects[0]!.name : '(no project)',
    registeredProjects,
    workersInFlight: '(none)',
    currentMode: 'PLAN',
    autonomyDefault: '1',
    planModeRequired: false,
    previewCommand: '',
    availableTools: '',
    maestroWarmth: '',
  };

  // Audit M5: wire `maestro.on('error', ...)` so a fatal Maestro error
  // (parse_error mid-stream, lost system_init post-resume, etc.) tears
  // the launcher down instead of leaving the readline loop spinning at
  // a dead worker.
  const errorHandler = (event: { type: 'error'; reason: string }): void => {
    void stop(`maestro error: ${event.reason}`);
  };
  maestro.on('error', errorHandler);
  cleanup.push({
    label: "deregister maestro 'error' listener",
    run: async () => {
      maestro.off('error', errorHandler);
    },
  });

  const startResult = await maestro.start({
    promptVars,
    extraEnv: {
      SYMPHONY_HOOK_PORT: String(hookPort),
      SYMPHONY_HOOK_TOKEN: hookToken,
    },
  });
  log(`Maestro ready (session ${startResult.systemInit.sessionId})`);

  // ── 5. Readline loop ───────────────────────────────────────────────────
  const rl = createInterface({
    input: stdin,
    output: stdout,
    terminal: false,
  });
  cleanup.push({
    label: 'close readline',
    run: async () => {
      try {
        rl.close();
      } catch {
        // already closed
      }
    },
  });

  let busy = false;
  const printPrompt = (): void => {
    stdout.write('> ');
  };
  pumpMaestroEvents({
    maestro,
    stdout,
    stderr,
    onIdle: () => {
      busy = false;
      printPrompt();
    },
    onError: () => {
      busy = false;
      printPrompt();
    },
  });

  // Initial prompt invitation — Maestro is up; user can type.
  printPrompt();

  rl.on('line', (raw: string) => {
    const line = raw.trim();
    if (line.length === 0) {
      printPrompt();
      return;
    }
    if (busy) {
      stderr.write('[busy — waiting for previous turn to finish]\n');
      return;
    }
    busy = true;
    try {
      maestro.sendUserMessage(line);
    } catch (err) {
      busy = false;
      stderr.write(`[send failed: ${err instanceof Error ? err.message : String(err)}]\n`);
      printPrompt();
    }
  });
  rl.once('close', () => {
    void stop('readline closed');
  });

  return { stop, done };
}

function defaultCliEntryPath(): string {
  const here = fileURLToPath(import.meta.url);
  const cliDir = path.dirname(here);
  const root = path.dirname(cliDir);
  const ext = path.extname(here);
  return path.join(root, `index${ext}`);
}

function defaultSpawnBootstrap(nodeBinary: string): BootstrapSpawnFn {
  return (args, opts) =>
    spawn(nodeBinary, [...args], {
      ...opts,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: isWin32 && nodeBinary.endsWith('.cmd'),
    });
}

function defaultWorkerManager(homeDir: string): WorkerManager {
  const claudeConfigPath = path.join(homeDir, '.claude.json');
  return new WorkerManager({
    claudeConfigPath,
    claudeHome: homeDir,
  });
}

const defaultMaestroFactory: MaestroFactory = (deps) => {
  const processDeps: ConstructorParameters<typeof MaestroProcess>[0] = {
    workerManager: deps.workerManager,
    cliEntryPath: deps.cliEntryPath,
    nodeBinary: deps.nodeBinary,
  };
  if (deps.home !== undefined) processDeps.home = deps.home;
  if (deps.inMemory === true) processDeps.inMemory = true;
  return new MaestroProcess(processDeps);
};

interface PumpInput {
  maestro: MaestroProcess;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  onIdle: () => void;
  onError: () => void;
}

function pumpMaestroEvents(input: PumpInput): void {
  void (async () => {
    for await (const event of input.maestro.events()) {
      handleEvent(event, input);
    }
  })().catch(() => {
    // Event stream closed (Maestro exited). Shutdown is driven elsewhere.
  });
}

function handleEvent(event: MaestroEvent, input: PumpInput): void {
  switch (event.type) {
    case 'assistant_text':
      input.stdout.write(event.text);
      // Streaming chunks: don't append a trailing newline ourselves;
      // Maestro's text already contains newlines where appropriate.
      break;
    case 'assistant_thinking':
      // Phase 3 TUI will render thinking blocks distinctly. For 2C.2's
      // throwaway loop, route to stderr so they don't pollute stdout.
      input.stderr.write(`[thinking] ${event.text}\n`);
      break;
    case 'tool_use':
      input.stderr.write(`[tool] ${event.name}\n`);
      break;
    case 'tool_result':
      // Tool results are noisy (per-MCP-call); only log errors in the loop.
      if (event.isError) {
        input.stderr.write(`[tool error] ${event.content.slice(0, 200)}\n`);
      }
      break;
    case 'turn_started':
      // No-op — `busy` is set when sendUserMessage returns.
      break;
    case 'turn_completed':
      // Newline before the Stop hook lands so the result text is flushed.
      input.stdout.write('\n');
      break;
    case 'idle':
      input.onIdle();
      break;
    case 'error':
      input.stderr.write(`[error] ${event.reason}\n`);
      input.onError();
      break;
    case 'system_init':
      // Already logged by runStart.
      break;
  }
}
