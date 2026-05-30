import { randomUUID } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import { performance } from 'node:perf_hooks';

import { VoiceBridge, VoiceBridgeError } from '../voice/bridge.js';
import { resolveVoiceEnv } from '../voice/env.js';
import { resolveVoiceVocabPaths } from '../voice/path.js';
import { loadConfig } from '../utils/config.js';
import { SymphonyDatabase } from '../state/db.js';
import { SqliteTranscriptStore } from '../state/sqlite-transcript-store.js';
import {
  DEFAULT_COMPACTION_WINDOW_MS,
  heuristicSummarizer,
  type CompactionConfig,
  type Summarizer,
  type TranscriptStore,
} from '../state/transcript-store.js';
import type { VoiceBridgeEvent } from '../voice/types.js';

/**
 * Phase 6D.1 — `symphony voice capture` always-capture runner.
 *
 * Boots the voice bridge with STT enabled, writes every VAD-gated `final`
 * transcript into the rolling context buffer (SQLite), and runs periodic
 * compaction so aged raw chunks roll up into local summaries. Raw audio is
 * never stored — only the transcribed text.
 *
 * Two input modes:
 *   - `mic` (default): live microphone. Runs until Ctrl-C / abort /
 *     `--max-seconds` / `--max-events`. Periodic compaction on an interval.
 *   - `stdin-pcm`: pipes a committed PCM fixture then drains + exits. This
 *     is the no-microphone production-scenario gate (mirrors
 *     `voice diagnose`).
 *
 * Compaction summarization uses the deterministic heuristic (a faithful
 * deduped join — never fabricates). A local-LLM summarizer was prototyped
 * (6D.2, T5-small ONNX) but REMOVED: on real ambient speech it hallucinated
 * facts and mostly truncated, which is unsafe for context fed to the
 * orchestrator. Summon-time summarization is deferred to Maestro (6E) —
 * it's a far better summarizer and only runs when the user engages. The
 * `opts.summarizer` injection seam remains for tests / a future model.
 */

const BRIDGE_READY_TIMEOUT_MS = 30_000;
const POST_PIPE_DRAIN_MS = 800;
const PCM_CHUNK_BYTES = 1024 * 30;
const DEFAULT_COMPACTION_INTERVAL_MS = 60_000;

export interface RunVoiceCaptureOptions {
  readonly stdout?: NodeJS.WritableStream;
  readonly stderr?: NodeJS.WritableStream;
  readonly homeDir?: string;
  /** `mic` (default) or `stdin-pcm` (fixture-driven, no mic). */
  readonly inputMode?: 'mic' | 'stdin-pcm';
  /** PCM fixture path — required for `stdin-pcm` mode. */
  readonly fixturePath?: string;
  /** Human (default) or one-JSON-summary output. */
  readonly format?: 'human' | 'json';
  /** Auto-exit after N stored transcript chunks. Default 0 (unbounded, mic mode). */
  readonly maxEvents?: number;
  /** Auto-exit after N seconds (mic mode). Default 0 (unbounded). */
  readonly maxSeconds?: number;
  /** Compaction cadence (mic mode). Default 60 s. */
  readonly compactionIntervalMs?: number;

  // ---- injection seams (tests / 6D.2) -------------------------------------
  /** Pre-built transcript store. When omitted, opens `SymphonyDatabase` itself. */
  readonly store?: TranscriptStore;
  /** Override the SQLite file path (when opening the store internally). */
  readonly dbFilePath?: string;
  /** Summarizer for compaction. Default = heuristic. 6D.2 injects the local-LLM one. */
  readonly summarizer?: Summarizer;
  /** Override the compaction config (skips the disk config read). */
  readonly compactionConfig?: CompactionConfig;
  /** Wall-clock source (epoch ms). Injected in tests for deterministic ts. Default `Date.now`. */
  readonly now?: () => number;
  /** Explicit session id. Default `randomUUID()`. */
  readonly sessionId?: string;
  /** Pre-built bridge (tests). */
  readonly bridgeFactory?: () => VoiceBridge;
  readonly scriptPath?: string;
  readonly pythonPath?: string;
  readonly pythonPackageDir?: string;
  /** AbortSignal — stops the capture loop (mic mode). */
  readonly signal?: AbortSignal;
}

export interface VoiceCaptureResult {
  readonly ok: boolean;
  readonly exitCode: number;
  readonly reason?:
    | 'voice-env-missing'
    | 'fixture-missing'
    | 'bridge-spawn-failed'
    | 'bridge-ready-timeout'
    | 'bridge-load-failed'
    | 'aborted';
  readonly sessionId: string;
  /** Raw transcript chunks written to the buffer this session. */
  readonly chunksStored: number;
  /** Summary rows created by compaction this session. */
  readonly summariesCreated: number;
  readonly durationMs: number;
  readonly stderrTail: string;
}

