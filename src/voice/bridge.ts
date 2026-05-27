import { spawn } from 'node:child_process';
import type { ChildProcessByStdio } from 'node:child_process';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { Readable, Writable } from 'node:stream';

import { buildVoiceEnv, resolveVoiceEnv } from './env.js';
import { voicePythonPackageDir } from './path.js';
import type {
  VoiceAudioBackend,
  VoiceBridgeCommand,
  VoiceBridgeEvent,
} from './types.js';

/**
 * Phase 6A — Node-side manager for the long-lived Python voice bridge.
 *
 * Owns: child process lifecycle (spawn / stop / kill), JSON-line stdin
 * command protocol, JSON-line stdout event parser, stderr passthrough
 * with `[voice-bridge] ` prefix, optional inputPcm pipe for diagnose /
 * integration testing.
 *
 * Does NOT own: model loading, audio device init, or VAD computation —
 * those live inside the Python subprocess. The bridge is a transport.
 *
 * Design choices:
 *   - `spawn(..., { shell: false })`. Win32's `shell: true` + SIGTERM
 *     doesn't kill the child tree (2A.4b M1 / 3Q precedent). The python
 *     executable is launched directly from the venv, no shim resolution
 *     required.
 *   - `readline.createInterface` on stdout for newline-delimited JSON.
 *     `lineMaxLength` cap at 10 MB (1A scanner-buffer precedent). The
 *     largest 6A event is ~150 bytes; 6B STT `partial` / `final` events
 *     are short text (50-300 chars typical, bounded by Moonshine's own
 *     output and the 30s hard-cap on utterance length). 10 MB cap is
 *     defense against a stderr-via-stdout misroute. If a future change
 *     pipes worker stdout through this readline, follow the audit-m1
 *     raw-`data`-listener pattern (Multica scanner precedent).
 *   - Graceful shutdown: write `{"cmd":"shutdown"}\n`, await
 *     `shutdown_ack` event or 5 s deadline; then SIGTERM; then 1 s
 *     deadline; then SIGKILL (Win32: taskkill /T /F).
 *
 * The class is intentionally narrow — every event is fan-out through
 * the EventEmitter, no internal state caching of events. Consumers
 * decide what to retain.
 */

const READLINE_MAX_LINE_BYTES = 10 * 1024 * 1024;
const SHUTDOWN_GRACE_MS = 5_000;
const SIGTERM_GRACE_MS = 1_000;
const STDERR_TAIL_CAP = 16 * 1024;

export interface VoiceBridgeStartOptions {
  /**
   * Source of PCM the bridge consumes. `'mic'` opens the system mic
   * via the bundled audio backend. `'stdin-pcm'` reads raw 16-bit
   * mono PCM from the child's stdin — used by `runVoiceDiagnose` and
   * integration tests so no real microphone is required.
   */
  readonly inputMode: 'mic' | 'stdin-pcm';
  readonly sampleRate?: number;
  readonly frameSamples?: number;
  readonly vadThreshold?: number;
  readonly vadMinSpeechMs?: number;
  readonly vadMinSilenceMs?: number;
  /** Force a specific audio backend (mic mode only). */
  readonly forceBackend?: 'sounddevice' | 'pyaudio';
  /** Phase 6B — disable STT (VAD-only mode, 6A behavior). Default: STT enabled. */
  readonly sttEnabled?: boolean;
  /** Phase 6B — Moonshine model id. Default 'moonshine/base'. */
  readonly sttModel?: 'moonshine/base' | 'moonshine/tiny';
  /** Phase 6B — hard cap on utterance length before force-flush + warning. */
  readonly maxUtteranceSeconds?: number;
  /** Phase 6B — partial-cadence in ms while a segment is recording. */
  readonly partialIntervalMs?: number;
  /**
   * Phase 6B — vocab substitution file paths. Repeated (NOT
   * comma-joined; Windows paths can contain commas). Later layers
   * override earlier ones on key collision (project overrides
   * user-global). Default: [] (no substitutions).
   */
  readonly sttVocabPaths?: readonly string[];
  /** Override the venv directory (tests). */
  readonly venvDir?: string;
  /** Override the Python source package dir (tests). */
  readonly pythonPackageDir?: string;
  /**
   * Override the script path directly. Defaults to
   * `<pythonPackageDir>/voice_bridge.py`. Unit tests use this to swap
   * in a `.mjs` fake bridge that Node can interpret as ESM
   * (`.py` extension is rejected by Node's ESM loader).
   */
  readonly scriptPath?: string;
  /** Process env override. Default: `process.env`. */
  readonly sourceEnv?: NodeJS.ProcessEnv;
  /** Platform override (tests). Default: `process.platform`. */
  readonly platform?: NodeJS.Platform;
  /** Home dir override (tests). Default: `os.homedir()`. */
  readonly homeDir?: string;
  /** Override the Python executable path (tests / non-default venv). */
  readonly pythonPath?: string;
  /**
   * Optional sink for child stderr. Default: every line written to
   * `process.stderr` with `[voice-bridge] ` prefix.
   */
  readonly onStderr?: (line: string) => void;
}

