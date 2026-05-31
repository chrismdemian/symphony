import { randomUUID } from 'node:crypto';

import { SymphonyDatabase } from '../state/db.js';
import { SqliteTranscriptStore } from '../state/sqlite-transcript-store.js';
import {
  heuristicSummarizer,
  type CompactionConfig,
  type Summarizer,
  type TranscriptStore,
} from '../state/transcript-store.js';
import { VoiceBridge, VoiceBridgeError, type VoiceBridgeStartOptions } from './bridge.js';
import { resolveVoiceVocabPaths } from './path.js';
import type { VoiceBridgeEvent } from './types.js';

/**
 * Phase 6E.1/6E.2 — `VoiceController`.
 *
 * Node-side producer that owns the `VoiceBridge` child + a state machine +
 * a stable immutable snapshot. It lives in the LAUNCHER process (same
 * process as `runTui`), NOT the mcp-server child. In ALWAYS mode it also
 * owns its own `SqliteTranscriptStore` handle (6D rolling buffer) against
 * the shared `symphony.db` (better-sqlite3 multi-process WAL).
 *
 * "Dumb" producer: it knows nothing about React / RPC / Maestro. The
 * React consumer (`useVoice`) subscribes via `subscribe()` /
 * `getSnapshot()` (React 19 `useSyncExternalStore`) and LATE-BINDS the
 * routing callbacks (`setSendToMaestro` / `setInjectToInput` /
 * `setNoticeSink`) after it mounts — mirroring the 2B.2 `setOnEvent`
 * late-bind pattern (the React tree mounts after the controller is
 * constructed).
 *
 * The event-wiring + skip-empty-`final` + teardown shape generalizes
 * `src/cli/voice-capture.ts` (subscribe to `bridge.on('event', ...)`
 * BEFORE `bridge.start()`; `e.text.trim()` skip-empty; teardown
 * `bridge.stop({ graceMs }).catch(() => {})`; single-flight compaction).
 *
 * ── SUMMON mode (6E.1) ──
 *   off → starting → listening → transcribing → (route) → listening
 *   listening|transcribing --toggle→ stopping → off
 *   final + autoSend → route → end session (stop bridge) → off
 *   error from start-failure / bridge exit.
 *   Routing: autoSend → send to Maestro then END session; review → inject
 *   into the input bar and STAY listening (multi-final dictation).
 *
 * ── ALWAYS mode (6E.2) ──
 *   The bridge runs CONTINUOUSLY from construction; ambient finals append
 *   to the rolling buffer (NEVER sent to Maestro). A `wake_word` event OR
 *   `toggle()` (Ctrl+G) ARMS a summon: the next `final` whose
 *   `tMs >= armedAtMs` routes to Maestro WITH a `<voice-context>` block
 *   (`getContext()`), then disarms. A ~8s summon-timeout disarms if no
 *   utterance starts. `final.seq` is segment-local (resets per
 *   speech_start in voice_bridge.py) so the gate uses `tMs`, never `seq`.
 *
 * `mode` is part of the snapshot + runtime-switchable via `setMode()`
 * (tears down + re-establishes the bridge + store).
 */

const STOP_GRACE_MS = 2_000;

/** Cap on the `final` text length appended to the buffer / routed. */
const VOICE_FINAL_MAX_LEN = 4_000;

/** Default summon-timeout — disarm if no speech starts within this window. */
const DEFAULT_SUMMON_TIMEOUT_MS = 8_000;

/** Grace re-arm when a summon utterance is mid-flight at timeout (belt-and-suspenders). */
const SUMMON_GRACE_MS = 2_000;

/** Default ambient-buffer compaction cadence (mirror voice-capture.ts). */
const DEFAULT_COMPACTION_INTERVAL_MS = 60_000;
const DEFAULT_COMPACTION_WINDOW_MS = 15 * 60_000;

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
  /** True while an always-mode summon is armed (Ctrl+G / wake-word). */
  readonly summoned: boolean;
  /**
   * True while always-mode capture is live (mode==='always' AND the bridge
   * is listening/transcribing). Drives the App's auto-Away-mode ownership.
   * Deliberately false during starting/error/teardown so the away effect
   * doesn't flap on transients.
   */
  readonly alwaysActive: boolean;
  readonly lastError?: string;
}