export async function runVoiceCapture(
  opts: RunVoiceCaptureOptions = {},
): Promise<VoiceCaptureResult> {
  const stdout = opts.stdout ?? process.stdout;
  const stderr = opts.stderr ?? process.stderr;
  const format = opts.format ?? 'human';
  const inputMode = opts.inputMode ?? 'mic';
  const clock = opts.now ?? Date.now;
  const sessionId = opts.sessionId ?? randomUUID();
  const summarizer: Summarizer = opts.summarizer ?? heuristicSummarizer;
  const maxEvents = Math.max(0, opts.maxEvents ?? 0);
  const maxSeconds = Math.max(0, opts.maxSeconds ?? 0);
  const t0 = performance.now();

  let chunksStored = 0;
  let summariesCreated = 0;

  const buildResult = (
    extra: Partial<VoiceCaptureResult> & { ok: boolean; exitCode: number },
    stderrTail = '',
  ): VoiceCaptureResult => ({
    sessionId,
    chunksStored,
    summariesCreated,
    durationMs: Math.round(performance.now() - t0),
    stderrTail,
    ...extra,
  });

  // 1. Verify venv (skipped when caller injects an explicit pythonPath).
  if (opts.pythonPath === undefined) {
    const summary = resolveVoiceEnv(opts.homeDir);
    if (!summary.exists) {
      const result = buildResult({ ok: false, exitCode: 1, reason: 'voice-env-missing' });
      emitFailure(stdout, stderr, format, result, summary.pythonPath);
      return result;
    }
  }

  // 2. For stdin-pcm: read the fixture up-front (structured failure, not a throw).
  let fixtureBytes: Buffer | undefined;
  if (inputMode === 'stdin-pcm') {
    if (opts.fixturePath === undefined) {
      const result = buildResult({ ok: false, exitCode: 1, reason: 'fixture-missing' });
      emitFailure(stdout, stderr, format, result);
      return result;
    }
    try {
      fixtureBytes = await fsp.readFile(opts.fixturePath);
    } catch (cause) {
      const result = buildResult({ ok: false, exitCode: 1, reason: 'fixture-missing' }, String(cause));
      emitFailure(stdout, stderr, format, result);
      return result;
    }
  }

  // 3. Resolve compaction config + summarizer.
  const compactionConfig = opts.compactionConfig ?? (await resolveCompactionConfig());

  // 4. Open (or accept) the transcript store.
  let ownedDb: SymphonyDatabase | undefined;
  let store: TranscriptStore;
  if (opts.store !== undefined) {
    store = opts.store;
  } else {
    ownedDb = SymphonyDatabase.open({
      ...(opts.dbFilePath !== undefined ? { filePath: opts.dbFilePath } : {}),
    });
    store = new SqliteTranscriptStore(ownedDb.db);
  }

  const closeDb = (): void => {
    if (ownedDb !== undefined) {
      try {
        ownedDb.close();
      } catch {
        // best-effort
      }
    }
  };

  // 5. Spawn the bridge.
  const bridge = opts.bridgeFactory ? opts.bridgeFactory() : new VoiceBridge();
  const vocabPaths = resolveVoiceVocabPaths({
    ...(opts.homeDir !== undefined ? { home: opts.homeDir } : {}),
  });

  // Subscribe BEFORE start so no early `final` is missed.
  bridge.on('event', (e: VoiceBridgeEvent) => {
    if (e.type !== 'final') return;
    // Hard cap: once maxEvents is hit, stop STORING further finals even if
    // a burst (e.g. the fixture path) emits several in one synchronous
    // tick before `bridge.stop()` lands.
    if (maxEvents > 0 && chunksStored >= maxEvents) return;
    const text = e.text.trim();
    if (text.length === 0) return; // never store empty/silence finals
    store.append({
      sessionId,
      ts: new Date(clock()).toISOString(),
      tMs: e.tMs,
      text,
      source: 'vad',
    });
    chunksStored += 1;
    if (format === 'human') {
      stdout.write(`[capture] ${text}\n`);
    } else {
      stdout.write(JSON.stringify({ type: 'stored', tMs: e.tMs, text }) + '\n');
    }
    if (maxEvents > 0 && chunksStored >= maxEvents) {
      void bridge.stop({ graceMs: 2000 }).catch(() => undefined);
    }
  });

  try {
    await bridge.start({
      inputMode,
      sttEnabled: true,
      sttVocabPaths: vocabPaths,
      ...(opts.scriptPath !== undefined ? { scriptPath: opts.scriptPath } : {}),
      ...(opts.pythonPath !== undefined ? { pythonPath: opts.pythonPath } : {}),
      ...(opts.pythonPackageDir !== undefined ? { pythonPackageDir: opts.pythonPackageDir } : {}),
      onStderr: (line) => {
        if (format === 'human') stderr.write(`[voice-bridge] ${line}\n`);
      },
    });
  } catch (cause) {
    const isReadyTimeout = cause instanceof VoiceBridgeError && cause.code === 'ready-timeout';
    const reason = isReadyTimeout ? 'bridge-ready-timeout' : 'bridge-spawn-failed';
    const result = buildResult({ ok: false, exitCode: 1, reason }, bridge.getStderrTail());
    emitFailure(stdout, stderr, format, result);
    closeDb();
    return result;
  }

  emitReadyBanner(stdout, format, sessionId, inputMode);

  // Single-flight compaction (audit-M1): overlapping passes would each
  // INSERT a summary for the same aged span — duplicate rows + a
  // double-counted `summariesCreated`. The interval skips while a pass is
  // in flight (the guard also protects any future async summarizer that
  // makes the await window real). Errors are swallowed — a failed
  // compaction must never crash an active capture.
  let compactionInFlight: Promise<void> | null = null;
  const runCompaction = (): Promise<void> => {
    if (compactionInFlight !== null) return compactionInFlight;
    compactionInFlight = (async () => {
      try {
        const r = await store.compact(clock(), summarizer, compactionConfig);
        summariesCreated += r.summariesCreated;
      } catch {
        // best-effort
      } finally {
        compactionInFlight = null;
      }
    })();
    return compactionInFlight;
  };
  const drainCompaction = async (): Promise<void> => {
    if (compactionInFlight !== null) await compactionInFlight.catch(() => undefined);
  };

  if (inputMode === 'stdin-pcm') {
    await pipeFixture(bridge, fixtureBytes!);
    await runCompaction();
    const stderrTail = bridge.getStderrTail();
    closeDb();
    if (format === 'human') {
      stdout.write(
        `[symphony] voice capture: stored ${chunksStored} chunk(s), ` +
          `${summariesCreated} summary(ies) in ${Math.round(performance.now() - t0)}ms.\n`,
      );
    }
    return buildResult({ ok: true, exitCode: 0 }, stderrTail);
  }

  // --- mic mode: periodic compaction + wait for exit/abort/maxSeconds ---
  const intervalMs = Math.max(1000, opts.compactionIntervalMs ?? DEFAULT_COMPACTION_INTERVAL_MS);
  const compactionTimer = setInterval(() => {
    void runCompaction();
  }, intervalMs);
  compactionTimer.unref();

  const exitInfo = await waitForCaptureEnd(bridge, opts.signal, maxSeconds);
  clearInterval(compactionTimer);

  // Stop the bridge first (no further finals), drain any in-flight
  // interval compaction, then run one final consolidation pass. Order
  // guarantees no compaction is mid-flight when `closeDb()` runs (audit-M1
  // + the closed-DB-write minor).
  await bridge.stop({ graceMs: 2000 }).catch(() => undefined);
  await drainCompaction();
  await runCompaction();
  const stderrTail = bridge.getStderrTail();
  closeDb();

  if (opts.signal?.aborted === true) {
    if (format === 'human') {
      stdout.write(
        `[symphony] voice capture: aborted — stored ${chunksStored} chunk(s), ` +
          `${summariesCreated} summary(ies).\n`,
      );
    }
    return buildResult({ ok: true, exitCode: 0, reason: 'aborted' }, stderrTail);
  }
  if (exitInfo.exitCode !== 0 && exitInfo.exitCode !== null) {
    return buildResult({ ok: false, exitCode: 1, reason: 'bridge-load-failed' }, stderrTail);
  }
  if (format === 'human') {
    stdout.write(
      `[symphony] voice capture: stored ${chunksStored} chunk(s), ` +
        `${summariesCreated} summary(ies).\n`,
    );
  }
  return buildResult({ ok: true, exitCode: 0 }, stderrTail);
}

