import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { buildClaudeArgs } from './args.js';
import { buildWorkerEnv } from './env.js';
import { encodeControlResponse } from './control-response.js';
import { resolveClaudePath } from './resolve.js';
import {
  deterministicSessionUuid,
  validateResumeSession,
} from './session.js';
import { parseStream } from './stream-parser.js';
import { ensureClaudeTrust } from './trust.js';
import type {
  KillSignal,
  StreamEvent,
  Worker,
  WorkerConfig,
  WorkerExitInfo,
  WorkerStatus,
} from './types.js';

const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;
const GRACE_PERIOD_MS = 8_000;

export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export interface WorkerManagerOptions {
  /** Override `ensureClaudeTrust` target for tests. */
  claudeConfigPath?: string;
  /** Override `~/.claude/projects` root for resume validation in tests. */
  claudeHome?: string;
  /** Stream child stderr through a hook (always-drained internally). */
  onWorkerStderr?: (workerId: string, chunk: string) => void;
  /** Hook fired when user-supplied extraEnv keys are blocklisted. */
  onBlockedEnv?: (workerId: string, key: string) => void;
  /** Hook fired when user-supplied extraArgs are filtered. */
  onFilteredArgs?: (workerId: string, flags: readonly string[]) => void;
  /**
   * Hook fired when `ensureClaudeTrust` fails. If set, the manager proceeds
   * with the spawn despite the failure (caller owns the consequences). If
   * unset, a trust failure THROWS from spawn — the default, because the
   * downstream symptom is a 20-minute interactive-dialog hang.
   */
  onTrustFailure?: (workerId: string, error: Error) => void;
  /**
   * Hook fired when a caller-supplied sessionId fails validation and the
   * policy is `'warn-and-fresh'`. Receives the worker id and the failure
   * reason. Called before the fresh session is started.
   */
  onStaleResume?: (workerId: string, reason: string) => void;
  /**
   * Inject a custom spawner. Tests use this to substitute a helper script
   * that ignores Symphony's hardcoded Claude flags. In production, defaults
   * to `child_process.spawn`.
   */
  spawn?: SpawnFn;
}

export type ClassifierInput = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stopIntent: 'none' | 'kill' | 'timeout' | 'interrupt';
  resultSeen: boolean;
  resultIsError: boolean;
};

export function classifyExit(input: ClassifierInput): WorkerStatus {
  if (input.stopIntent === 'timeout') return 'timeout';
  if (input.stopIntent === 'kill') return 'killed';
  // Phase 3T: user-pivot SIGTERM (Esc/Ctrl+C during Maestro streaming)
  // is a distinct terminal status so `list_workers` can re-dispatch and
  // the notifications dispatcher stays silent (like `killed`).
  if (input.stopIntent === 'interrupt') return 'interrupted';
  // Signaled death without stop-intent means the OS killed us (OOM, SIGSEGV,
  // SIGKILL from outside). Distinct retry policy: crashed workers should not
  // be retried on the same environment.
  if (input.signal !== null && input.exitCode === null) return 'crashed';
  if (input.resultSeen && input.resultIsError) return 'failed';
  if (input.exitCode === 0 && input.resultSeen) return 'completed';
  if (input.exitCode === 0 && !input.resultSeen) return 'failed';
  return 'failed';
}

/**
 * StopIntent precedence (Phase 3T): a later, higher-priority intent
 * MUST overwrite an earlier lower-priority one. Without this rule, a
 * user who pivots (`interrupt`) then immediately exits (`kill` via
 * `lifecycle.shutdown`) would see workers classified `interrupted`
 * post-mortem when shutdown semantically should win.
 */
const STOP_INTENT_PRIORITY: Record<'none' | 'kill' | 'timeout' | 'interrupt', number> = {
  none: 0,
  interrupt: 1,
  kill: 2,
  timeout: 3,
};

/**
 * Exported for white-box unit tests of the precedence ladder. Production
 * callers use this through `WorkerImpl.kill()` / `WorkerImpl.cancel()`.
 */
export function _stopIntentTakesPrecedence(
  next: 'kill' | 'timeout' | 'interrupt',
  current: 'none' | 'kill' | 'timeout' | 'interrupt',
): boolean {
  return STOP_INTENT_PRIORITY[next] > STOP_INTENT_PRIORITY[current];
}