export interface VoiceBridgeStopOptions {
  /** Override the graceful-shutdown deadline. */
  readonly graceMs?: number;
}

interface ChildIO {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
}

type ChildHandle = ChildProcessByStdio<Writable, Readable, Readable>;

export type VoiceBridgeStatus =
  | { readonly kind: 'idle' }
  | { readonly kind: 'starting'; readonly pid: number }
  | { readonly kind: 'ready'; readonly pid: number; readonly backend: VoiceAudioBackend }
  | {
      readonly kind: 'stopped';
      readonly exitCode: number | null;
      readonly signal: NodeJS.Signals | null;
    };

/**
 * Listener signatures the bridge fans out. We can't use declaration-merging
 * (eslint blocks class/interface merge for safety) so we just type each
 * listener via the typed event names at the call site. The base EventEmitter
 * `on(event, listener)` accepts any signature; consumers narrow via the
 * VoiceBridgeEvent discriminated union inside the listener body.
 */

export class VoiceBridge extends EventEmitter {
  constructor() {
    super();
    // Attach a no-op listener for the `'error'` channel — without
    // this, Node's EventEmitter throws `ERR_UNHANDLED_ERROR` when an
    // `error` event fires before any consumer has subscribed. Voice
    // bridge `error` events are diagnostic, NOT fatal — the bridge
    // continues processing audio after one.
    this.on('error', () => {
      /* swallow until a consumer attaches; the 'event' channel still fires */
    });
  }

  private child: ChildHandle | undefined;
  private readlineIface: readline.Interface | undefined;
  private status: VoiceBridgeStatus = { kind: 'idle' };
  private inputMode: 'mic' | 'stdin-pcm' | undefined;
  private readyResolvers: Array<(e: Extract<VoiceBridgeEvent, { type: 'ready' }>) => void> = [];
  private readyRejector: ((cause: Error) => void) | undefined;
  private shutdownAckResolvers: Array<() => void> = [];
  private exitWaiters: Array<(info: { exitCode: number | null; signal: NodeJS.Signals | null }) => void> =
    [];
  private stderrTailBytes = 0;
  private stderrTailChunks: string[] = [];

