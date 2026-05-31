import { randomUUID } from 'node:crypto';

import { VoiceBridge, VoiceBridgeError } from './bridge.js';
import { resolveVoiceVocabPaths } from './path.js';
import type { VoiceBridgeEvent } from './types.js';

/**
 * Phase 6E.1 — `VoiceController` (summon path).
 *
 * Node-side producer that owns the `VoiceBridge` child + a state machine +
 * a stable immutable snapshot. It lives in the LAUNCHER process (same
 * process as `runTui`), NOT the mcp-server child. For 6E.1 (summon, no
 * rolling buffer) it needs NO SQLite store at all — just the bridge.
 *
 * "Dumb" producer: it knows nothing about React / RPC / Maestro. The
 * React consumer (`useVoice`) subscribes via `subscribe()` /
 * `getSnapshot()` (React 19 `useSyncExternalStore`) and LATE-BINDS the
 * routing callbacks (`setSendToMaestro` / `setInjectToInput`) after it
 * mounts — mirroring the 2B.2 `setOnEvent` late-bind pattern (the React
 * tree mounts after the controller is constructed).
 *
 * The event-wiring + skip-empty-`final` + teardown shape generalizes
 * `src/cli/voice-capture.ts` (subscribe to `bridge.on('event', ...)`
 * BEFORE `bridge.start()`; `e.text.trim()` skip-empty; teardown
 * `bridge.stop({ graceMs }).catch(() => {})`).
 *
 * Summon state machine:
 *   off → starting → listening → transcribing → (route) → listening
 *   listening|transcribing --toggle→ stopping → off
 *   final + autoSend → route → end session (stop bridge) → off
 *   error from start-failure / bridge exit.
 *
 * Routing (summon):
 *   - `autoSend === true`: on `final`, send to Maestro then END the session
 *     (stop the bridge). One utterance per Ctrl+G.
 *   - `autoSend === false` (review): on `final`, inject into the input bar
 *     and STAY listening for multi-final dictation. The session ends only
 *     when the user toggles off (Ctrl+G again). This is the simplest
 *     acceptable v1 — the chat submit doesn't currently signal the
 *     controller, so the mic stays open until the user explicitly closes
 *     it. (6E.2 may wire submit → end-session.)
 *
 * `mode` is part of the snapshot so 6E.2 can extend this controller to the
 * always-capture path without changing the consumer contract. Only the
 * SUMMON path is implemented here.
 */

const STOP_GRACE_MS = 2_000;

/**
 * Cap on `pendingFinals` — finals buffered before the routing callbacks
 * bind. Binding is a single mount-effect hop; in practice at most one
 * utterance can race it. The cap bounds a pathological "bind never
 * happens" case (e.g. a non-TTY launcher that constructed the controller
 * but never mounted the hook) so the buffer can't grow unbounded. Oldest
 * is dropped when full (a stale early transcript matters least). */
const MAX_PENDING_FINALS = 8;

export type VoiceStatus =
  | 'off'
  | 'starting'
  | 'listening'
  | 'transcribing'
  | 'stopping'
  | 'error';

export type VoiceMode = 'summon' | 'always';

export interface VoiceSnapshot {
  readonly status: VoiceStatus;
  readonly mode: VoiceMode;
  /** True while a session is active (starting/listening/transcribing). */
  readonly isListening: boolean;
  readonly lastError?: string;
}

/** Routing callback: send a finalized transcript to Maestro. */
export type SendToMaestroFn = (
  text: string,
) => { ok: true } | { ok: false; reason: string };

/** Routing callback: inject a finalized transcript into the input bar. */
export type InjectToInputFn = (text: string) => void;

export interface VoiceControllerOptions {
  /** `'summon'` (default) or `'always'` (6E.2, not implemented here). */
  readonly mode?: VoiceMode;
  /** When true, finalized transcripts are sent to Maestro immediately. */
  readonly autoSend?: boolean;