function takesPrecedence(
  next: 'kill' | 'timeout' | 'interrupt',
  current: 'none' | 'kill' | 'timeout' | 'interrupt',
): boolean {
  return _stopIntentTakesPrecedence(next, current);
}

export class WorkerManager {
  private readonly workers = new Map<string, WorkerImpl>();
  private readonly inflight = new Map<string, Promise<Worker>>();
  private readonly stopIntents = new Set<string>();
  private shuttingDown = false;

  constructor(private readonly options: WorkerManagerOptions = {}) {}

  async spawn(cfg: WorkerConfig): Promise<Worker> {
    if (this.shuttingDown) {
      throw new Error('WorkerManager is shut down');
    }
    const key = `${cfg.id}::${cfg.cwd}`;
    const existing = this.inflight.get(key);
    if (existing !== undefined) return existing;

    const promise = this.startWorker(cfg, key);
    this.inflight.set(key, promise);
    // Register cleanup without creating an unhandled-rejection channel.
    // The caller observes rejection via their own await on `promise`.
    promise
      .finally(() => {
        if (this.inflight.get(key) === promise) this.inflight.delete(key);
      })
      .catch(() => {
        // rejection is observed by caller; swallow here to prevent
        // Node flagging the finally()-chained promise as unhandled
      });
    return promise;
  }

  list(): Worker[] {
    return Array.from(this.workers.values());
  }

  get(id: string): Worker | undefined {
    return this.workers.get(id);
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    const snapshot = Array.from(this.workers.values());
    this.workers.clear();
    this.inflight.clear();
    for (const worker of snapshot) {
      this.stopIntents.add(worker.id);
      try {
        worker.kill('SIGTERM');
      } catch {
        // best effort
      }
    }
    await Promise.all(
      snapshot.map((w) =>
        w.waitForExit().catch(() => {
          // exit errors during shutdown are expected
        }),
      ),
    );
  }