async function resolveCompactionConfig(): Promise<CompactionConfig> {
  // Best-effort disk read — falls back to schema defaults on failure.
  let rawRetentionMinutes = 120;
  let summaryRetentionHours = 168;
  let maxChunks = 5000;
  let summaryMaxChars = 500;
  try {
    const { config } = await loadConfig();
    rawRetentionMinutes = config.voice.bufferRawRetentionMinutes;
    summaryRetentionHours = config.voice.bufferSummaryRetentionHours;
    maxChunks = config.voice.bufferMaxChunks;
    summaryMaxChars = config.voice.bufferSummaryMaxChars;
  } catch {
    // defaults fall through
  }
  return {
    rawRetentionMs: rawRetentionMinutes * 60_000,
    summaryRetentionMs: summaryRetentionHours * 3_600_000,
    maxChunks,
    windowMs: DEFAULT_COMPACTION_WINDOW_MS,
    summaryMaxChars,
  };
}

async function pipeFixture(bridge: VoiceBridge, fixtureBytes: Buffer): Promise<void> {
  const stdin = bridge.childStdin;
  if (stdin === undefined) return;
  let offset = 0;
  while (offset < fixtureBytes.length) {
    const chunk = fixtureBytes.subarray(offset, Math.min(offset + PCM_CHUNK_BYTES, fixtureBytes.length));
    await new Promise<void>((resolve, reject) => {
      stdin.write(chunk, (err) => (err ? reject(err) : resolve()));
    });
    offset += chunk.length;
    await new Promise((r) => setTimeout(r, 25));
  }
  stdin.end();
  // Wait for the bridge to drain + emit shutdown_ack / exit on stdin EOF.
  await new Promise<void>((resolve) => {
    let resolved = false;
    const done = (): void => {
      if (resolved) return;
      resolved = true;
      resolve();
    };
    bridge.once('shutdown_ack', done);
    bridge.once('exit', done);
    setTimeout(done, POST_PIPE_DRAIN_MS + BRIDGE_READY_TIMEOUT_MS);
  });
  await bridge.stop({ graceMs: POST_PIPE_DRAIN_MS }).catch(() => undefined);
}