  /**
   * Spawn the bridge subprocess. Resolves to a typed `ready` event when
   * the child emits it. Rejects (and tears down the child) on any of:
   *   - spawn failure (ENOENT / EACCES / EMFILE / EPERM)
   *   - child exits before emitting `ready`
   *   - 30 s timeout (Silero cold-start is 1-6 s; we leave generous headroom)
   */
  async start(opts: VoiceBridgeStartOptions): Promise<Extract<VoiceBridgeEvent, { type: 'ready' }>> {
    if (this.status.kind !== 'idle' && this.status.kind !== 'stopped') {
      throw new VoiceBridgeError(
        'already-running',
        `VoiceBridge.start called while status is '${this.status.kind}'`,
      );
    }

    const platform = opts.platform ?? process.platform;
    const homeDir = opts.homeDir ?? os.homedir();
    let pythonPath: string;
    let venvDir: string;
    if (opts.pythonPath !== undefined) {
      pythonPath = opts.pythonPath;
      venvDir = opts.venvDir ?? '';
    } else {
      const summary = resolveVoiceEnv(homeDir);
      if (!summary.exists) {
        throw new VoiceBridgeError(
          'voice-env-missing',
          `Python venv not found at ${summary.pythonPath}. Run \`symphony voice install\`.`,
        );
      }
      pythonPath = summary.pythonPath;
      venvDir = opts.venvDir ?? summary.venvDir;
    }
    const pkgDir = opts.pythonPackageDir ?? voicePythonPackageDir();
    const scriptPath = opts.scriptPath ?? path.join(pkgDir, 'voice_bridge.py');

    // PYTHONUNBUFFERED=1 in buildVoiceEnv already does what `python -u`
    // does, AND it lets the same argv layout work when the spawned
    // binary is `node` (unit tests' fake bridge) — node rejects -u.
    const args = [scriptPath, '--input-mode', opts.inputMode];
    if (opts.sampleRate !== undefined) args.push('--sample-rate', String(opts.sampleRate));
    if (opts.frameSamples !== undefined) args.push('--frame-samples', String(opts.frameSamples));
    if (opts.vadThreshold !== undefined) args.push('--vad-threshold', String(opts.vadThreshold));
    if (opts.vadMinSpeechMs !== undefined) {
      args.push('--vad-min-speech-ms', String(opts.vadMinSpeechMs));
    }
    if (opts.vadMinSilenceMs !== undefined) {
      args.push('--vad-min-silence-ms', String(opts.vadMinSilenceMs));
    }
    if (opts.forceBackend !== undefined) {
      args.push('--force-backend', opts.forceBackend);
    }
    // Phase 6B — STT flags. Default STT enabled; passing
    // `sttEnabled: false` adds the `--no-stt` flag for VAD-only mode
    // (6A behavior).
    if (opts.sttEnabled === false) {
      args.push('--no-stt');
    }
    if (opts.sttModel !== undefined) {
      args.push('--stt-model', opts.sttModel);
    }
    if (opts.maxUtteranceSeconds !== undefined) {
      args.push('--max-utterance-seconds', String(opts.maxUtteranceSeconds));
    }
    if (opts.partialIntervalMs !== undefined) {
      args.push('--partial-interval-ms', String(opts.partialIntervalMs));
    }
    if (opts.sttVocabPaths !== undefined) {
      for (const p of opts.sttVocabPaths) {
        // Repeated --stt-vocab-path (NOT comma-joined). Windows paths
        // can contain commas/spaces; argparse `action='append'` handles
        // this cleanly.
        args.push('--stt-vocab-path', p);
      }
    }

    const { env } = buildVoiceEnv({
      sourceEnv: opts.sourceEnv ?? process.env,
      platform,
      venvDir,
      homeDir,
    });

    let child: ChildHandle;
    try {
      // shell: false — Win32 SIGTERM-tree behavior depends on the
      // absence of a cmd.exe wrapper (3Q / 2A.4b M1 precedent).
      child = spawn(pythonPath, args, {
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
        windowsHide: true,
      }) as ChildHandle;
    } catch (cause) {
      throw new VoiceBridgeError(
        'spawn-failed',
        `failed to spawn ${pythonPath}: ${describeError(cause)}`,
      );
    }

    this.child = child;
    this.inputMode = opts.inputMode;
    this.status = { kind: 'starting', pid: child.pid ?? -1 };

    this.attachStreams(child as unknown as ChildIO, opts.onStderr);
    this.attachExitHandlers(child);

    // Await ready (or rejection)
    try {
      const ready = await this.awaitReady(30_000);
      this.status = { kind: 'ready', pid: child.pid ?? -1, backend: ready.backend };
      return ready;
    } catch (cause) {
      // Tear down the half-spawned child on init failure.
      await this.forceStop().catch(() => undefined);
      throw cause;
    }
  }

  /** True when the child is past `ready` and accepting commands / audio. */
  get isReady(): boolean {
    return this.status.kind === 'ready';
  }

  /** Current status (idle / starting / ready / stopped). */
  getStatus(): VoiceBridgeStatus {
    return this.status;
  }

  /** Underlying child handle. Exposed for `runVoiceDiagnose` to pipe PCM into stdin. */
  get childStdin(): Writable | undefined {
    return this.child?.stdin ?? undefined;
  }

