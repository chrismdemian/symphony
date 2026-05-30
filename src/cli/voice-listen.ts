import { performance } from 'node:perf_hooks';

import { VoiceBridge, VoiceBridgeError } from '../voice/bridge.js';
import { resolveVoiceEnv } from '../voice/env.js';
import {
  voiceWakeModelPath,
  VoiceWakeModelNotFoundError,
} from '../voice/path.js';
import { loadConfig } from '../utils/config.js';
import type { VoiceBridgeEvent } from '../voice/types.js';

/**
 * Phase 6C — `symphony voice listen` live-mic wake-word demonstrator.
 *
 * Boots the bridge in `--input-mode mic` with wake-word enabled,
 * forwards `wake_word` events to stdout as human-readable lines or
 * JSON, and exits cleanly on SIGINT (Ctrl-C). Optional `--max-events
 * N` auto-exits after N detections, used by non-interactive smoke
 * scripts.
 *
 * Distinct from `symphony voice diagnose` (which is fixture-driven and
 * runs against committed PCM) — this command needs a real microphone
 * and is purely for hardware-side validation before 6E ships the TUI.
 *
 * Format guarantees:
 *   - human (default): one line per event, like:
 *       `[wake] hey-symphony @ 12345ms (score 0.83)`
 *       `[err] wake-word-load-failed: ...`
 *       `[ready] listening for "hey-symphony" (threshold 0.5, cooldown 2000ms)`
 *   - json: one JSON object per event (the raw VoiceBridgeEvent shape)
 *     — useful for `| jq` pipelines + Phase 6E integration testing.
 */

const DEFAULT_MAX_EVENTS = 0; // 0 = unbounded
const BRIDGE_READY_TIMEOUT_MS = 30_000;

export interface RunVoiceListenOptions {
  readonly stdout?: NodeJS.WritableStream;
  readonly stderr?: NodeJS.WritableStream;
  readonly homeDir?: string;
  /** Override the wake-word model name. Default from voice.wakeWordModel config. */
  readonly modelName?: string;
  /** Override the wake-word threshold (0..1). Default from voice.wakeWordThreshold config. */
  readonly threshold?: number;
  /** Override the cooldown (ms). Default from voice.wakeWordCooldownMs config. */
  readonly cooldownMs?: number;
  /** Override the sustain frames count. Default from voice.wakeWordSustainFrames config. */
  readonly sustainFrames?: number;
  /** Auto-exit after N wake-word events. Default 0 (unbounded). */
  readonly maxEvents?: number;
  /** Human-readable (default) or one-JSON-per-event. */
  readonly format?: 'human' | 'json';
  /** Test seam: pre-built bridge. */
  readonly bridgeFactory?: () => VoiceBridge;
  /** Test seam: skip the readSymphonyConfig disk read + use these overrides instead. */
  readonly bridgeOptionsOverride?: {
    readonly modelName: string;
    readonly threshold: number;
    readonly sustainFrames: number;
    readonly cooldownMs: number;
  };
  /** Test seam: bridge script path override (for fake-bridge.mjs in tests). */
  readonly scriptPath?: string;
  /** Test seam: python executable override. */
  readonly pythonPath?: string;
  /** Test seam: python package dir override. */
  readonly pythonPackageDir?: string;
  /**
   * Test seam: bypass `voiceWakeModelPath()` and use this string verbatim
   * as the model path. Lets unit tests run against the fake-bridge
   * without needing a real `.onnx` on disk.
   */
  readonly wakeModelPathOverride?: string;
  /** Test seam: AbortSignal — stops the listen loop early. */
  readonly signal?: AbortSignal;
}

export interface VoiceListenResult {
  readonly ok: boolean;
  readonly exitCode: number;
  readonly reason?:
    | 'voice-env-missing'
    | 'wake-model-missing'
    | 'bridge-spawn-failed'
    | 'bridge-ready-timeout'
    | 'bridge-load-failed'
    | 'aborted';
  /** Total wake-word events observed during the session. */
  readonly wakeEvents: number;
  /** Total error events observed (non-fatal). */
  readonly errorEvents: number;
  /** Wall-clock duration of the listen session, in ms. */
  readonly durationMs: number;
  /** Stderr tail captured from the bridge (for failure reporting). */
  readonly stderrTail: string;
}