/** Routing callback: send a finalized transcript to Maestro. */
export type SendToMaestroFn = (
  text: string,
  contextText?: string,
) => { ok: true } | { ok: false; reason: string };

/** Routing callback: inject a finalized transcript into the input bar. */
export type InjectToInputFn = (text: string, contextText?: string) => void;

/** Transient-notice sink (e.g. summon-timeout dismissal). */
export type NoticeSink = (message: string) => void;

/** Factory for the always-mode rolling-buffer store (tests inject in-memory). */
export type TranscriptStoreFactory = (clock: () => number) => {
  readonly store: TranscriptStore;
  readonly close: () => void;
};

export interface VoiceControllerOptions {
  /** `'summon'` (default) or `'always'`. */
  readonly mode?: VoiceMode;
  /** When true, finalized transcripts are sent to Maestro immediately. */
  readonly autoSend?: boolean;

  // ---- injection seams (tests) — same shape as RunVoiceCaptureOptions ----
  /** Pre-built bridge factory (tests). Default: `new VoiceBridge()`. */
  readonly bridgeFactory?: () => VoiceBridge;
  /** Wall-clock source. Default `Date.now`. */
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

  // ---- always-mode (6E.2) ----
  /** Store factory (tests inject in-memory). Default: SQLite against symphony.db. */
  readonly storeFactory?: TranscriptStoreFactory;
  /** DB file override for the default SQLite store (tests). */
  readonly dbFilePath?: string;
  /** Summon-timeout window (ms). Default 8000. */
  readonly summonTimeoutMs?: number;
  /** Compaction cadence (ms). Default 60000. */
  readonly compactionIntervalMs?: number;
  /** Injected summarizer (tests / future model). Default: heuristic. */
  readonly summarizer?: Summarizer;
  /** Raw-retention window (ms). Default 120 min. */
  readonly rawRetentionMs?: number;
  /** Summary-retention window (ms). Default 168 h. */
  readonly summaryRetentionMs?: number;
  /** Max chunks before hard cap. Default 5000. */
  readonly maxChunks?: number;
  /** Compaction window size (ms). Default 15 min. */
  readonly windowMs?: number;
  /** Summary max chars. Default 500. */
  readonly summaryMaxChars?: number;
  /** STT model (passed through to the bridge). */
  readonly sttModel?: 'moonshine/base' | 'moonshine/tiny';
  /** Max utterance seconds hard cap (passed through to the bridge). */
  readonly maxUtteranceSeconds?: number;
  /** Partial inference cadence ms (passed through to the bridge). */
  readonly partialIntervalMs?: number;

  // ---- wake-word (6C; always-mode only) ----
  readonly wakeWordEnabled?: boolean;
  /** Resolved `.onnx` path (start.ts resolves; not-found → omit + disable). */
  readonly wakeWordModelPath?: string;
  readonly wakeWordModelName?: string;
  readonly wakeWordThreshold?: number;
  readonly wakeWordSustainFrames?: number;
  readonly wakeWordCooldownMs?: number;
}

type Listener = () => void;

interface PendingFinal {
  readonly text: string;
  readonly contextText: string | undefined;
  /** Summon-mode autoSend ends the session after the buffered final is sent. */
  readonly endSessionAfter: boolean;
}

export class VoiceController {
  private mode: VoiceMode;
  private readonly autoSend: boolean;
  private readonly bridgeFactory: () => VoiceBridge;
  private readonly clock: () => number;
  private readonly homeDir: string | undefined;
  private readonly scriptPath: string | undefined;
  private readonly pythonPath: string | undefined;
  private readonly pythonPackageDir: string | undefined;
  private readonly projectPath: string | undefined;
  private readonly onStderr: ((line: string) => void) | undefined;

  // ---- always-mode config ----
  private readonly storeFactory: TranscriptStoreFactory | undefined;
  private readonly dbFilePath: string | undefined;
  private readonly summonTimeoutMs: number;
  private readonly compactionIntervalMs: number;
  private readonly summarizer: Summarizer;
  private readonly compactionConfig: CompactionConfig;
  private readonly sttModel: 'moonshine/base' | 'moonshine/tiny' | undefined;
  private readonly maxUtteranceSeconds: number | undefined;
  private readonly partialIntervalMs: number | undefined;
  private readonly wakeWordEnabled: boolean;
  private readonly wakeWordModelPath: string | undefined;
  private readonly wakeWordModelName: string | undefined;
  private readonly wakeWordThreshold: number | undefined;
  private readonly wakeWordSustainFrames: number | undefined;
  private readonly wakeWordCooldownMs: number | undefined;

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