  // ---- injection seams (tests) — same shape as RunVoiceCaptureOptions ----
  /** Pre-built bridge factory (tests). Default: `new VoiceBridge()`. */
  readonly bridgeFactory?: () => VoiceBridge;
  /** Wall-clock source (unused by the summon path today; reserved for parity). */
  readonly now?: () => number;
  /** Home dir override (vocab path resolution + bridge env). */
  readonly homeDir?: string;
  /** Override the bridge script path (tests — `.mjs` fake bridge). */
  readonly scriptPath?: string;
  /** Override the Python executable path (tests / non-default venv). */
  readonly pythonPath?: string;
  /** Override the Python source package dir (tests). */
  readonly pythonPackageDir?: string;
  /** Project path for vocab resolution (project-local overrides). */
  readonly projectPath?: string;
  /** Sink for child stderr (default: swallowed). */
  readonly onStderr?: (line: string) => void;
}

type Listener = () => void;

export class VoiceController {
  private readonly mode: VoiceMode;
  private readonly autoSend: boolean;
  private readonly bridgeFactory: () => VoiceBridge;
  private readonly homeDir: string | undefined;
  private readonly scriptPath: string | undefined;
  private readonly pythonPath: string | undefined;
  private readonly pythonPackageDir: string | undefined;
  private readonly projectPath: string | undefined;
  private readonly onStderr: ((line: string) => void) | undefined;

  /** Stable session id for the controller's lifetime (matches voice-capture). */
  private readonly sessionId: string;

  private status: VoiceStatus = 'off';
  private lastError: string | undefined;

  /** Cached snapshot — identity is stable between real transitions so
   * `useSyncExternalStore` doesn't loop/warn. Replaced only on change. */
  private snapshot: VoiceSnapshot;

  private bridge: VoiceBridge | undefined;
  /** Tracks the bridge instance we attached our `event` listener to so
   * teardown can detach cleanly. */
  private eventHandler: ((e: VoiceBridgeEvent) => void) | undefined;

  private readonly listeners = new Set<Listener>();

  /** Late-bound routing callbacks. Registered by the React consumer on
   * mount (the App tree mounts AFTER construction — mirrors 2B.2
   * `setOnEvent`). Until BOTH are set, an early `final` can't be routed —
   * it's buffered in `pendingFinals` and flushed once binding completes. */
  private sendToMaestro: SendToMaestroFn | undefined;
  private injectToInput: InjectToInputFn | undefined;

  /**
   * Finals that arrived before the routing callbacks were bound (a fast
   * `final` racing the `useVoice` mount effect). Held FIFO, capped, and
   * flushed through `routeFinal()` the moment routing becomes possible
   * (`setInjectToInput` / `setSendToMaestro`). Cleared on session end /
   * shutdown so a stale utterance never leaks into a later session. */
  private pendingFinals: string[] = [];

  private disposed = false;

  constructor(options: VoiceControllerOptions = {}) {
    this.mode = options.mode ?? 'summon';
    this.autoSend = options.autoSend ?? false;
    this.bridgeFactory = options.bridgeFactory ?? (() => new VoiceBridge());
    this.homeDir = options.homeDir;
    this.scriptPath = options.scriptPath;
    this.pythonPath = options.pythonPath;
    this.pythonPackageDir = options.pythonPackageDir;
    this.projectPath = options.projectPath;
    this.onStderr = options.onStderr;
    this.sessionId = randomUUID();
    this.snapshot = this.buildSnapshot();
  }

  // ----- consumer API -----------------------------------------------------

  /**
   * Subscribe to snapshot changes. Returns an unsubscribe fn. React 19's
   * `useSyncExternalStore(subscribe, getSnapshot)` is the intended caller.
   */
  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Current immutable snapshot. Identity is stable between transitions. */
  getSnapshot = (): VoiceSnapshot => this.snapshot;

  /** Register the "send to Maestro" routing callback (late-bind). */
  setSendToMaestro(fn: SendToMaestroFn): void {
    this.sendToMaestro = fn;
    this.flushPendingFinals();
  }