  private async startWorker(cfg: WorkerConfig, key: string): Promise<Worker> {
    const claudeHomeOpt = this.options.claudeHome ?? undefined;
    const claudeConfigOpt = this.options.claudeConfigPath ?? undefined;

    const trustResult = ensureClaudeTrust(cfg.cwd, {
      ...(claudeConfigOpt !== undefined ? { configPath: claudeConfigOpt } : {}),
      ...(claudeHomeOpt !== undefined ? { home: claudeHomeOpt } : {}),
      // Always route errors through our handler instead of console.warn so
      // the manager can decide: throw (default) or hand to onTrustFailure.
      onError: () => {
        // deliberate no-op — we re-check trustResult.error below
      },
    });
    if (trustResult.error !== undefined) {
      if (this.options.onTrustFailure !== undefined) {
        this.options.onTrustFailure(cfg.id, trustResult.error);
      } else {
        throw new Error(
          `worker ${cfg.id}: ensureClaudeTrust failed for ${cfg.cwd}: ${trustResult.error.message}. ` +
            `Without trust injection, claude -p will hang on the interactive trust dialog. ` +
            `Pass WorkerManagerOptions.onTrustFailure to override this check.`,
        );
      }
    }

    const sessionArg = this.chooseSessionArg(cfg, claudeHomeOpt);

    const { args, filtered } = buildClaudeArgs({
      cfg,
      ...(sessionArg !== undefined ? { sessionArg } : {}),
    });

    if (filtered !== undefined && filtered.length > 0) {
      this.options.onFilteredArgs?.(cfg.id, filtered);
    }

    const { env, blockedKeys } = buildWorkerEnv({
      ...(cfg.extraEnv !== undefined ? { extraEnv: cfg.extraEnv } : {}),
      ...(cfg.allowExtraEnvKeys !== undefined && cfg.allowExtraEnvKeys.length > 0
        ? { allowExtraEnvKeys: cfg.allowExtraEnvKeys }
        : {}),
    });
    for (const key of blockedKeys) this.options.onBlockedEnv?.(cfg.id, key);

    const claudeCmd = resolveClaudePath(cfg.claudePath);
    const spawner = this.options.spawn ?? nodeSpawn;
    const child = spawner(claudeCmd, args, {
      cwd: cfg.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
    });

    const worker = new WorkerImpl({
      id: cfg.id,
      child,
      stopIntents: this.stopIntents,
      onExit: (status, exitCode, signal) => {
        this.inflight.delete(key);
        if (this.workers.get(cfg.id) === worker) {
          this.workers.delete(cfg.id);
        }
        this.stopIntents.delete(cfg.id);
        void status;
        void exitCode;
        void signal;
      },
      ...(this.options.onWorkerStderr !== undefined
        ? { onStderr: this.options.onWorkerStderr }
        : {}),
    });

    this.workers.set(cfg.id, worker);
    worker.begin(cfg.prompt, cfg.keepStdinOpen ?? false, cfg.skipInitialPrompt ?? false);

    if (cfg.disableTimeout === true) {
      // Long-lived processes (Maestro) opt out of the spawn-side guard.
      // The caller is responsible for graceful kill on shutdown.
    } else if (cfg.timeoutMs !== undefined && cfg.timeoutMs > 0) {
      worker.armTimeout(cfg.timeoutMs);
    } else {
      worker.armTimeout(DEFAULT_TIMEOUT_MS);
    }

    if (cfg.signal !== undefined) {
      const signal = cfg.signal;
      const onAbort = (): void => worker.cancel('kill');
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    return worker;
  }

  private chooseSessionArg(
    cfg: WorkerConfig,
    home: string | undefined,
  ): { kind: 'resume' | 'new'; uuid: string } | undefined {
    if (cfg.sessionId !== undefined && cfg.sessionId.length > 0) {
      const validation = validateResumeSession({
        sessionId: cfg.sessionId,
        cwd: cfg.cwd,
        ...(home !== undefined ? { home } : {}),
      });
      if (validation.ok) {
        return { kind: 'resume', uuid: cfg.sessionId };
      }
      // Explicit sessionId failed validation. Policy-driven handling —
      // silent substitution would break Phase 2B DB reconciliation and
      // Phase 3 "resuming session X" TUI state.
      const policy = cfg.onStaleResume ?? 'reject';
      if (policy === 'reject') {
        throw new Error(
          `worker ${cfg.id}: requested resume session ${cfg.sessionId} is invalid (reason=${validation.reason}). ` +
            `Set onStaleResume to 'warn-and-fresh' or 'start-fresh' to opt into fallback.`,
        );
      }
      if (policy === 'warn-and-fresh') {
        this.options.onStaleResume?.(cfg.id, validation.reason);
      }
      // fall through to fresh session for 'warn-and-fresh' and 'start-fresh'
    }
    const stable =
      cfg.deterministicUuidInput !== undefined && cfg.deterministicUuidInput.length > 0
        ? cfg.deterministicUuidInput
        : cfg.id;
    return { kind: 'new', uuid: deterministicSessionUuid(stable) };
  }
}

// ── Internal Worker implementation ──

interface WorkerImplOptions {
  id: string;
  child: ChildProcess;
  stopIntents: Set<string>;
  onExit: (status: WorkerStatus, code: number | null, signal: NodeJS.Signals | null) => void;
  onStderr?: (workerId: string, chunk: string) => void;
}

const STDERR_TAIL_BYTES = 8 * 1024;

class WorkerImpl implements Worker {
  readonly id: string;
  private _sessionId: string | undefined = undefined;
  private _status: WorkerStatus = 'spawning';
  private readonly child: ChildProcess;
  private readonly stopIntents: Set<string>;
  private readonly broadcaster = new EventBroadcaster<StreamEvent>();
  private resultSeen = false;
  private resultIsError = false;
  private exitPromise: Promise<WorkerExitInfo>;
  private timeoutHandle: NodeJS.Timeout | undefined;
  private killFollowup: NodeJS.Timeout | undefined;
  private stopIntent: 'none' | 'kill' | 'timeout' | 'interrupt' = 'none';
  private readonly startTime = Date.now();
  private readonly onExit: WorkerImplOptions['onExit'];
  private readonly onStderr?: WorkerImplOptions['onStderr'];
  private keepStdinOpen = false;
  private stdinEnded = false;
  private stderrTail = '';