function waitForCaptureEnd(
  bridge: VoiceBridge,
  signal: AbortSignal | undefined,
  maxSeconds: number,
): Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (info: { exitCode: number | null; signal: NodeJS.Signals | null }): void => {
      if (settled) return;
      settled = true;
      resolve(info);
    };
    bridge.once('exit', settle);
    if (signal !== undefined) {
      if (signal.aborted) {
        settle({ exitCode: null, signal: null });
        return;
      }
      signal.addEventListener('abort', () => settle({ exitCode: null, signal: null }), {
        once: true,
      });
    }
    if (maxSeconds > 0) {
      setTimeout(() => settle({ exitCode: null, signal: null }), maxSeconds * 1000).unref();
    }
    // Belt-and-suspenders cap so a frozen bridge surfaces eventually.
    setTimeout(
      () => settle({ exitCode: null, signal: null }),
      24 * 60 * 60 * 1000 + BRIDGE_READY_TIMEOUT_MS,
    ).unref();
  });
}

function emitReadyBanner(
  stdout: NodeJS.WritableStream,
  format: 'human' | 'json',
  sessionId: string,
  inputMode: 'mic' | 'stdin-pcm',
): void {
  if (format === 'json') {
    stdout.write(JSON.stringify({ type: 'capture_ready', sessionId, inputMode }) + '\n');
    return;
  }
  stdout.write(
    `[ready] capturing (session ${sessionId.slice(0, 8)}). ` +
      `Transcripts stored locally; raw audio discarded. ` +
      `${inputMode === 'mic' ? 'Press Ctrl-C to stop.' : ''}\n`,
  );
}

function emitFailure(
  stdout: NodeJS.WritableStream,
  stderr: NodeJS.WritableStream,
  format: 'human' | 'json',
  result: VoiceCaptureResult,
  pythonPath?: string,
): void {
  if (format === 'json') {
    stdout.write(JSON.stringify(result) + '\n');
    return;
  }
  stdout.write(
    `[symphony] voice capture: FAIL — reason=${result.reason ?? 'unknown'}, ` +
      `chunksStored=${result.chunksStored}, durationMs=${result.durationMs}\n`,
  );
  if (result.reason === 'voice-env-missing') {
    stderr.write(
      `[symphony] Voice venv missing${pythonPath ? ` at ${pythonPath}` : ''}. Run \`symphony voice install\`.\n`,
    );
  }
  if (result.stderrTail.length > 0) {
    stderr.write('[symphony] voice-bridge stderr tail:\n');
    for (const line of result.stderrTail.split('\n')) {
      if (line.length > 0) stderr.write(`           ${line}\n`);
    }
  }
}