  /** Register the "inject into input bar" routing callback (late-bind). */
  setInjectToInput(fn: InjectToInputFn): void {
    this.injectToInput = fn;
    this.flushPendingFinals();
  }

  /**
   * Toggle the summon session. From `off`, starts the bridge + opens the
   * mic. From `listening`/`transcribing`, stops the session + closes the
   * mic. No-op while `starting` or `stopping` (re-entrant guard — the user
   * mashing Ctrl+G can't double-start; the bridge itself also guards
   * `status !== idle|stopped`). From `error`, a toggle retries (treated
   * like `off`).
   */
  toggle(): void {
    if (this.disposed) return;
    switch (this.status) {
      case 'off':
      case 'error':
        void this.startSession();
        return;
      case 'listening':
      case 'transcribing':
        void this.stopSession();
        return;
      case 'starting':
      case 'stopping':
        // In-flight — ignore the toggle. The user can re-press once the
        // transition settles.
        return;
    }
  }

  /** Tear down the bridge + clear listeners. Idempotent. */
  async shutdown(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.teardownBridge();
    this.listeners.clear();
    this.transition('off');
  }

  // ----- internals --------------------------------------------------------

  private async startSession(): Promise<void> {
    if (this.disposed) return;
    if (this.bridge !== undefined) {
      // A previous bridge is still around (e.g. a failed teardown). Tear it
      // down before starting fresh so we never leak a second child.
      await this.teardownBridge();
    }
    this.lastError = undefined;
    this.transition('starting');

    const bridge = this.bridgeFactory();
    this.bridge = bridge;

    const handler = (e: VoiceBridgeEvent): void => {
      this.onBridgeEvent(e);
    };
    this.eventHandler = handler;
    // Subscribe BEFORE start so no early `final` is missed (voice-capture
    // precedent). The 'event' channel fans out every event; we narrow
    // inside the handler.
    bridge.on('event', handler);
    // The bridge exits when its child dies — treat that as an error if we
    // were not the ones stopping it.
    bridge.once('exit', () => {
      this.onBridgeExit();
    });

    const vocabPaths = resolveVoiceVocabPaths({
      ...(this.homeDir !== undefined ? { home: this.homeDir } : {}),
      ...(this.projectPath !== undefined ? { projectPath: this.projectPath } : {}),
    });

    try {
      await bridge.start({
        inputMode: 'mic',
        sttEnabled: true,
        sttVocabPaths: vocabPaths,
        ...(this.scriptPath !== undefined ? { scriptPath: this.scriptPath } : {}),
        ...(this.pythonPath !== undefined ? { pythonPath: this.pythonPath } : {}),
        ...(this.pythonPackageDir !== undefined
          ? { pythonPackageDir: this.pythonPackageDir }
          : {}),
        ...(this.homeDir !== undefined ? { homeDir: this.homeDir } : {}),
        onStderr: (line) => {
          this.onStderr?.(line);
        },
      });
    } catch (cause) {
      // start() already tore down the half-spawned child internally. Detach
      // our listener + drop the handle, then surface the error state with an
      // actionable hint (m2 — the toast/chip must explain the cause, not
      // just say "Voice error").
      this.detachBridge();
      const tail = bridge.getStderrTail();
      this.bridge = undefined;
      this.setError(formatBridgeFailure(cause, tail));
      return;
    }

    // If a toggle-off / shutdown raced the await, honor it (M2 — mirror
    // voice-capture's disposed-after-await pattern). Two sub-cases:
    //   - `this.bridge === bridge`: NO teardown has touched this handle yet
    //     (the disposed flag was set without an accompanying teardown, or
    //     this start re-armed `this.bridge` after one). Tear it down here so
    //     the child that spawned AFTER disposal can never linger.
    //   - `this.bridge !== bridge`: `shutdown()`/`stopSession()` already
    //     adopted + stopped this exact handle (they always null `this.bridge`
    //     as part of teardown). Don't double-stop.
    if (this.disposed) {
      if (this.bridge === bridge) {
        await this.teardownBridge();
      }
      this.transition('off');
      return;
    }
    if (this.status !== 'starting') {
      // A stopSession() landed while we were awaiting `ready` — don't
      // clobber its terminal state.
      return;
    }
    this.transition('listening');
  }

