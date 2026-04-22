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
  /** Stream child stderr through a hook (default: ignore). */
  onWorkerStderr?: (workerId: string, chunk: string) => void;
  /** Hook fired when user-supplied extraEnv keys are blocklisted. */
  onBlockedEnv?: (workerId: string, key: string) => void;
  /** Hook fired when user-supplied extraArgs are filtered. */
  onFilteredArgs?: (workerId: string, flags: readonly string[]) => void;
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
  stopIntent: 'none' | 'kill' | 'timeout';
  resultSeen: boolean;
  resultIsError: boolean;
};

export function classifyExit(input: ClassifierInput): WorkerStatus {
  if (input.stopIntent === 'timeout') return 'timeout';
  if (input.stopIntent === 'kill') return 'killed';
  if (input.resultSeen && input.resultIsError) return 'failed';
  if (input.exitCode === 0 && input.resultSeen) return 'completed';
  if (input.exitCode === 0 && !input.resultSeen) return 'failed';
  return 'failed';
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
    promise.finally(() => {
      if (this.inflight.get(key) === promise) this.inflight.delete(key);
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

    ensureClaudeTrust(cfg.cwd, {
      ...(claudeConfigOpt !== undefined ? { configPath: claudeConfigOpt } : {}),
      ...(claudeHomeOpt !== undefined ? { home: claudeHomeOpt } : {}),
    });

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
    worker.begin(cfg.prompt, cfg.keepStdinOpen ?? false);

    if (cfg.timeoutMs !== undefined && cfg.timeoutMs > 0) {
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

class WorkerImpl implements Worker {
  readonly id: string;
  private _sessionId: string | undefined = undefined;
  private _status: WorkerStatus = 'spawning';
  private readonly child: ChildProcess;
  private readonly stopIntents: Set<string>;
  private readonly queue = new AsyncEventQueue<StreamEvent>();
  private resultSeen = false;
  private resultIsError = false;
  private exitPromise: Promise<WorkerExitInfo>;
  private timeoutHandle: NodeJS.Timeout | undefined;
  private killFollowup: NodeJS.Timeout | undefined;
  private stopIntent: 'none' | 'kill' | 'timeout' = 'none';
  private readonly startTime = Date.now();
  private readonly onExit: WorkerImplOptions['onExit'];
  private readonly onStderr?: WorkerImplOptions['onStderr'];
  private keepStdinOpen = false;
  private stdinEnded = false;

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
        };
        this.queue.close();
        this.onExit(status, code, signal);
        resolve(exitInfo);
      });
    });

    if (this.onStderr && this.child.stderr !== null) {
      this.child.stderr.setEncoding('utf8');
      this.child.stderr.on('data', (chunk: string) => {
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
    return this.queue;
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

  kill(signal: KillSignal = 'SIGTERM'): void {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    this.stopIntents.add(this.id);
    if (this.stopIntent === 'none') this.stopIntent = 'kill';
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

  begin(prompt: string, keepStdinOpen: boolean): void {
    this._status = 'running';
    this.keepStdinOpen = keepStdinOpen;
    this.writeUserMessage(prompt);
    void this.drain();
  }

  armTimeout(ms: number): void {
    if (this.timeoutHandle !== undefined) clearTimeout(this.timeoutHandle);
    this.timeoutHandle = setTimeout(() => {
      this.cancel('timeout');
    }, ms);
  }

  cancel(kind: 'kill' | 'timeout'): void {
    this.stopIntents.add(this.id);
    this.stopIntent = kind;
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
      this.queue.close();
      return;
    }
    try {
      for await (const event of parseStream(stdout)) {
        this.handleEvent(event);
        this.queue.push(event);
      }
    } catch (err) {
      this.queue.pushError(err instanceof Error ? err : new Error(String(err)));
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

// ── Async event queue (single-consumer fan-out target) ──

type Waiter<T> = (result: IteratorResult<T>) => void;

class AsyncEventQueue<T> implements AsyncIterable<T> {
  private buffer: T[] = [];
  private waiters: Waiter<T>[] = [];
  private closed = false;
  private error: Error | undefined;

  push(item: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter !== undefined) {
      waiter({ value: item, done: false });
      return;
    }
    this.buffer.push(item);
  }

  pushError(err: Error): void {
    this.error = err;
    this.close();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const waiters = this.waiters;
    this.waiters = [];
    for (const waiter of waiters) {
      waiter({ value: undefined as never, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.buffer.length > 0) {
          const value = this.buffer.shift()!;
          return Promise.resolve({ value, done: false });
        }
        if (this.closed) {
          if (this.error !== undefined) {
            const err = this.error;
            this.error = undefined;
            return Promise.reject(err);
          }
          return Promise.resolve({ value: undefined as never, done: true });
        }
        return new Promise<IteratorResult<T>>((resolve) => {
          this.waiters.push(resolve);
        });
      },
    };
  }
}
