import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { VoiceBridge, VoiceBridgeError } from '../voice/bridge.js';
import { resolveVoiceEnv } from '../voice/env.js';
import { resolveVoiceVocabPaths } from '../voice/path.js';
import type {
  VoiceBridgeEvent,
  VoiceTranscribeResult,
} from '../voice/types.js';

/**
 * Phase 6B — `symphony voice transcribe` CLI runner.
 *
 * Reads a WAV (RIFF) or raw 16-bit mono PCM file, pipes it through the
 * bridge in `--input-mode stdin-pcm`, collects events, returns the
 * joined transcript + structured payload.
 *
 * Input validation:
 *   - `.wav` extension → minimal RIFF header parse; reject non-PCM
 *     (format code != 1), non-16kHz, non-mono.
 *   - `.pcm` extension → assumed 16 kHz mono int16 raw PCM, header-less.
 *   - Any other extension → reject (`unsupported-audio-format`).
 *
 * Result is byte-symmetric with `VoiceDiagnoseResult`; consumers
 * (production scenario, agent-native tools) get the same JSON shape.
 */

const BRIDGE_READY_TIMEOUT_MS = 30_000;
const STT_READY_TIMEOUT_MS = 30_000;
const POST_PIPE_DRAIN_MS = 5_000;
// Match voice-diagnose's chunking (30 * 512-sample frames = ~0.96s of audio).
const PCM_CHUNK_BYTES = 1024 * 30;

export interface RunVoiceTranscribeOptions {
  readonly wavPath: string;
  readonly stdout?: NodeJS.WritableStream;
  readonly stderr?: NodeJS.WritableStream;
  readonly homeDir?: string;
  /** Override the project root used for resolving project-local vocab path. */
  readonly projectRoot?: string;
  /** Override the bridge construction (tests). */
  readonly bridgeFactory?: () => VoiceBridge;
  /** Format: 'human' (default) prints a transcript line; 'json' prints the full payload. */
  readonly format?: 'human' | 'json';
  /** Override the script path on the bridge (tests). */
  readonly scriptPath?: string;
  /** Override the python executable on the bridge (tests / non-default venv). */
  readonly pythonPath?: string;
  /** Override the python package dir on the bridge (tests). */
  readonly pythonPackageDir?: string;
  /** Override the STT model. Defaults to `moonshine/base`. */
  readonly sttModel?: 'moonshine/base' | 'moonshine/tiny';
  /** Override the partial-cadence in ms. */
  readonly partialIntervalMs?: number;
  /** Override the hard-cap utterance length. */
  readonly maxUtteranceSeconds?: number;
}