  /** Late-bound routing callbacks (registered by the React consumer). */
  private sendToMaestro: SendToMaestroFn | undefined;
  private injectToInput: InjectToInputFn | undefined;
  private noticeSink: NoticeSink | undefined;

  /** Finals that arrived before the routing callbacks were bound. */
  private pendingFinals: PendingFinal[] = [];

  // ---- always-mode runtime state ----
  /** A summon is armed; the next qualifying final routes to Maestro. */
  private summoned = false;
  /** Bridge tMs (ms since `ready`) at the moment of arming. */
  private armedAtMs = 0;
  /** Most-recent tMs seen from any bridge event (drives Ctrl+G arming). */
  private lastSeenTMs = 0;
  /** True once the summon's first speech_start has been seen (cancels the timeout). */
  private summonSpeechStartSeen = false;
  private summonTimer: ReturnType<typeof setTimeout> | undefined;
  private store: TranscriptStore | undefined;
  private storeClose: (() => void) | undefined;
  private compactionInFlight: Promise<void> | null = null;
  private compactionTimer: ReturnType<typeof setInterval> | undefined;
  /** Monotonic epoch — every `setMode` bumps it; awaits re-check it (last wins). */
  private modeEpoch = 0;

  private disposed = false;

  constructor(options: VoiceControllerOptions = {}) {
    this.mode = options.mode ?? 'summon';
    this.autoSend = options.autoSend ?? false;
    this.bridgeFactory = options.bridgeFactory ?? (() => new VoiceBridge());
    this.clock = options.now ?? Date.now;
    this.homeDir = options.homeDir;
    this.scriptPath = options.scriptPath;
    this.pythonPath = options.pythonPath;
    this.pythonPackageDir = options.pythonPackageDir;
    this.projectPath = options.projectPath;
    this.onStderr = options.onStderr;

    this.storeFactory = options.storeFactory;
    this.dbFilePath = options.dbFilePath;
    this.summonTimeoutMs = options.summonTimeoutMs ?? DEFAULT_SUMMON_TIMEOUT_MS;
    this.compactionIntervalMs =
      options.compactionIntervalMs ?? DEFAULT_COMPACTION_INTERVAL_MS;
    this.summarizer = options.summarizer ?? heuristicSummarizer;
    this.compactionConfig = {
      rawRetentionMs: options.rawRetentionMs ?? 120 * 60_000,
      summaryRetentionMs: options.summaryRetentionMs ?? 168 * 60 * 60_000,
      maxChunks: options.maxChunks ?? 5_000,
      windowMs: options.windowMs ?? DEFAULT_COMPACTION_WINDOW_MS,
      summaryMaxChars: options.summaryMaxChars ?? 500,
    };
    this.sttModel = options.sttModel;
    this.maxUtteranceSeconds = options.maxUtteranceSeconds;
    this.partialIntervalMs = options.partialIntervalMs;
    this.wakeWordEnabled = options.wakeWordEnabled ?? false;
    this.wakeWordModelPath = options.wakeWordModelPath;
    this.wakeWordModelName = options.wakeWordModelName;
    this.wakeWordThreshold = options.wakeWordThreshold;
    this.wakeWordSustainFrames = options.wakeWordSustainFrames;
    this.wakeWordCooldownMs = options.wakeWordCooldownMs;

    this.sessionId = randomUUID();
    this.snapshot = this.buildSnapshot();

    // Always mode boots the continuous bridge + buffer immediately (ambient
    // capture begins at launch). Summon mode stays off until Ctrl+G.
    if (this.mode === 'always') {
      void this.enterAlwaysMode();
    }
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

  /** Register the transient-notice sink (late-bind). */
  setNoticeSink(fn: NoticeSink): void {
    this.noticeSink = fn;
  }

  /**
   * SUMMON mode: toggle the listening session (start/stop bridge).
   * ALWAYS mode: arm a Ctrl+G summon when the bridge is live; restart the
   * continuous bridge when it had errored/stopped.
   */
  toggle(): void {
    if (this.disposed) return;
    if (this.mode === 'always') {
      switch (this.status) {
        case 'listening':
        case 'transcribing':
          this.armSummon(this.lastSeenTMs);
          return;
        case 'off':
        case 'error':
          void this.enterAlwaysMode();
          return;
        case 'starting':
        case 'stopping':
          return;
      }
      return;
    }
    // Summon mode (6E.1).
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
        return;
    }
  }