  private async stopSession(): Promise<void> {
    if (this.status === 'off' || this.status === 'stopping') return;
    this.transition('stopping');
    await this.teardownBridge();
    if (!this.disposed) this.transition('off');
  }

  private onBridgeEvent(e: VoiceBridgeEvent): void {
    if (this.disposed) return;
    switch (e.type) {
      case 'speech_start':
        // A new utterance is being captured → transcribing.
        if (this.status === 'listening') this.transition('transcribing');
        return;
      case 'final': {
        const text = e.text.trim();
        if (text.length === 0) {
          // Empty/silence final — drop it and return to listening.
          if (this.status === 'transcribing') this.transition('listening');
          return;
        }
        this.routeFinal(text);
        return;
      }
      case 'error':
        // Bridge `error` events are diagnostic (the bridge keeps running);
        // surface the message but do NOT tear the session down. A FATAL
        // failure arrives as a child exit (handled by onBridgeExit).
        this.lastError = `${e.code}: ${e.message}`;
        this.publish();
        return;
      default:
        // speech_end / partial / warning / stt_ready / ready / wake_word /
        // shutdown_ack — no state change in the summon path.
        return;
    }
  }

  private routeFinal(text: string): void {
    if (!this.canRoute()) {
      // A `final` raced the consumer's mount-effect binding. Don't drop it —
      // buffer FIFO (cap-bounded) and flush once the callbacks bind
      // (`setInjectToInput` / `setSendToMaestro`). Keep the session in its
      // current state; the flush re-runs the full routing logic below.
      this.pendingFinals.push(text);
      if (this.pendingFinals.length > MAX_PENDING_FINALS) {
        this.pendingFinals.shift();
      }
      return;
    }
    if (this.autoSend) {
      // Auto-send: route to Maestro, then END the session (one utterance
      // per Ctrl+G). The consumer's sendToMaestro handles turn-in-flight
      // fallback (it injects + toasts); either way the session ends here.
      this.sendToMaestro?.(text);
      void this.stopSession();
      return;
    }
    // Review mode: inject into the input bar and STAY listening for
    // multi-final dictation. The session ends when the user toggles off.
    this.injectToInput?.(text);
    if (this.status === 'transcribing') this.transition('listening');
  }

  /**
   * Can a `final` be routed right now? Auto-send needs `sendToMaestro`;
   * review mode needs `injectToInput`. Note the auto-send turn-in-flight
   * fallback (in the consumer's `sendToMaestro`) injects into the input
   * bar — but that's the consumer's concern; from the controller's view
   * the send callback being bound is the gate.
   */
  private canRoute(): boolean {
    return this.autoSend
      ? this.sendToMaestro !== undefined
      : this.injectToInput !== undefined;
  }

  /**
   * Flush any finals buffered before the routing callbacks bound. Drains
   * the queue through the SAME `routeFinal()` logic so review-vs-auto-send
   * semantics are identical to a live final. Guards re-entrancy: a flushed
   * auto-send final calls `stopSession()` (which can't re-enter here), and
   * an unroutable state (shouldn't happen post-bind) would re-buffer — so
   * we snapshot + clear BEFORE draining to avoid an infinite re-push loop.
   */
  private flushPendingFinals(): void {
    if (this.disposed) return;
    if (this.pendingFinals.length === 0) return;
    if (!this.canRoute()) return;
    const queued = this.pendingFinals;
    this.pendingFinals = [];
    for (const text of queued) {
      this.routeFinal(text);
    }
  }