export async function runVoiceTranscribe(
  opts: RunVoiceTranscribeOptions,
): Promise<VoiceTranscribeResult> {
  const stdout = opts.stdout ?? process.stdout;
  const stderr = opts.stderr ?? process.stderr;
  const format = opts.format ?? 'human';
  const t0 = performance.now();
  const events: VoiceBridgeEvent[] = [];

  const buildResult = (
    overrides: Partial<VoiceTranscribeResult> & {
      ok: boolean;
      exitCode: number;
    },
    stderrTail = '',
  ): VoiceTranscribeResult => {
    const finals = events.filter((e) => e.type === 'final') as Array<
      Extract<VoiceBridgeEvent, { type: 'final' }>
    >;
    const partials = events.filter((e) => e.type === 'partial') as Array<
      Extract<VoiceBridgeEvent, { type: 'partial' }>
    >;
    const sttReady = events.some((e) => e.type === 'stt_ready');
    const truncated = events.some(
      (e) => e.type === 'warning' && e.code === 'utterance-truncated',
    );
    return {
      // Audit-m15: trim each final's text BEFORE joining so a leading
      // or trailing whitespace from Moonshine output doesn't double up
      // at the join boundary (e.g. "hello " + " world" -> "hello  world").
      transcript: finals
        .map((f) => f.text.trim())
        .filter((t) => t.length > 0)
        .join(' '),
      partials: partials.map((p) => ({ seq: p.seq, text: p.text, tMs: p.tMs })),
      finals: finals.map((f) => ({
        seq: f.seq,
        text: f.text,
        tMs: f.tMs,
        durationMs: f.durationMs,
      })),
      events: events.slice(),
      stderrTail,
      durationMs: Math.round(performance.now() - t0),
      sttReady,
      truncated,
      ...overrides,
    };
  };

  // 1. Verify venv (skipped when caller injects an explicit pythonPath)
  if (opts.pythonPath === undefined) {
    const summary = resolveVoiceEnv(opts.homeDir);
    if (!summary.exists) {
      const result = buildResult({ ok: false, exitCode: 1, reason: 'voice-env-missing' });
      emit(stdout, stderr, format, result, summary.pythonPath);
      return result;
    }
  }

  // 2. Read + decode the audio file.
  let pcmBytes: Buffer;
  try {
    const fileBytes = await fsp.readFile(opts.wavPath);
    pcmBytes = decodeAudioInput(opts.wavPath, fileBytes);
  } catch (cause) {
    const reason: VoiceTranscribeResult['reason'] =
      cause instanceof UnsupportedAudioFormatError
        ? 'unsupported-audio-format'
        : 'fixture-missing';
    const result = buildResult(
      { ok: false, exitCode: 1, reason },
      String(cause),
    );
    emit(stdout, stderr, format, result);
    return result;
  }

  // 3. Spawn bridge
  const bridge = opts.bridgeFactory ? opts.bridgeFactory() : new VoiceBridge();
  bridge.on('event', (e: VoiceBridgeEvent) => events.push(e));

  const vocabPaths = resolveVoiceVocabPaths({
    ...(opts.homeDir !== undefined ? { home: opts.homeDir } : {}),
    ...(opts.projectRoot !== undefined ? { projectRoot: opts.projectRoot } : {}),
  });

  try {
    await bridge.start({
      inputMode: 'stdin-pcm',
      sttVocabPaths: vocabPaths,
      ...(opts.sttModel !== undefined ? { sttModel: opts.sttModel } : {}),
      ...(opts.partialIntervalMs !== undefined
        ? { partialIntervalMs: opts.partialIntervalMs }
        : {}),
      ...(opts.maxUtteranceSeconds !== undefined
        ? { maxUtteranceSeconds: opts.maxUtteranceSeconds }
        : {}),
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
    const reason: VoiceTranscribeResult['reason'] = isReadyTimeout
      ? 'bridge-ready-timeout'
      : 'bridge-spawn-failed';
    const result = buildResult(
      { ok: false, exitCode: 1, reason },
      bridge.getStderrTail(),
    );
    emit(stdout, stderr, format, result);
    return result;
  }

  // 4. Wait for stt_ready (or skip if already seen). Bounded timeout
  // protects against Moonshine load+warmup hanging on an unreachable
  // HF Hub. If the model is fully warm from a prior install run, this
  // resolves quickly.
  if (!events.some((e) => e.type === 'stt_ready')) {
    try {
      await bridge.waitForEvent('stt_ready', STT_READY_TIMEOUT_MS);
    } catch {
      // No stt_ready — could be MoonshineLoadError emitted as 'error'
      // event, or a wedged warmup. Report and tear down.
      const result = buildResult(
        { ok: false, exitCode: 1, reason: 'stt-ready-timeout' },
        bridge.getStderrTail(),
      );
      emit(stdout, stderr, format, result);
      await bridge.stop().catch(() => undefined);
      return result;
    }
  }

  // 5. Pipe the PCM, chunk by chunk
  const stdinW = bridge.childStdin;
  if (stdinW === undefined) {
    const result = buildResult(
      { ok: false, exitCode: 1, reason: 'bridge-spawn-failed' },
      bridge.getStderrTail(),
    );
    emit(stdout, stderr, format, result);
    await bridge.stop().catch(() => undefined);
    return result;
  }

  let offset = 0;
  while (offset < pcmBytes.length) {
    const chunk = pcmBytes.subarray(
      offset,
      Math.min(offset + PCM_CHUNK_BYTES, pcmBytes.length),
    );
    await new Promise<void>((resolve, reject) => {
      stdinW.write(chunk, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    offset += chunk.length;
    // Pace at ~10x realtime so VAD + STT have time to process.
    await new Promise((r) => setTimeout(r, 25));
  }
  stdinW.end();

  // 6. Wait for the bridge to drain + emit shutdown_ack on stdin EOF.
  // Generous timeout — Moonshine final inference on a ~3s segment
  // takes 200-700ms on modern CPU, slow CPUs can hit a couple seconds.
  await new Promise<void>((resolve) => {
    let resolved = false;
    const onAck = (): void => {
      if (resolved) return;
      resolved = true;
      resolve();
    };
    bridge.once('shutdown_ack', onAck);
    bridge.once('exit', onAck);
    setTimeout(() => onAck(), POST_PIPE_DRAIN_MS + BRIDGE_READY_TIMEOUT_MS);
  });

  // 7. Wait for clean exit
  await bridge.stop({ graceMs: POST_PIPE_DRAIN_MS }).catch(() => undefined);

  // 8. Decide pass: at least one final event with non-empty text.
  const stderrTail = bridge.getStderrTail();
  const finals = events.filter((e) => e.type === 'final') as Array<
    Extract<VoiceBridgeEvent, { type: 'final' }>
  >;
  const hasNonEmptyFinal = finals.some((f) => f.text.length > 0);
  const ok = hasNonEmptyFinal;
  const result = buildResult(
    {
      ok,
      exitCode: ok ? 0 : 1,
      ...(ok ? {} : { reason: 'no-final-event' as const }),
    },
    stderrTail,
  );
  emit(stdout, stderr, format, result);
  return result;
}

function emit(
  stdout: NodeJS.WritableStream,
  stderr: NodeJS.WritableStream,
  format: 'human' | 'json',
  result: VoiceTranscribeResult,
  pythonPath?: string,
): void {
  if (format === 'json') {
    stdout.write(JSON.stringify(result) + '\n');
    return;
  }
  if (result.ok) {
    stdout.write(
      `[symphony] voice transcribe: PASS — ${result.finals.length} final(s), ${result.partials.length} partial(s), ${result.durationMs}ms\n`,
    );
    stdout.write(`           transcript: ${result.transcript || '(empty)'}\n`);
    if (result.truncated) {
      stdout.write(
        '           note: utterance was truncated at the configured max-utterance-seconds.\n',
      );
    }
  } else {
    stdout.write(
      `[symphony] voice transcribe: FAIL — reason=${result.reason ?? 'unknown'}, duration=${result.durationMs}ms\n`,
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
}

/**
 * Phase 6B — minimal WAV/PCM decoder.
 *
 * Strategy:
 *   - `.wav` extension OR file starts with "RIFF" magic → parse RIFF
 *     header, locate the `data` chunk, validate format (PCM, mono,
 *     16 kHz, 16-bit), return the data bytes verbatim.
 *   - `.pcm` extension AND no RIFF magic → return verbatim (caller
 *     contract: raw 16-bit mono 16 kHz PCM).
 *   - Any other extension OR malformed RIFF → throw
 *     UnsupportedAudioFormatError.
 *
 * The minimal RIFF parse handles the subset Symphony's fixtures
 * actually produce. Full WAV libraries would handle 24/32-bit float,
 * multi-channel, MS-ADPCM, etc. — out of scope for 6B. The user
 * supplies clean fixtures or gets a clear error.
 */
export function decodeAudioInput(filePath: string, bytes: Buffer): Buffer {
  const ext = path.extname(filePath).toLowerCase();
  const isRiff = bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF';
  if (ext === '.wav' || isRiff) {
    return decodeWav(bytes);
  }
  if (ext === '.pcm') {
    return bytes;
  }
  throw new UnsupportedAudioFormatError(
    `Unsupported audio format: ${filePath} (extension ${ext}; expected .wav or .pcm)`,
  );
}

function decodeWav(bytes: Buffer): Buffer {
  if (bytes.length < 44) {
    throw new UnsupportedAudioFormatError('WAV file shorter than 44 bytes');
  }
  if (bytes.toString('ascii', 0, 4) !== 'RIFF') {
    throw new UnsupportedAudioFormatError('WAV file missing RIFF magic');
  }
  if (bytes.toString('ascii', 8, 12) !== 'WAVE') {
    throw new UnsupportedAudioFormatError('WAV file missing WAVE marker');
  }
  // Walk chunks looking for 'fmt ' and 'data'. RIFF subchunks are
  // size-tagged 4-byte aligned blocks.
  let cursor = 12;
  let formatCode: number | null = null;
  let channels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  while (cursor + 8 <= bytes.length) {
    const chunkId = bytes.toString('ascii', cursor, cursor + 4);
    const chunkSize = bytes.readUInt32LE(cursor + 4);
    cursor += 8;
    if (chunkId === 'fmt ') {
      if (chunkSize < 16) {
        throw new UnsupportedAudioFormatError(
          `WAV fmt chunk too small (${chunkSize})`,
        );
      }
      formatCode = bytes.readUInt16LE(cursor);
      channels = bytes.readUInt16LE(cursor + 2);
      sampleRate = bytes.readUInt32LE(cursor + 4);
      bitsPerSample = bytes.readUInt16LE(cursor + 14);
      // fall through to advance the cursor
    } else if (chunkId === 'data') {
      // Validate format params
      if (formatCode !== 1) {
        throw new UnsupportedAudioFormatError(
          `WAV format code ${formatCode} (expected 1 = PCM int16)`,
        );
      }
      if (channels !== 1) {
        throw new UnsupportedAudioFormatError(
          `WAV channels=${channels} (expected 1 mono)`,
        );
      }
      if (sampleRate !== 16000) {
        throw new UnsupportedAudioFormatError(
          `WAV sampleRate=${sampleRate} (expected 16000)`,
        );
      }
      if (bitsPerSample !== 16) {
        throw new UnsupportedAudioFormatError(
          `WAV bitsPerSample=${bitsPerSample} (expected 16)`,
        );
      }
      return bytes.subarray(cursor, cursor + chunkSize);
    }
    // Advance cursor; chunks are word-aligned (pad odd sizes).
    cursor += chunkSize + (chunkSize % 2);
  }
  throw new UnsupportedAudioFormatError('WAV file missing data chunk');
}

export class UnsupportedAudioFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedAudioFormatError';
  }
}
