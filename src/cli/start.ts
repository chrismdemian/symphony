import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { promises as fsp } from 'node:fs';

import { RpcClient } from '../rpc/client.js';
import type { SymphonyRouter } from '../rpc/router-impl.js';
import { prependTsxLoaderIfTs } from '../utils/node-runner.js';
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
import { runTui } from '../ui/runtime/runTui.js';
import type { TuiRpc } from '../ui/runtime/rpc.js';
import { loadConfig } from '../utils/config.js';

const SYMPHONY_VERSION = '0.0.0';

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
  /**
   * Phase 3H.1 — when `'settings'`, the TUI opens the settings popup
   * once on mount (used by `symphony config` to land directly on it).
   * Threaded through to `runTui({ initialPopup })`.
   */
  initialPopup?: string;
}

/**
 * RPC surface the launcher consumes — the union of (a) the readline path's
 * needs (`projects.list` + `close`) AND (b) the TUI's needs (`TuiRpc` =
 * call/subscribe/close projection of `RpcClient<SymphonyRouter>`).
 *
 * The production path passes the real `RpcClient<SymphonyRouter>`, which
 * structurally satisfies both. Tests inject a fake matching this shape;
 * the readline-path scenarios only need `call.projects.list` + `close`
 * but must provide stub implementations for the wider TUI surface to
 * type-check.
 *
 * Audit M1 (Phase 3A): the previous `LauncherRpc` was narrow and the TUI
 * call site used `as unknown as TuiRpc` — type drift hidden behind a
 * double cast. Widening eliminates the cast.
 */