  private onBridgeExit(): void {
    if (this.disposed) return;
    // We only reach here for an UNEXPECTED exit — `teardownBridge` detaches
    // this listener before it stops the bridge, so a clean stop never
    // fires this. An exit while listening/transcribing/starting means the
    // child died on us.
    if (
      this.status === 'listening' ||
      this.status === 'transcribing' ||
      this.status === 'starting'
    ) {
      const tail = this.bridge?.getStderrTail() ?? '';
      this.detachBridge();
      this.bridge = undefined;
      this.setError(
        tail.length > 0
          ? `voice bridge exited unexpectedly: ${tail.slice(-200)}`
          : 'voice bridge exited unexpectedly',
      );
    }
  }

  /** Detach our listeners from the current bridge (no stop). */
  private detachBridge(): void {
    if (this.bridge !== undefined && this.eventHandler !== undefined) {
      this.bridge.off('event', this.eventHandler);
    }
    this.eventHandler = undefined;
  }

  /** Detach + stop the bridge child, dropping the handle. Best-effort. */
  private async teardownBridge(): Promise<void> {
    // The session is ending — any final buffered awaiting a late bind is
    // now stale (it belongs to the session being torn down). Drop it so it
    // never leaks into a later session's input bar / Maestro turn.
    this.pendingFinals = [];
    const bridge = this.bridge;
    if (bridge === undefined) return;
    // Detach FIRST so the impending exit doesn't trip onBridgeExit's
    // "unexpected exit" path.
    this.detachBridge();
    bridge.removeAllListeners('exit');
    this.bridge = undefined;
    await bridge.stop({ graceMs: STOP_GRACE_MS }).catch(() => undefined);
  }

  private setError(message: string): void {
    this.lastError = message;
    this.transition('error');
  }

  /** Mutate status + republish (snapshot identity changes only on change). */
  private transition(next: VoiceStatus): void {
    if (this.status === next) {
      // Status unchanged, but lastError may have moved — republish only if
      // the snapshot would differ.
      this.publish();
      return;
    }
    this.status = next;
    this.publish();
  }

  /** Rebuild + cache the snapshot; notify listeners only on real change. */
  private publish(): void {
    const next = this.buildSnapshot();
    if (snapshotsEqual(next, this.snapshot)) return;
    this.snapshot = next;
    for (const l of this.listeners) l();
  }

  private buildSnapshot(): VoiceSnapshot {
    const isListening =
      this.status === 'starting' ||
      this.status === 'listening' ||
      this.status === 'transcribing';
    const base: VoiceSnapshot = {
      status: this.status,
      mode: this.mode,
      isListening,
    };
    return this.lastError !== undefined
      ? { ...base, lastError: this.lastError }
      : base;
  }
}

function snapshotsEqual(a: VoiceSnapshot, b: VoiceSnapshot): boolean {
  return (
    a.status === b.status &&
    a.mode === b.mode &&
    a.isListening === b.isListening &&
    a.lastError === b.lastError
  );
}

/**
 * Map a `bridge.start()` failure into a concise, ACTIONABLE `lastError`
 * (m2). The `voice-env-missing` / `ready-timeout` / `spawn-failed` cases
 * point at `symphony voice install` — the single fix for a missing or
 * broken venv. A non-empty stderr tail is appended (trimmed) so the user
 * sees the underlying Python error too. Other codes surface verbatim.
 */
function formatBridgeFailure(cause: unknown, stderrTail: string): string {
  const code = cause instanceof VoiceBridgeError ? cause.code : undefined;
  const base =
    cause instanceof VoiceBridgeError
      ? `${cause.code}: ${cause.message}`
      : cause instanceof Error
        ? cause.message
        : String(cause);
  const installHintCodes = new Set([
    'voice-env-missing',
    'ready-timeout',
    'spawn-failed',
  ]);
  const hint =
    code !== undefined && installHintCodes.has(code)
      ? ' — run `symphony voice install`'
      : '';
  const tail = stderrTail.trim();
  const tailSuffix = tail.length > 0 ? ` (${tail.slice(-200)})` : '';
  return `${base}${hint}${tailSuffix}`;
}