  /**
   * Write one JSON command to the child's stdin. Returns when the
   * write callback fires (or rejects if the pipe is dead).
   *
   * NOTE: in `--input-mode stdin-pcm`, stdin IS the PCM stream — the
   * Python side doesn't read commands from stdin in that mode. Calling
   * `send()` in stdin-pcm mode is a programmer error; the type system
   * doesn't enforce it but the docstring does.
   */
  async send(command: VoiceBridgeCommand): Promise<void> {
    if (this.child === undefined) {
      throw new VoiceBridgeError('not-running', 'VoiceBridge.send called before start');
    }
    const stdin = this.child.stdin;
    if (stdin === null || stdin.destroyed) {
      throw new VoiceBridgeError('stdin-closed', 'voice bridge stdin is closed');
    }
    const line = JSON.stringify(command) + '\n';
    await new Promise<void>((resolve, reject) => {
      stdin.write(line, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  /**
   * Graceful shutdown. In `mic` mode: sends `{"cmd":"shutdown"}`,
   * awaits `shutdown_ack` or `graceMs` (default 5 s), then SIGTERM
   * with 1 s grace, then SIGKILL. Win32 uses `taskkill /T /F` for the
   * final stage (2A.4b M1 / 3Q precedent).
   *
   * In `stdin-pcm` mode: stdin IS the PCM stream — there is no Python
   * stdin command reader. The bridge typically exits on stdin EOF
   * after the caller's `stdin.end()`, emitting `shutdown_ack` on the
   * way out. If `stop()` is called without prior `stdin.end()` (e.g.
   * abort), we go straight to force-stop.
   */
  async stop(opts: VoiceBridgeStopOptions = {}): Promise<void> {
    const child = this.child;
    if (child === undefined) return;
    if (child.exitCode !== null || child.signalCode !== null) {
      return;
    }

    const graceMs = opts.graceMs ?? SHUTDOWN_GRACE_MS;
    const stdin = child.stdin;
    // Audit-m4 fix: gate command-channel attempt on `inputMode === 'mic'`.
    // In stdin-pcm mode the Python side has no command reader; sending
    // a shutdown JSON would just be absorbed as ~32 bytes of PCM and
    // we'd wait the full grace period for an ack that never comes.
    const canCommand =
      this.inputMode === 'mic' && stdin !== null && !stdin.destroyed;

    if (canCommand) {
      try {
        await this.send({ cmd: 'shutdown' });
        const acked = await this.waitForAck(graceMs);
        if (acked) {
          // Child saw the command — it'll exit on its own; await the
          // exit so the Promise resolves once the process is truly gone.
          await this.waitForExit(SIGTERM_GRACE_MS).catch(() => undefined);
          if (this.child !== undefined && this.child.exitCode === null) {
            await this.forceStop();
          }
          return;
        }
      } catch {
        // Fall through to SIGTERM
      }
    }
    await this.forceStop();
  }

  /**
   * Promise-typed waiter — used by tests to await an arbitrary event.
   * Production callers use the `.on('event', ...)` listener.
   */
  waitForEvent<T extends VoiceBridgeEvent['type']>(
    type: T,
    timeoutMs = 5_000,
  ): Promise<Extract<VoiceBridgeEvent, { type: T }>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off('event', handler);
        reject(new VoiceBridgeError('await-event-timeout', `timed out waiting for ${type}`));
      }, timeoutMs);
      const handler = (e: VoiceBridgeEvent): void => {
        if (e.type === type) {
          clearTimeout(timer);
          this.off('event', handler);
          resolve(e as Extract<VoiceBridgeEvent, { type: T }>);
        }
      };
      this.on('event', handler);
    });
  }

  /** Tail of bytes written to child stderr (capped). Used by error reports. */
  getStderrTail(): string {
    return this.stderrTailChunks.join('').slice(-STDERR_TAIL_CAP);
  }

  // ----- internals --------------------------------------------------------

  private attachStreams(child: ChildIO, onStderr?: (line: string) => void): void {
    this.readlineIface = readline.createInterface({
      input: child.stdout,
      crlfDelay: Infinity,
    });
    // POST-HOC slice cap (audit-m1). Note: readline does NOT cap line
    // length internally — it buffers the full line before emitting
    // (verified empirically: 50 MB chunk -> single `line` event of
    // length 50 MB). This slice is a cosmetic defense-in-depth that
    // truncates AFTER readline already held the memory. Acceptable
    // today because the only writer to the bridge's stdout is the
    // Python bridge itself, emitting ~150-byte JSON events with
    // newlines on every event. If a future change lets a worker pipe
    // arbitrary data through this stdout, switch to a raw `data` event
    // listener that bound-checks the running buffer (Multica scanner
    // pattern, 1A precedent).
    this.readlineIface.on('line', (rawLine) => {
      const line =
        rawLine.length > READLINE_MAX_LINE_BYTES
          ? rawLine.slice(0, READLINE_MAX_LINE_BYTES)
          : rawLine;
      this.handleStdoutLine(line);
    });

    const stderrReader = readline.createInterface({
      input: child.stderr,
      crlfDelay: Infinity,
    });
    stderrReader.on('line', (line) => {
      if (onStderr !== undefined) {
        onStderr(line);
      } else {
        process.stderr.write(`[voice-bridge] ${line}\n`);
      }
      this.captureStderr(line);
    });
  }

  private captureStderr(line: string): void {
    if (this.stderrTailBytes >= STDERR_TAIL_CAP) {
      // Drop oldest chunk(s) until we have room
      while (this.stderrTailChunks.length > 0 && this.stderrTailBytes >= STDERR_TAIL_CAP) {
        const oldest = this.stderrTailChunks.shift() ?? '';
        this.stderrTailBytes -= oldest.length;
      }
    }
    const chunk = `${line}\n`;
    this.stderrTailChunks.push(chunk);
    this.stderrTailBytes += chunk.length;
  }

  private handleStdoutLine(line: string): void {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    let event: VoiceBridgeEvent;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (!isVoiceBridgeEvent(parsed)) {
        // Malformed shape (missing 'type', unknown 'type') — surface
        // as a synthetic error event but don't crash.
        this.emitEvent({
          type: 'error',
          code: 'malformed-event',
          message: `unknown event shape: ${trimmed.slice(0, 200)}`,
        });
        return;
      }
      event = parsed;
    } catch {
      // Bad JSON — treat as transport corruption. Skip the line,
      // don't crash. Mirrors 1A's parse_error events.
      this.emitEvent({
        type: 'error',
        code: 'malformed-json',
        message: trimmed.slice(0, 200),
      });
      return;
    }

    this.emitEvent(event);

    if (event.type === 'ready') {
      const readyEvent = event;
      for (const resolve of this.readyResolvers.splice(0)) {
        resolve(readyEvent);
      }
      this.readyRejector = undefined;
    } else if (event.type === 'shutdown_ack') {
      for (const resolve of this.shutdownAckResolvers.splice(0)) {
        resolve();
      }
    }
  }

  private emitEvent(event: VoiceBridgeEvent): void {
    this.emit('event', event);
    this.emit(event.type, event as never);
  }

  private attachExitHandlers(child: ChildHandle): void {
    const onSpawnError = (cause: Error): void => {
      // ENOENT etc. surfaces here on Win32 / Linux when the binary
      // can't be exec'd. Reject ready, mark stopped.
      this.status = { kind: 'stopped', exitCode: null, signal: null };
      if (this.readyRejector !== undefined) {
        const reject = this.readyRejector;
        this.readyRejector = undefined;
        this.readyResolvers = [];
        reject(
          new VoiceBridgeError('spawn-failed', `child spawn error: ${describeError(cause)}`),
        );
      }
    };
    child.on('error', onSpawnError);

    child.on('exit', (exitCode, signal) => {
      this.status = { kind: 'stopped', exitCode, signal };
      // Reject any pending ready promise — the child died before
      // emitting ready.
      if (this.readyRejector !== undefined) {
        const reject = this.readyRejector;
        this.readyRejector = undefined;
        this.readyResolvers = [];
        reject(
          new VoiceBridgeError(
            'exit-before-ready',
            `child exited (code=${exitCode}, signal=${signal}) before emitting 'ready'`,
          ),
        );
      }
      // Fire any pending shutdown-ack waiters (treat exit as ack)
      for (const resolve of this.shutdownAckResolvers.splice(0)) {
        resolve();
      }
      for (const resolve of this.exitWaiters.splice(0)) {
        resolve({ exitCode, signal });
      }
      this.emit('exit', { exitCode, signal });
      this.readlineIface?.close();
      this.readlineIface = undefined;
    });
  }

  private awaitReady(
    timeoutMs: number,
  ): Promise<Extract<VoiceBridgeEvent, { type: 'ready' }>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.readyResolvers = this.readyResolvers.filter((r) => r !== onReady);
        this.readyRejector = undefined;
        reject(
          new VoiceBridgeError('ready-timeout', `bridge did not emit 'ready' within ${timeoutMs}ms`),
        );
      }, timeoutMs);
      const onReady = (e: Extract<VoiceBridgeEvent, { type: 'ready' }>): void => {
        clearTimeout(timer);
        resolve(e);
      };
      this.readyResolvers.push(onReady);
      // Last writer wins — only one start() in flight at a time per
      // VoiceBridge instance (guarded at the top of start()).
      this.readyRejector = (cause: Error): void => {
        clearTimeout(timer);
        reject(cause);
      };
    });
  }

  private waitForAck(timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.shutdownAckResolvers = this.shutdownAckResolvers.filter((r) => r !== onAck);
        resolve(false);
      }, timeoutMs);
      const onAck = (): void => {
        clearTimeout(timer);
        resolve(true);
      };
      this.shutdownAckResolvers.push(onAck);
    });
  }

  private waitForExit(
    timeoutMs: number,
  ): Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }> {
    return new Promise((resolve, reject) => {
      const child = this.child;
      if (child === undefined) {
        resolve({ exitCode: null, signal: null });
        return;
      }
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve({ exitCode: child.exitCode, signal: child.signalCode });
        return;
      }
      const timer = setTimeout(() => {
        this.exitWaiters = this.exitWaiters.filter((w) => w !== onExit);
        reject(
          new VoiceBridgeError('exit-timeout', `bridge did not exit within ${timeoutMs}ms`),
        );
      }, timeoutMs);
      const onExit = (info: { exitCode: number | null; signal: NodeJS.Signals | null }): void => {
        clearTimeout(timer);
        resolve(info);
      };
      this.exitWaiters.push(onExit);
    });
  }

  private async forceStop(): Promise<void> {
    const child = this.child;
    if (child === undefined) return;
    if (child.exitCode !== null || child.signalCode !== null) return;

    if (process.platform === 'win32') {
      // Win32: child.kill() with default signal sends a CTRL_BREAK-like
      // event that may not kill detached descendants. `taskkill /T /F`
      // is the idiomatic tree-kill on Win32 — 3Q + 2A.4b M1 precedent.
      const pid = child.pid;
      if (pid !== undefined) {
        try {
          const { spawn: spawnKill } = await import('node:child_process');
          spawnKill('taskkill', ['/pid', String(pid), '/T', '/F'], {
            stdio: 'ignore',
            windowsHide: true,
          });
        } catch {
          // Last resort
          try {
            child.kill('SIGKILL');
          } catch {
            // ignore
          }
        }
      }
    } else {
      // POSIX: SIGTERM then SIGKILL after 1 s
      try {
        child.kill('SIGTERM');
      } catch {
        // already dead
      }
      const exited = await this.waitForExit(SIGTERM_GRACE_MS).catch(() => undefined);
      if (exited === undefined) {
        try {
          child.kill('SIGKILL');
        } catch {
          // already dead
        }
      }
    }
    // Wait for the actual exit signal so callers don't race the OS.
    await this.waitForExit(SIGTERM_GRACE_MS * 2).catch(() => undefined);
  }
}

