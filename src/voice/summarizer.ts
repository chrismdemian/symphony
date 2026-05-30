import { spawn } from 'node:child_process';
import type { ChildProcessByStdio } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { Readable, Writable } from 'node:stream';

import { buildVoiceEnv, resolveVoiceEnv } from './env.js';
import { voicePythonPackageDir } from './path.js';
import { heuristicSummarize, type Summarizer } from '../state/transcript-store.js';

/**
 * Phase 6D.2 — Node manager for the local T5 ONNX summarizer subprocess
 * (`src/voice/python/summarizer.py`).
 *
 * Contract: `summarize(texts)` NEVER throws. Any failure — venv missing,
 * model not downloaded, spawn error, subprocess crash, timeout, or a
 * per-request error — falls back to the deterministic
 * `heuristicSummarize`. Once the subprocess proves unavailable the
 * instance stays `degraded` (heuristic for the rest of its life) so a
 * doomed subprocess isn't respawned on every compaction tick.
 *
 * Lifecycle: lazy-spawn on first `summarize()`; `close()` shuts the
 * subprocess down. The capture runner's compaction is single-flight, so a
 * single in-flight request at a time is sufficient — requests are still
 * correlated by a monotonic id for safety.
 *
 * The Node `LocalSummarizer.summarize` satisfies the `Summarizer` type,
 * so it drops straight into `runVoiceCapture({ summarizer })`.
 */

const READY_TIMEOUT_MS = 60_000; // model load (~1-2s) + cold ORT init headroom
const SUMMARIZE_TIMEOUT_MS = 60_000; // greedy decode on CPU can be seconds
const SHUTDOWN_GRACE_MS = 2_000;
const READLINE_MAX_LINE_BYTES = 10 * 1024 * 1024;

type ChildHandle = ChildProcessByStdio<Writable, Readable, Readable>;

export interface LocalSummarizerOptions {
  /** Home dir override (tests). Default `os.homedir()`. */
  readonly homeDir?: string;
  /** Python executable override (tests). Default: resolved voice venv. */
  readonly pythonPath?: string;
  /** Script path override (tests — a fake `.mjs`). Default `<pkg>/summarizer.py`. */
  readonly scriptPath?: string;
  /** Python package dir override (tests). */
  readonly pythonPackageDir?: string;
  /** Pre-resolved model dir passed as `--model-dir` (tests / non-HF-cache layout). */
  readonly modelDir?: string;
  /** Process env override. Default `process.env`. */
  readonly sourceEnv?: NodeJS.ProcessEnv;
  /** Platform override (tests). */
  readonly platform?: NodeJS.Platform;
  /** Per-request timeout (ms). */
  readonly summarizeTimeoutMs?: number;
  /** Boot/ready timeout (ms). */
  readonly readyTimeoutMs?: number;
  /** Optional sink for child stderr lines. Default: drop (compaction is silent). */
  readonly onStderr?: (line: string) => void;
}

interface PendingRequest {
  readonly id: number;
  resolve(text: string): void;
  timer: NodeJS.Timeout;
}

export class LocalSummarizer {
  private readonly opts: LocalSummarizerOptions;
  private child: ChildHandle | undefined;
  private rl: readline.Interface | undefined;
  private startPromise: Promise<boolean> | undefined;
  private degraded = false;
  private closed = false;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readyResolve: ((ok: boolean) => void) | undefined;
  private readyTimer: NodeJS.Timeout | undefined;

  constructor(options: LocalSummarizerOptions = {}) {
    this.opts = options;
  }

  /** True once the subprocess has been ruled out and only the heuristic runs. */
  get isDegraded(): boolean {
    return this.degraded;
  }

  /**
   * The `Summarizer` adapter — bound so it can be passed directly as
   * `runVoiceCapture({ summarizer: local.toSummarizer() })`.
   */
  toSummarizer(): Summarizer {
    return (texts) => this.summarize(texts);
  }