export type LauncherRpc = TuiRpc;

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
    const loggedArgs = prependTsxLoaderIfTs(bootstrapArgs);
    log(`spawning bootstrap mcp-server: ${nodeBinary} ${loggedArgs.join(' ')}`);

    const bootstrap = (options.spawnBootstrap ?? defaultSpawnBootstrap(nodeBinary))(
      bootstrapArgs,
      {
        env: { ...process.env, NODE_NO_WARNINGS: '1' },
      },
    );
    bootstrap.stdout?.on('data', () => {});
    // Mirror the bootstrap's stderr through to ours so the user sees errors,
    // AND scan it for the `symphony.rpc.ready` advert (audit 2C.2 M2). The
    // advert is a single JSON line prefixed with `[symphony] `; we capture
    // the most recent one so an `awaitRpcReady` timeout can surface it.
    let capturedAdvert: Record<string, unknown> | undefined;
    let stderrTail = '';
    bootstrap.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      stderr.write(`[bootstrap] ${text}`);
      stderrTail += text;
      // Cap memory: only retain the trailing 16 KB of stderr for advert
      // scanning. A single advert line is well under 1 KB.
      if (stderrTail.length > 16_384) {
        stderrTail = stderrTail.slice(stderrTail.length - 16_384);
      }
      let nl: number;
      while ((nl = stderrTail.indexOf('\n')) !== -1) {
        const line = stderrTail.slice(0, nl);
        stderrTail = stderrTail.slice(nl + 1);
        const idx = line.indexOf('[symphony] ');
        if (idx === -1) continue;
        const json = line.slice(idx + '[symphony] '.length).trim();
        if (json.length === 0) continue;
        try {
          const parsed = JSON.parse(json) as unknown;
          if (
            parsed !== null &&
            typeof parsed === 'object' &&
            !Array.isArray(parsed) &&
            (parsed as Record<string, unknown>)['event'] === 'symphony.rpc.ready'
          ) {
            capturedAdvert = parsed as Record<string, unknown>;
          }
        } catch {
          // Non-JSON `[symphony]` line — ignore. Adverts are always JSON.
        }
      }
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
        // Audit m7: Win32 + `shell:true` SIGTERM kills the cmd.exe wrapper,
        // not the inner Node child. Use `taskkill /pid /T /F` to walk the
        // process tree. POSIX paths still use SIGTERM → SIGKILL escalation.
        try {
          if (isWin32 && bootstrap.pid !== undefined) {
            killWin32Tree(bootstrap.pid);
          } else {
            bootstrap.kill('SIGTERM');
          }
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
      capturedAdvert: () => capturedAdvert,
      onStaleDescriptor: ({ foundPid, expectedPid }) => {
        log(
          `awaitRpcReady: stale descriptor pid=${foundPid} (expected ${expectedPid}); continuing to poll`,
        );
      },
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

  // Phase 3H.2 — read modelMode from config for Maestro's prompt. Boot
  // configuration; mid-session changes via `<leader>m` apply to NEW
  // spawns but Maestro's per-task model decision logic only re-reads at
  // next start (changing the mid-session prompt would leak into the
  // conversation history). `loadConfig` is documented to never throw —
  // every error path returns defaults — so no defensive .catch.
  const bootConfig = await loadConfig();
  const modelMode = bootConfig.config.modelMode;

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
    modelMode,
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
  log(
    startResult.systemInit.sessionId !== undefined
      ? `Maestro ready (session ${startResult.systemInit.sessionId})`
      : `Maestro ready (session pending — claude emits system_init after first user message)`,
  );

  // ── 5. UI loop ─────────────────────────────────────────────────────────
  // Phase 3A: prefer the Ink TUI. Falls back to the prior 2C.2 readline
  // path on non-TTY stdout (CI, piped output) — Ink's alt-screen would
  // otherwise emit ANSI to a pipe.
  //
  // Audit C1: `runTui` itself gates on BOTH stdin.isTTY AND stdout.isTTY.
  // Non-TTY stdin would crash Ink at `useInput` → `setRawMode`. The
  // readline fallback handles all non-TTY shapes.
  // Audit M1: `rpc` is `LauncherRpc = TuiRpc` so no cast needed.
  const tui = runTui({
    maestro,
    rpc,
    version: SYMPHONY_VERSION,
    onRequestExit: () => {
      void stop('user exit (Ctrl+C)');
    },
    stdin: stdin as NodeJS.ReadStream,
    stdout: stdout as NodeJS.WriteStream,
    ...(options.initialPopup !== undefined ? { initialPopup: options.initialPopup } : {}),
  });

  if (tui.active) {
    cleanup.push({
      label: 'unmount TUI',
      run: tui.unmount,
    });
    void tui.exited.then(() => {
      // Ink unmount → tear the launcher down through the shared cleanup
      // chain (audit 2C.2 m3 — every shutdown path goes through `stop()`).
      void stop('TUI exited');
    });
    return { stop, done };
  }

  // ── Fallback: readline loop (non-TTY / CI) ─────────────────────────────
  log('non-TTY stdio detected — falling back to readline prompt');

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

/**
 * Resolve the CLI entry path (the file `node` should run for `mcp-server`).
 *
 * Three layouts are valid:
 *   - Source dev:           `src/cli/start.ts`  → `src/index.ts`
 *   - Bundled with cli/ dir: `dist/cli/start.js` → `dist/index.js`
 *   - Bundled inline:        `dist/index.js`     → `dist/index.js` (self)
 *
 * The bundled-inline case is what tsup produces today (splitting: false +
 * single entry; `start.ts` is inlined). The Commander entry in `index.ts`
 * dispatches `mcp-server` from the same file, so returning self is safe.
 * Callers can override via `RunStartOptions.cliEntryPath`.
 */
export function defaultCliEntryPath(): string {
  return resolveCliEntryFromHere(fileURLToPath(import.meta.url));
}

/**
 * Pure helper for `defaultCliEntryPath`. Exposed so the layout invariant
 * has a unit test that doesn't depend on `import.meta.url`.
 */
export function resolveCliEntryFromHere(here: string): string {
  const dir = path.dirname(here);
  const dirName = path.basename(dir);
  const ext = path.extname(here);
  const baseNoExt = path.basename(here, ext);

  // Bundled-inline case: tsup inlines `start.ts` into the index entry
  // (`dist/index.js`). `mcp-server` dispatches from the same file via
  // Commander — return self.
  if (baseNoExt === 'index') return here;

  // Source / split-bundle case: walk to sibling `index.{ts,js}`.
  if (dirName === 'cli') {
    return path.join(path.dirname(dir), `index${ext}`);
  }

  throw new Error(
    `defaultCliEntryPath: unable to resolve CLI entry from '${here}'. ` +
      `Expected an 'index.{ts,js}' file or a file in a 'cli/' subdir. ` +
      `Set RunStartOptions.cliEntryPath explicitly to override.`,
  );
}

/**
 * Walk + kill a Windows process tree. The bootstrap is sometimes spawned
 * via `shell: true` (when `process.execPath` resolves to a `.cmd` shim);
 * SIGTERM in that case kills only the `cmd.exe` wrapper, leaving the
 * inner `node.exe` orphaned. `taskkill /pid <pid> /T /F` walks the tree
 * by parent-pid relation and force-kills every node (audit 2C.2 m7).
 */
function killWin32Tree(pid: number): void {
  // Best-effort — taskkill can race with natural exit; non-zero exit is
  // expected when the process already terminated. We swallow the result.
  spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], {
    windowsHide: true,
    stdio: 'ignore',
  });
}

function defaultSpawnBootstrap(nodeBinary: string): BootstrapSpawnFn {
  return (args, opts) => {
    const finalArgs = prependTsxLoaderIfTs(args);
    return spawn(nodeBinary, [...finalArgs], {
      ...opts,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: isWin32 && nodeBinary.endsWith('.cmd'),
    });
  };
}

function defaultWorkerManager(homeDir: string): WorkerManager {
  const claudeConfigPath = path.join(homeDir, '.claude.json');
  return new WorkerManager({
    claudeConfigPath,
    claudeHome: homeDir,
    onWorkerStderr: (workerId, chunk) => {
      // Surface claude subprocess stderr through the launcher's stderr so
      // boot failures (e.g., Maestro's claude exiting before system_init)
      // are diagnosable without manually tailing logs. Each line is
      // prefixed with the worker id; chunks are emitted as-is so partial
      // lines stay together. Also captures Maestro's stderr.
      process.stderr.write(`[claude:${workerId}] ${chunk}`);
    },
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