  /**
   * Runtime mode switch (6E.2). Tears down the current bridge + store
   * cleanly, then re-establishes per the new mode. A monotonic epoch makes
   * the LAST call win if two race (e.g. fs.watch double-fire).
   */
  async setMode(next: VoiceMode): Promise<void> {
    if (this.disposed) return;
    if (next === this.mode) return;
    const myEpoch = ++this.modeEpoch;

    this.clearSummon();
    if (this.compactionTimer !== undefined) {
      clearInterval(this.compactionTimer);
      this.compactionTimer = undefined;
    }
    await this.teardownBridge();
    if (this.modeEpoch !== myEpoch) return;
    await this.drainCompaction();
    if (this.modeEpoch !== myEpoch) return;
    await this.runCompaction();
    if (this.modeEpoch !== myEpoch) return;
    this.closeStore();

    this.mode = next;
    this.lastError = undefined;
    this.transition('off');

    if (next === 'always') {
      void this.enterAlwaysMode();
    }
  }

  /** Tear down the bridge + store + clear listeners. Idempotent. */
  async shutdown(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.clearSummon();
    if (this.compactionTimer !== undefined) {
      clearInterval(this.compactionTimer);
      this.compactionTimer = undefined;
    }
    await this.teardownBridge();
    await this.drainCompaction();
    await this.runCompaction();
    this.closeStore();
    this.listeners.clear();
    this.transition('off');
  }

  // ----- summon-mode session (6E.1) --------------------------------------