  /** Summarize a batch. NEVER throws — falls back to the heuristic. */
  async summarize(texts: readonly string[]): Promise<string> {
    const arr = [...texts];
    if (this.closed || this.degraded) return heuristicSummarize(arr);

    const started = await this.ensureStarted();
    if (!started || this.child === undefined) {
      this.degraded = true;
      return heuristicSummarize(arr);
    }

    const id = this.nextId++;
    const timeoutMs = this.opts.summarizeTimeoutMs ?? SUMMARIZE_TIMEOUT_MS;
    try {
      const text = await new Promise<string | null>((resolve) => {
        const timer = setTimeout(() => {
          this.pending.delete(id);
          // A timed-out request means the subprocess is wedged — degrade.
          this.degraded = true;
          void this.killChild();
          resolve(null);
        }, timeoutMs);
        timer.unref();
        this.pending.set(id, {
          id,
          timer,
          resolve: (t: string) => resolve(t),
        });
        this.write({ cmd: 'summarize', id, texts: arr });
      });
      // `null` => timeout/degrade; per-request error already resolved to ''.
      if (text === null || text.length === 0) return heuristicSummarize(arr);
      return text;
    } catch {
      this.degraded = true;
      return heuristicSummarize(arr);
    }
  }

  /** Graceful shutdown. Idempotent. */
  async close(): Promise<void> {
    this.closed = true;
    const child = this.child;
    if (child === undefined) return;
    // Reject-as-fallback any in-flight requests.
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.resolve('');
    }
    this.pending.clear();
    try {
      if (child.stdin.writable) {
        child.stdin.write(JSON.stringify({ cmd: 'shutdown' }) + '\n', () => undefined);
      }
    } catch {
      // pipe already gone
    }
    const exited = await this.waitForExit(SHUTDOWN_GRACE_MS);
    if (!exited) await this.killChild();
    this.cleanup();
  }

  // ----- internals --------------------------------------------------------

  private ensureStarted(): Promise<boolean> {
    if (this.startPromise === undefined) {
      this.startPromise = this.start().catch(() => false);
    }
    return this.startPromise;
  }

  private async start(): Promise<boolean> {
    const platform = this.opts.platform ?? process.platform;
    const homeDir = this.opts.homeDir ?? os.homedir();

    let pythonPath: string;
    let venvDir = '';
    if (this.opts.pythonPath !== undefined) {
      pythonPath = this.opts.pythonPath;
    } else {
      const summary = resolveVoiceEnv(homeDir);
      if (!summary.exists) return false; // no venv → heuristic
      pythonPath = summary.pythonPath;
      venvDir = summary.venvDir;
    }

    const pkgDir = this.opts.pythonPackageDir ?? voicePythonPackageDir();
    const scriptPath = this.opts.scriptPath ?? path.join(pkgDir, 'summarizer.py');
    const args = [scriptPath];
    if (this.opts.modelDir !== undefined) args.push('--model-dir', this.opts.modelDir);

    const { env } = buildVoiceEnv({
      sourceEnv: this.opts.sourceEnv ?? process.env,
      platform,
      venvDir,
      homeDir,
    });

    let child: ChildHandle;
    try {
      child = spawn(pythonPath, args, {
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
        windowsHide: true,
      }) as ChildHandle;
    } catch {
      return false;
    }
    this.child = child;
    this.attachStreams(child);

    const ok = await new Promise<boolean>((resolve) => {
      this.readyResolve = resolve;
      this.readyTimer = setTimeout(() => {
        this.readyResolve = undefined;
        resolve(false);
      }, this.opts.readyTimeoutMs ?? READY_TIMEOUT_MS);
      this.readyTimer.unref();
      child.on('error', () => {
        if (this.readyResolve !== undefined) {
          this.readyResolve = undefined;
          resolve(false);
        }
      });
      child.on('exit', () => {
        // Pre-ready crash → resolve start() false (→ degraded below).
        // Post-ready (mid-session) crash → degrade NOW (audit-C1): otherwise
        // the next summarize() passes the child guard (this.child still set),
        // writes to the dead pipe, and stalls the full summarizeTimeoutMs
        // (or hangs forever on a drained event loop, since the timer is
        // unref'd). Setting degraded short-circuits the next call to the
        // heuristic at the top of summarize().
        if (this.readyResolve !== undefined) {
          this.readyResolve = undefined;
          resolve(false);
        } else {
          this.degraded = true;
        }
        this.failAllPending();
      });
    });
    if (this.readyTimer !== undefined) clearTimeout(this.readyTimer);
    if (!ok) {
      this.degraded = true;
      await this.killChild();
    }
    return ok;
  }

  private attachStreams(child: ChildHandle): void {
    this.rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.rl.on('line', (raw) => {
      const line = raw.length > READLINE_MAX_LINE_BYTES ? raw.slice(0, READLINE_MAX_LINE_BYTES) : raw;
      this.handleLine(line.trim());
    });
    const stderrRl = readline.createInterface({ input: child.stderr, crlfDelay: Infinity });
    stderrRl.on('line', (line) => {
      if (this.opts.onStderr !== undefined) this.opts.onStderr(line);
    });
  }

  private handleLine(line: string): void {
    if (line.length === 0) return;
    let msg: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed !== 'object' || parsed === null) return;
      msg = parsed as Record<string, unknown>;
    } catch {
      return; // transport noise
    }
    const type = msg.type;
    if (type === 'ready') {
      if (this.readyResolve !== undefined) {
        const r = this.readyResolve;
        this.readyResolve = undefined;
        r(true);
      }
      return;
    }
    if (type === 'error' && msg.fatal === true) {
      if (this.readyResolve !== undefined) {
        const r = this.readyResolve;
        this.readyResolve = undefined;
        r(false);
      }
      return;
    }
    if (type === 'summary' || type === 'error') {
      const id = typeof msg.id === 'number' ? msg.id : undefined;
      if (id === undefined) return;
      const p = this.pending.get(id);
      if (p === undefined) return;
      this.pending.delete(id);
      clearTimeout(p.timer);
      // On a per-request error, resolve '' → the summarize() path maps
      // empty to the heuristic fallback for that call (subprocess stays up).
      p.resolve(type === 'summary' && typeof msg.text === 'string' ? msg.text : '');
    }
  }

  private write(obj: Record<string, unknown>): void {
    const child = this.child;
    if (child === undefined || !child.stdin.writable) return;
    try {
      child.stdin.write(JSON.stringify(obj) + '\n', () => undefined);
    } catch {
      // pipe gone — the pending request will time out → fallback
    }
  }

  private failAllPending(): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.resolve('');
    }
    this.pending.clear();
  }

  private waitForExit(timeoutMs: number): Promise<boolean> {
    const child = this.child;
    if (child === undefined) return Promise.resolve(true);
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      timer.unref();
      child.once('exit', () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  private async killChild(): Promise<void> {
    const child = this.child;
    if (child === undefined) return;
    if (child.exitCode !== null || child.signalCode !== null) return;
    if (process.platform === 'win32') {
      const pid = child.pid;
      if (pid !== undefined) {
        try {
          const { spawn: spawnKill } = await import('node:child_process');
          spawnKill('taskkill', ['/pid', String(pid), '/T', '/F'], {
            stdio: 'ignore',
            windowsHide: true,
          });
        } catch {
          try {
            child.kill('SIGKILL');
          } catch {
            // already dead
          }
        }
      }
    } else {
      try {
        child.kill('SIGKILL');
      } catch {
        // already dead
      }
    }
    await this.waitForExit(SHUTDOWN_GRACE_MS);
  }

  private cleanup(): void {
    try {
      this.rl?.close();
    } catch {
      // ignore
    }
    this.rl = undefined;
    this.child = undefined;
  }
}