  constructor(opts: WorkerImplOptions) {
    this.id = opts.id;
    this.child = opts.child;
    this.stopIntents = opts.stopIntents;
    this.onExit = opts.onExit;
    if (opts.onStderr !== undefined) this.onStderr = opts.onStderr;
    this.exitPromise = new Promise<WorkerExitInfo>((resolve) => {
      this.child.on('exit', (code, signal) => {
        if (this.timeoutHandle !== undefined) clearTimeout(this.timeoutHandle);
        if (this.killFollowup !== undefined) clearTimeout(this.killFollowup);
        if (this.stopIntents.has(this.id) && this.stopIntent === 'none') {
          this.stopIntent = 'kill';
        }
        const status = classifyExit({
          exitCode: code,
          signal,
          stopIntent: this.stopIntent,
          resultSeen: this.resultSeen,
          resultIsError: this.resultIsError,
        });
        this._status = status;
        const exitInfo: WorkerExitInfo = {
          status,
          exitCode: code,
          signal,
          durationMs: Date.now() - this.startTime,
          ...(this._sessionId !== undefined ? { sessionId: this._sessionId } : {}),
          ...(this.stderrTail.length > 0 ? { stderrTail: this.stderrTail } : {}),
        };
        this.broadcaster.close();
        this.onExit(status, code, signal);
        resolve(exitInfo);
      });
    });

    // Always drain stderr — the kernel pipe buffer fills (~64KB Win11,
    // up to 1MB Linux) and the child blocks on fd 2 writes otherwise.
    if (this.child.stderr !== null) {
      this.child.stderr.setEncoding('utf8');
      this.child.stderr.on('data', (chunk: string) => {
        this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL_BYTES);
        this.onStderr?.(this.id, chunk);
      });
    }
  }

  get sessionId(): string | undefined {
    return this._sessionId;
  }

  get status(): WorkerStatus {
    return this._status;
  }

  get events(): AsyncIterable<StreamEvent> {
    return this.broadcaster;
  }

  sendFollowup(text: string): void {
    if (this._status !== 'running') {
      throw new Error(`worker ${this.id} is ${this._status}; cannot send follow-up`);
    }
    if (this.stdinEnded) {
      throw new Error(
        `worker ${this.id}: stdin is closed; spawn with keepStdinOpen=true for multi-turn sessions`,
      );
    }
    this.writeUserMessage(text);
  }

  endInput(): void {
    if (this.stdinEnded) return;
    this.stdinEnded = true;
    try {
      this.child.stdin?.end();
    } catch {
      // best effort
    }
  }

  kill(signal: KillSignal = 'SIGTERM', intent: 'kill' | 'timeout' | 'interrupt' = 'kill'): void {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    this.stopIntents.add(this.id);
    // Phase 3T: honor precedence — a higher-priority intent overwrites a
    // lower-priority earlier write, but lower-priority intents do not
    // clobber a stronger reason already recorded.
    if (takesPrecedence(intent, this.stopIntent)) this.stopIntent = intent;
    try {
      this.child.kill(signal);
    } catch {
      // best effort
    }
    if (signal === 'SIGTERM') {
      if (this.killFollowup !== undefined) clearTimeout(this.killFollowup);
      this.killFollowup = setTimeout(() => {
        if (this.child.exitCode === null && this.child.signalCode === null) {
          try {
            this.child.kill('SIGKILL');
          } catch {
            // best effort
          }
        }
      }, GRACE_PERIOD_MS);
    }
    this.closeStdio();
  }

  waitForExit(): Promise<WorkerExitInfo> {
    return this.exitPromise;
  }

  begin(prompt: string, keepStdinOpen: boolean, skipInitialPrompt: boolean): void {
    this._status = 'running';
    this.keepStdinOpen = keepStdinOpen;
    if (!skipInitialPrompt) {
      this.writeUserMessage(prompt);
    }
    void this.drain();
  }

  armTimeout(ms: number): void {
    if (this.timeoutHandle !== undefined) clearTimeout(this.timeoutHandle);
    this.timeoutHandle = setTimeout(() => {
      this.cancel('timeout');
    }, ms);
  }

  cancel(kind: 'kill' | 'timeout' | 'interrupt'): void {
    this.stopIntents.add(this.id);
    if (takesPrecedence(kind, this.stopIntent)) this.stopIntent = kind;
    try {
      this.child.kill('SIGTERM');
    } catch {
      // best effort
    }
    if (this.killFollowup !== undefined) clearTimeout(this.killFollowup);
    this.killFollowup = setTimeout(() => {
      if (this.child.exitCode === null && this.child.signalCode === null) {
        try {
          this.child.kill('SIGKILL');
        } catch {
          // best effort
        }
      }
    }, GRACE_PERIOD_MS);
    this.closeStdio();
  }