export async function runVoiceListen(
  opts: RunVoiceListenOptions = {},
): Promise<VoiceListenResult> {
  const stdout = opts.stdout ?? process.stdout;
  const stderr = opts.stderr ?? process.stderr;
  const format = opts.format ?? 'human';
  const maxEvents = Math.max(0, opts.maxEvents ?? DEFAULT_MAX_EVENTS);
  const t0 = performance.now();
  let wakeEvents = 0;
  let errorEvents = 0;

  const buildResult = (
    extra: Partial<VoiceListenResult> & { ok: boolean; exitCode: number },
    stderrTail = '',
  ): VoiceListenResult => ({
    wakeEvents,
    errorEvents,
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

  // 2. Resolve config + wake-word model.
  const resolved = await resolveBridgeOpts(opts);

  let modelPath: string;
  if (opts.wakeModelPathOverride !== undefined) {
    modelPath = opts.wakeModelPathOverride;
  } else {
    try {
      modelPath = voiceWakeModelPath(resolved.modelName);
    } catch (cause) {
      const reason =
        cause instanceof VoiceWakeModelNotFoundError
          ? 'wake-model-missing'
          : 'bridge-spawn-failed';
      const result = buildResult(
        { ok: false, exitCode: 1, reason },
        String(cause),
      );
      emitFailure(stdout, stderr, format, result);
      return result;
    }
  }

  // 3. Spawn the bridge.
  const bridge = opts.bridgeFactory ? opts.bridgeFactory() : new VoiceBridge();

  // 4. Subscribe to events BEFORE start() so we never miss the early
  //    `wake-word-load-failed` error event that fires inside Bridge.init.
  bridge.on('event', (e: VoiceBridgeEvent) => {
    if (e.type === 'wake_word') {
      wakeEvents += 1;
      emitWake(stdout, format, e);
      if (maxEvents > 0 && wakeEvents >= maxEvents) {
        // Tear down the bridge to release the mic + exit clean.
        void bridge.stop({ graceMs: 2000 }).catch(() => undefined);
      }
    } else if (e.type === 'error') {
      errorEvents += 1;
      emitError(format, e, stderr);
    }
  });

  try {
    await bridge.start({
      inputMode: 'mic',
      wakeWordEnabled: true,
      wakeWordModelPath: modelPath,
      wakeWordModelName: resolved.modelName,
      wakeWordThreshold: resolved.threshold,
      wakeWordSustainFrames: resolved.sustainFrames,
      wakeWordCooldownMs: resolved.cooldownMs,
      sttEnabled: false, // pure wake-word — no STT/VAD events to display
      ...(opts.scriptPath !== undefined ? { scriptPath: opts.scriptPath } : {}),
      ...(opts.pythonPath !== undefined ? { pythonPath: opts.pythonPath } : {}),
      ...(opts.pythonPackageDir !== undefined
        ? { pythonPackageDir: opts.pythonPackageDir }
        : {}),
      onStderr: (line) => {
        if (format === 'human') stderr.write(`[voice-bridge] ${line}\n`);
      },
    });
  } catch (cause) {
    const isReadyTimeout =
      cause instanceof VoiceBridgeError && cause.code === 'ready-timeout';
    const reason = isReadyTimeout ? 'bridge-ready-timeout' : 'bridge-spawn-failed';
    const result = buildResult(
      { ok: false, exitCode: 1, reason },
      bridge.getStderrTail(),
    );
    emitFailure(stdout, stderr, format, result);
    return result;
  }

  // Print the "ready" banner so users on the command line know they
  // can speak now (and so non-interactive tests can wait for it).
  emitReadyBanner(stdout, format, resolved);

  // 5. Wait until either: bridge exits, signal aborts, OR maxEvents reached
  //    (the on('event') handler triggers bridge.stop() in that case).
  const exitInfo = await waitForExit(bridge, opts.signal);
  const stderrTail = bridge.getStderrTail();

  // Make sure the bridge is fully stopped (no-op if exitInfo already
  // marks it stopped).
  await bridge.stop({ graceMs: 2000 }).catch(() => undefined);

  // 6. Compose result.
  const aborted = opts.signal?.aborted === true;
  if (aborted) {
    return buildResult({ ok: true, exitCode: 0, reason: 'aborted' }, stderrTail);
  }
  if (exitInfo.exitCode !== 0 && exitInfo.exitCode !== null) {
    return buildResult(
      { ok: false, exitCode: 1, reason: 'bridge-load-failed' },
      stderrTail,
    );
  }
  return buildResult({ ok: true, exitCode: 0 }, stderrTail);
}

/**
 * Resolve bridge options from config disk read + opts overrides. Pulled
 * into its own helper so tests can inject `bridgeOptionsOverride` and
 * skip the disk read entirely (no need for SYMPHONY_CONFIG_FILE fixture
 * juggling in every unit test).
 */
async function resolveBridgeOpts(opts: RunVoiceListenOptions): Promise<{
  readonly modelName: string;
  readonly threshold: number;
  readonly sustainFrames: number;
  readonly cooldownMs: number;
}> {
  if (opts.bridgeOptionsOverride !== undefined) {
    return opts.bridgeOptionsOverride;
  }
  // Best-effort disk read — falls back to schema defaults on any
  // failure (corrupt config, missing file). Voice config is opt-in by
  // design, so a missing file just means "all defaults".
  let modelName = 'hey-symphony';
  let threshold = 0.5;
  let sustainFrames = 3;
  let cooldownMs = 2000;
  try {
    const result = await loadConfig();
    modelName = result.config.voice.wakeWordModel;
    threshold = result.config.voice.wakeWordThreshold;
    sustainFrames = result.config.voice.wakeWordSustainFrames;
    cooldownMs = result.config.voice.wakeWordCooldownMs;
  } catch {
    // ignore — defaults fall through
  }
  // CLI flag overrides win over both config + defaults.
  return {
    modelName: opts.modelName ?? modelName,
    threshold: opts.threshold ?? threshold,
    sustainFrames: opts.sustainFrames ?? sustainFrames,
    cooldownMs: opts.cooldownMs ?? cooldownMs,
  };
}

function emitWake(
  stdout: NodeJS.WritableStream,
  format: 'human' | 'json',
  event: Extract<VoiceBridgeEvent, { type: 'wake_word' }>,
): void {
  if (format === 'json') {
    stdout.write(JSON.stringify(event) + '\n');
    return;
  }
  const ms = event.tMs.toString().padStart(5, ' ');
  const score = event.score.toFixed(3);
  stdout.write(`[wake] ${event.model} @ ${ms}ms (score ${score})\n`);
}

function emitError(
  format: 'human' | 'json',
  event: Extract<VoiceBridgeEvent, { type: 'error' }>,
  stderr: NodeJS.WritableStream,
): void {
  if (format === 'json') {
    // Always to stdout for json mode so the consumer's `| jq` pipe sees
    // every event uniformly.
    process.stdout.write(JSON.stringify(event) + '\n');
    return;
  }
  stderr.write(`[err] ${event.code}: ${event.message}\n`);
}

function emitReadyBanner(
  stdout: NodeJS.WritableStream,
  format: 'human' | 'json',
  resolved: { modelName: string; threshold: number; cooldownMs: number },
): void {
  if (format === 'json') {
    stdout.write(
      JSON.stringify({
        type: 'listen_ready',
        modelName: resolved.modelName,
        threshold: resolved.threshold,
        cooldownMs: resolved.cooldownMs,
      }) + '\n',
    );
    return;
  }
  stdout.write(
    `[ready] listening for "${resolved.modelName}" ` +
      `(threshold ${resolved.threshold}, cooldown ${resolved.cooldownMs}ms). ` +
      `Press Ctrl-C to exit.\n`,
  );
}

function emitFailure(
  stdout: NodeJS.WritableStream,
  stderr: NodeJS.WritableStream,
  format: 'human' | 'json',
  result: VoiceListenResult,
  pythonPath?: string,
): void {
  if (format === 'json') {
    stdout.write(JSON.stringify(result) + '\n');
    return;
  }
  stdout.write(
    `[symphony] voice listen: FAIL — reason=${result.reason ?? 'unknown'}, ` +
      `wakeEvents=${result.wakeEvents}, durationMs=${result.durationMs}\n`,
  );
  if (result.reason === 'voice-env-missing') {
    stderr.write(
      `[symphony] Voice venv missing${pythonPath ? ` at ${pythonPath}` : ''}. Run \`symphony voice install\`.\n`,
    );
  }
  if (result.reason === 'wake-model-missing') {
    stderr.write(
      '[symphony] No wake-word model found. See scripts/train-wake-word/README.md ' +
        'to produce assets/wake-models/hey-symphony.onnx.\n',
    );
  }
  if (result.stderrTail.length > 0) {
    stderr.write('[symphony] voice-bridge stderr tail:\n');
    for (const line of result.stderrTail.split('\n')) {
      if (line.length > 0) stderr.write(`           ${line}\n`);
    }
  }
}

/**
 * Wait for the bridge to exit, or for the abort signal to fire. Whichever
 * happens first wins. Returns the exit info (which may be a synthetic
 * `{exitCode: null, signal: null}` on abort path).
 */
function waitForExit(
  bridge: VoiceBridge,
  signal?: AbortSignal,
): Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve) => {
    let settled = false;
    const onExit = (info: {
      exitCode: number | null;
      signal: NodeJS.Signals | null;
    }): void => {
      if (settled) return;
      settled = true;
      resolve(info);
    };
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      // Don't await stop() here — the caller awaits it; we resolve
      // immediately so the listen function can move on.
      resolve({ exitCode: null, signal: null });
    };
    bridge.once('exit', onExit);
    if (signal !== undefined) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
    // Belt-and-suspenders: cap at BRIDGE_READY_TIMEOUT_MS + 24h. A live
    // mic session that runs forever is a feature, but a frozen bridge
    // that never exits should surface eventually.
    setTimeout(
      () => {
        if (settled) return;
        settled = true;
        resolve({ exitCode: null, signal: null });
      },
      24 * 60 * 60 * 1000 + BRIDGE_READY_TIMEOUT_MS,
    ).unref();
  });
}