  private async startSession(): Promise<void> {
    if (this.disposed) return;
    if (this.bridge !== undefined) {
      await this.teardownBridge();
    }
    this.lastError = undefined;
    this.transition('starting');

    const bridge = this.bridgeFactory();
    this.bridge = bridge;
    this.attachBridge(bridge);

    try {
      await bridge.start(this.buildStartOptions());
    } catch (cause) {
      this.detachBridge();
      const tail = bridge.getStderrTail();
      this.bridge = undefined;
      this.setError(formatBridgeFailure(cause, tail));
      return;
    }

    if (this.disposed) {
      if (this.bridge === bridge) {
        await this.teardownBridge();
      }
      this.transition('off');
      return;
    }
    if (this.status !== 'starting') {
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

  // ----- always-mode session (6E.2) --------------------------------------

  private async enterAlwaysMode(): Promise<void> {
    if (this.disposed) return;
    const myEpoch = this.modeEpoch;

    // Defensive (audit m2): never leak a pre-existing bridge — mirror
    // startSession's guard. Normal callers reach here only from off/error
    // (toggle) or post-teardown (setMode), so this is belt-and-suspenders.
    if (this.bridge !== undefined) {
      await this.teardownBridge();
      if (this.disposed || this.modeEpoch !== myEpoch) return;
    }

    // Open the rolling-buffer store (own connection — never the engine's).
    try {
      const owned = this.openStore();
      this.store = owned.store;
      this.storeClose = owned.close;
    } catch (cause) {
      this.setError(
        `voice buffer open failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
      return;
    }

    this.lastError = undefined;
    this.transition('starting');

    const bridge = this.bridgeFactory();
    this.bridge = bridge;
    this.attachBridge(bridge);

    try {
      await bridge.start(this.buildStartOptions());
    } catch (cause) {
      this.detachBridge();
      const tail = bridge.getStderrTail();
      this.bridge = undefined;
      this.closeStore();
      this.setError(formatBridgeFailure(cause, tail));
      return;
    }

    // A shutdown / setMode raced the await — honor it (disposed-after-await).
    if (this.disposed || this.modeEpoch !== myEpoch) {
      if (this.bridge === bridge) {
        await this.teardownBridge();
      }
      this.closeStore();
      if (this.disposed) this.transition('off');
      return;
    }

    // Periodic single-flight compaction, started only after the bridge is up.
    this.compactionTimer = setInterval(() => {
      void this.runCompaction();
    }, this.compactionIntervalMs);
    this.compactionTimer.unref?.();

    this.transition('listening');
  }

  // ----- bridge wiring ----------------------------------------------------

  private attachBridge(bridge: VoiceBridge): void {
    const handler = (e: VoiceBridgeEvent): void => {
      this.onBridgeEvent(e);
    };
    this.eventHandler = handler;
    // Subscribe BEFORE start so no early `final` is missed (voice-capture
    // precedent). The 'event' channel fans out every event; we narrow inside.
    bridge.on('event', handler);
    bridge.once('exit', () => {
      this.onBridgeExit();
    });
  }

  private buildStartOptions(): VoiceBridgeStartOptions {
    const vocabPaths = resolveVoiceVocabPaths({
      ...(this.homeDir !== undefined ? { home: this.homeDir } : {}),
      ...(this.projectPath !== undefined ? { projectPath: this.projectPath } : {}),
    });
    const resolvedWakePath = this.wakeWordModelPath;
    const wake =
      this.mode === 'always' &&
      this.wakeWordEnabled === true &&
      resolvedWakePath !== undefined
        ? {
            wakeWordEnabled: true,
            wakeWordModelPath: resolvedWakePath,
            ...(this.wakeWordModelName !== undefined
              ? { wakeWordModelName: this.wakeWordModelName }
              : {}),
            ...(this.wakeWordThreshold !== undefined
              ? { wakeWordThreshold: this.wakeWordThreshold }
              : {}),
            ...(this.wakeWordSustainFrames !== undefined
              ? { wakeWordSustainFrames: this.wakeWordSustainFrames }
              : {}),
            ...(this.wakeWordCooldownMs !== undefined
              ? { wakeWordCooldownMs: this.wakeWordCooldownMs }
              : {}),
          }
        : {};
    return {
      inputMode: 'mic',
      sttEnabled: true,
      sttVocabPaths: vocabPaths,
      ...(this.scriptPath !== undefined ? { scriptPath: this.scriptPath } : {}),
      ...(this.pythonPath !== undefined ? { pythonPath: this.pythonPath } : {}),
      ...(this.pythonPackageDir !== undefined
        ? { pythonPackageDir: this.pythonPackageDir }
        : {}),
      ...(this.homeDir !== undefined ? { homeDir: this.homeDir } : {}),
      ...(this.sttModel !== undefined ? { sttModel: this.sttModel } : {}),
      ...(this.maxUtteranceSeconds !== undefined
        ? { maxUtteranceSeconds: this.maxUtteranceSeconds }
        : {}),
      ...(this.partialIntervalMs !== undefined
        ? { partialIntervalMs: this.partialIntervalMs }
        : {}),
      ...wake,
      onStderr: (line) => {
        this.onStderr?.(line);
      },
    };
  }

  private onBridgeEvent(e: VoiceBridgeEvent): void {
    if (this.disposed) return;
    // Track the most-recent bridge clock for Ctrl+G arming + the summon gate.
    if ('tMs' in e && typeof e.tMs === 'number') {
      this.lastSeenTMs = e.tMs;
    }
    switch (e.type) {
      case 'wake_word':
        if (this.mode === 'always') this.armSummon(e.tMs);
        return;
      case 'speech_start':
        if (this.status === 'listening') this.transition('transcribing');
        // A summon's first speech_start cancels the timeout — we now wait for
        // its final (bounded by the bridge's own maxUtteranceSeconds cap).
        if (
          this.mode === 'always' &&
          this.summoned &&
          !this.summonSpeechStartSeen &&
          e.tMs >= this.armedAtMs
        ) {
          this.summonSpeechStartSeen = true;
          if (this.summonTimer !== undefined) {
            clearTimeout(this.summonTimer);
            this.summonTimer = undefined;
          }
        }
        return;
      case 'final': {
        const text = e.text.trim();
        if (text.length === 0) {
          // Empty/silence final — drop it, return to listening, keep any
          // armed summon (edge: an empty final must not consume the summon).
          if (this.status === 'transcribing') this.transition('listening');
          return;
        }
        if (this.mode === 'always') {
          if (this.summoned && e.tMs >= this.armedAtMs) {
            this.routeSummonFinal(text, e.tMs);
          } else {
            this.appendAmbient(text, 'vad', e.tMs);
            if (this.status === 'transcribing') this.transition('listening');
          }
        } else {
          this.routeFinal(text);
        }
        return;
      }
      case 'error':
        // Bridge `error` events are diagnostic (the bridge keeps running);
        // surface the message but do NOT tear the session down.
        this.lastError = `${e.code}: ${e.message}`;
        this.publish();
        return;
      default:
        // speech_end / partial / warning / stt_ready / ready / shutdown_ack —
        // no state change.
        return;
    }
  }

  // ----- summon arming (always mode) -------------------------------------

  private armSummon(atMs: number): void {
    if (this.disposed) return;
    if (this.mode !== 'always') return;
    this.summoned = true;
    this.armedAtMs = atMs;
    this.summonSpeechStartSeen = false;
    if (this.summonTimer !== undefined) clearTimeout(this.summonTimer);
    this.summonTimer = setTimeout(() => {
      this.onSummonTimeout();
    }, this.summonTimeoutMs);
    this.summonTimer.unref?.();
    this.publish();
  }

  private onSummonTimeout(): void {
    if (this.disposed) return;
    if (!this.summoned) return;
    this.summonTimer = undefined;
    if (this.status === 'transcribing') {
      // A summon utterance is mid-flight (the speech_start cancel raced the
      // timer). Wait a short grace for its final rather than dropping it.
      this.summonTimer = setTimeout(() => {
        this.onSummonTimeout();
      }, SUMMON_GRACE_MS);
      this.summonTimer.unref?.();
      return;
    }
    this.clearSummon();
    this.noticeSink?.('No utterance heard — voice summon dismissed.');
  }

  /** Disarm a summon (clear flag + timer). Publishes only on a real change. */
  private clearSummon(): void {
    if (this.summonTimer !== undefined) {
      clearTimeout(this.summonTimer);
      this.summonTimer = undefined;
    }
    const was = this.summoned;
    this.summoned = false;
    this.summonSpeechStartSeen = false;
    this.armedAtMs = 0;
    if (was) this.publish();
  }

  // ----- routing ----------------------------------------------------------

  private routeFinal(text: string): void {
    if (!this.canRoute()) {
      this.bufferPending(text, undefined, this.autoSend);
      return;
    }
    if (this.autoSend) {
      this.sendToMaestro?.(text);
      void this.stopSession();
      return;
    }
    this.injectToInput?.(text);
    if (this.status === 'transcribing') this.transition('listening');
  }

  /**
   * Route an always-mode summon final to Maestro WITH the recent ambient
   * context. The context block is computed BEFORE the summon utterance is
   * persisted so it never includes the utterance itself. The utterance is
   * then stored (source `'wake'`) AND sent — provenance + buffer continuity.
   */
  private routeSummonFinal(text: string, tMs: number): void {
    let contextText: string | undefined;
    if (this.store !== undefined) {
      try {
        const ctx = this.store.getContext({
          sessionId: this.sessionId,
          now: this.clock(),
        });
        contextText = ctx.text.length > 0 ? ctx.text : undefined;
      } catch {
        // best-effort — a buffer read failure must not drop the summon.
      }
    }
    this.appendAmbient(text, 'wake', tMs);
    this.clearSummon();
    if (!this.canRoute()) {
      this.bufferPending(text, contextText, false);
    } else if (this.autoSend) {
      if (contextText !== undefined) this.sendToMaestro?.(text, contextText);
      else this.sendToMaestro?.(text);
    } else {
      if (contextText !== undefined) this.injectToInput?.(text, contextText);
      else this.injectToInput?.(text);
    }
    if (this.status === 'transcribing') this.transition('listening');
  }

  /** Append an ambient (or summon) transcript to the rolling buffer. Best-effort. */
  private appendAmbient(text: string, source: 'vad' | 'wake', tMs: number): void {
    const store = this.store;
    if (store === undefined) return;
    const capped =
      text.length > VOICE_FINAL_MAX_LEN ? text.slice(0, VOICE_FINAL_MAX_LEN) : text;
    try {
      store.append({
        sessionId: this.sessionId,
        ts: new Date(this.clock()).toISOString(),
        tMs,
        text: capped,
        source,
      });
    } catch {
      // best-effort — a transient SQLITE_BUSY must never crash the TUI.
    }
  }

  private canRoute(): boolean {
    return this.autoSend
      ? this.sendToMaestro !== undefined
      : this.injectToInput !== undefined;
  }

  private bufferPending(
    text: string,
    contextText: string | undefined,
    endSessionAfter: boolean,
  ): void {
    this.pendingFinals.push({ text, contextText, endSessionAfter });
    if (this.pendingFinals.length > MAX_PENDING_FINALS) {
      this.pendingFinals.shift();
    }
  }

  /**
   * Flush finals buffered before the routing callbacks bound. Routes each
   * through the bound callback; summon-mode autoSend items also end the
   * session. Snapshot + clear BEFORE draining to avoid a re-push loop.
   */
  private flushPendingFinals(): void {
    if (this.disposed) return;
    if (this.pendingFinals.length === 0) return;
    if (!this.canRoute()) return;
    const queued = this.pendingFinals;
    this.pendingFinals = [];
    for (const item of queued) {
      if (this.autoSend) {
        if (item.contextText !== undefined) this.sendToMaestro?.(item.text, item.contextText);
        else this.sendToMaestro?.(item.text);
      } else {
        if (item.contextText !== undefined) this.injectToInput?.(item.text, item.contextText);
        else this.injectToInput?.(item.text);
      }
      if (item.endSessionAfter) void this.stopSession();
    }
  }

  // ----- compaction (always mode) ----------------------------------------

  private runCompaction(): Promise<void> {
    const store = this.store;
    if (store === undefined) return Promise.resolve();
    if (this.compactionInFlight !== null) return this.compactionInFlight;
    const pass = (async (): Promise<void> => {
      try {
        await store.compact(this.clock(), this.summarizer, this.compactionConfig);
      } catch {
        // best-effort
      } finally {
        this.compactionInFlight = null;
      }
    })();
    this.compactionInFlight = pass;
    return pass;
  }

  private async drainCompaction(): Promise<void> {
    if (this.compactionInFlight !== null) {
      await this.compactionInFlight.catch(() => undefined);
    }
  }

  private openStore(): { store: TranscriptStore; close: () => void } {
    if (this.storeFactory !== undefined) {
      return this.storeFactory(this.clock);
    }
    const handle = SymphonyDatabase.open({
      ...(this.dbFilePath !== undefined ? { filePath: this.dbFilePath } : {}),
    });
    const store = new SqliteTranscriptStore(handle.db);
    return {
      store,
      close: () => {
        handle.close();
      },
    };
  }

  /** Close the owned store connection. Idempotent. Never the engine's DB. */
  private closeStore(): void {
    const close = this.storeClose;
    this.store = undefined;
    this.storeClose = undefined;
    if (close !== undefined) {
      try {
        close();
      } catch {
        // best-effort
      }
    }
  }

  // ----- teardown ---------------------------------------------------------

  private onBridgeExit(): void {
    if (this.disposed) return;
    // Only an UNEXPECTED exit reaches here — `teardownBridge` detaches first.
    if (
      this.status === 'listening' ||
      this.status === 'transcribing' ||
      this.status === 'starting'
    ) {
      const tail = this.bridge?.getStderrTail() ?? '';
      this.detachBridge();
      this.bridge = undefined;
      // In always mode, stop the compaction loop + drop the summon (the
      // bridge is gone; alwaysActive flips false so the App releases away).
      if (this.compactionTimer !== undefined) {
        clearInterval(this.compactionTimer);
        this.compactionTimer = undefined;
      }
      this.clearSummon();
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
    // Any final buffered awaiting a late bind is now stale (it belongs to the
    // session being torn down). Drop it so it never leaks into a later session.
    this.pendingFinals = [];
    const bridge = this.bridge;
    if (bridge === undefined) return;
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
    const alwaysActive =
      this.mode === 'always' &&
      (this.status === 'listening' || this.status === 'transcribing');
    const base: VoiceSnapshot = {
      status: this.status,
      mode: this.mode,
      isListening,
      summoned: this.summoned,
      alwaysActive,
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
    a.summoned === b.summoned &&
    a.alwaysActive === b.alwaysActive &&
    a.lastError === b.lastError
  );
}

/**
 * Map a `bridge.start()` failure into a concise, ACTIONABLE `lastError`.
 * The `voice-env-missing` / `ready-timeout` / `spawn-failed` cases point at
 * `symphony voice install`. A non-empty stderr tail is appended (trimmed).
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