  private async drain(): Promise<void> {
    const stdout = this.child.stdout;
    if (stdout === null) {
      this.broadcaster.close();
      return;
    }
    try {
      for await (const event of parseStream(stdout)) {
        this.handleEvent(event);
        this.broadcaster.push(event);
      }
    } catch (err) {
      this.broadcaster.pushError(err instanceof Error ? err : new Error(String(err)));
    }
  }

  private handleEvent(event: StreamEvent): void {
    if (event.type === 'system_init') {
      this._sessionId = event.sessionId;
      return;
    }
    if (event.type === 'result') {
      this._sessionId = event.sessionId;
      this.resultSeen = true;
      this.resultIsError = event.isError;
      if (!this.keepStdinOpen && !this.stdinEnded) {
        this.stdinEnded = true;
        try {
          this.child.stdin?.end();
        } catch {
          // best effort
        }
      }
      return;
    }
    if (event.type === 'control_request') {
      const stdin = this.child.stdin;
      if (stdin !== null && !stdin.writableEnded) {
        try {
          stdin.write(encodeControlResponse(event));
        } catch {
          // best effort
        }
      }
    }
  }

  private writeUserMessage(text: string): void {
    const payload = {
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'text', text }],
      },
    };
    const stdin = this.child.stdin;
    if (stdin === null || stdin.writableEnded) {
      throw new Error(`worker ${this.id} stdin is not writable`);
    }
    stdin.write(JSON.stringify(payload) + '\n');
  }

  private closeStdio(): void {
    try {
      this.child.stdin?.end();
    } catch {
      // best effort
    }
    this.stdinEnded = true;
    try {
      this.child.stdout?.destroy();
    } catch {
      // best effort
    }
    try {
      this.child.stderr?.destroy();
    } catch {
      // best effort
    }
  }
}

// ── Event broadcaster — true fan-out to every consumer ──

type Waiter<T> = (result: IteratorResult<T>) => void;

const DEFAULT_CONSUMER_BUFFER = 4096;

interface Subscriber<T> {
  buffer: T[];
  waiter: Waiter<T> | undefined;
  dropped: number;
}

class EventBroadcaster<T> implements AsyncIterable<T> {
  private readonly subscribers = new Set<Subscriber<T>>();
  // Anything pushed before the first subscriber attaches is buffered so
  // consumers that attach slightly late still see the session's start.
  private readonly preSubscribeBacklog: T[] = [];
  private readonly backlogCap = DEFAULT_CONSUMER_BUFFER;
  private closed = false;
  private error: Error | undefined;

  push(item: T): void {
    if (this.closed) return;
    if (this.subscribers.size === 0) {
      if (this.preSubscribeBacklog.length < this.backlogCap) {
        this.preSubscribeBacklog.push(item);
      }
      return;
    }
    for (const sub of this.subscribers) {
      if (sub.waiter !== undefined) {
        const waiter = sub.waiter;
        sub.waiter = undefined;
        waiter({ value: item, done: false });
      } else if (sub.buffer.length < this.backlogCap) {
        sub.buffer.push(item);
      } else {
        sub.dropped += 1;
      }
    }
  }

  pushError(err: Error): void {
    this.error = err;
    this.close();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const sub of this.subscribers) {
      const waiter = sub.waiter;
      sub.waiter = undefined;
      if (waiter !== undefined) {
        waiter({ value: undefined as never, done: true });
      }
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    const sub: Subscriber<T> = {
      buffer: [...this.preSubscribeBacklog],
      waiter: undefined,
      dropped: 0,
    };
    this.subscribers.add(sub);
    let errorSeenLocally = false;

    return {
      next: (): Promise<IteratorResult<T>> => {
        if (sub.buffer.length > 0) {
          const value = sub.buffer.shift()!;
          return Promise.resolve({ value, done: false });
        }
        if (this.closed) {
          if (this.error !== undefined && !errorSeenLocally) {
            errorSeenLocally = true;
            return Promise.reject(this.error);
          }
          this.subscribers.delete(sub);
          return Promise.resolve({ value: undefined as never, done: true });
        }
        return new Promise<IteratorResult<T>>((resolve) => {
          sub.waiter = resolve;
        });
      },
      return: (): Promise<IteratorResult<T>> => {
        sub.waiter = undefined;
        this.subscribers.delete(sub);
        return Promise.resolve({ value: undefined as never, done: true });
      },
    };
  }
}