function isVoiceBridgeEvent(value: unknown): value is VoiceBridgeEvent {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  switch (v.type) {
    case 'ready':
      return (
        typeof v.backend === 'string' &&
        typeof v.sampleRate === 'number' &&
        typeof v.vadThreshold === 'number'
      );
    case 'stt_ready':
      // Audit-m12: require non-empty model string. The Python bridge
      // controls this so an empty string is not exploitable, but
      // defense-in-depth keeps the validator's "shape AND content"
      // contract honest.
      return typeof v.model === 'string' && v.model.length > 0;
    case 'speech_start':
      return typeof v.tMs === 'number';
    case 'speech_end':
      return typeof v.tMs === 'number' && typeof v.durationMs === 'number';
    case 'partial':
      return (
        typeof v.seq === 'number' &&
        typeof v.text === 'string' &&
        typeof v.tMs === 'number'
      );
    case 'final':
      return (
        typeof v.seq === 'number' &&
        typeof v.text === 'string' &&
        typeof v.tMs === 'number' &&
        typeof v.durationMs === 'number'
      );
    case 'warning':
      return v.code === 'utterance-truncated' && typeof v.tMs === 'number';
    case 'error':
      return typeof v.code === 'string' && typeof v.message === 'string';
    case 'shutdown_ack':
      return true;
    default:
      return false;
  }
}

function describeError(cause: unknown): string {
  if (cause instanceof Error) {
    const code = (cause as NodeJS.ErrnoException).code;
    return code !== undefined ? `${code} ${cause.message}` : cause.message;
  }
  return String(cause);
}

export class VoiceBridgeError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'VoiceBridgeError';
    this.code = code;
  }
}
