import { promises as fsp } from 'node:fs';
import { performance } from 'node:perf_hooks';

import { VoiceBridge, VoiceBridgeError } from '../voice/bridge.js';
import { resolveVoiceEnv } from '../voice/env.js';
import { voiceDiagnoseFixturePath } from '../voice/path.js';
import type { VoiceBridgeEvent, VoiceDiagnoseResult } from '../voice/types.js';

/**
 * Phase 6A — `symphony voice diagnose` CLI runner.
 *
 * Boots the voice bridge in `--input-mode stdin-pcm`, pipes the
 * committed PCM fixture (`tests/fixtures/voice/diagnose-3s.pcm`,
 * speech-silence-speech-silence), and asserts ≥1 `speech_start` +
 * `speech_end` events fire. PASS exits 0 with a JSON summary; FAIL
 * exits 1 with the same shape + a `reason` slug.
 *
 * No real microphone required — this command IS the production
 * scenario gate for 6A.
 */

const EXPECTED_MIN_SEGMENTS = 1;
const BRIDGE_READY_TIMEOUT_MS = 30_000;
const POST_PIPE_DRAIN_MS = 800;
// Stream chunks of 30 frames (~0.96s of audio at 512 samples/frame).
// The fixture is small (~100KB total) but the chunked pattern is the
// right shape for 6B's streaming STT integration. Pinned to a
// multiple of 1024 (= 512 samples × 2 bytes) so the bridge's
// frame-by-frame stdin read stays aligned and never has to coalesce
// across `read()` calls in the common case.
const PCM_CHUNK_BYTES = 1024 * 30;

export interface RunVoiceDiagnoseOptions {
  readonly stdout?: NodeJS.WritableStream;
  readonly stderr?: NodeJS.WritableStream;
  readonly homeDir?: string;
  /** Override the PCM fixture path (tests / debugging). */
  readonly fixturePath?: string;
  /** Override the bridge construction (tests). */
  readonly bridgeFactory?: () => VoiceBridge;
  /** Format the result: 'human' (default) or 'json' (for scripting / scenario gate). */
  readonly format?: 'human' | 'json';
  /** Override the script path on the bridge (passed through to start()). */
  readonly scriptPath?: string;
  /** Override the python executable on the bridge. */
  readonly pythonPath?: string;
  /** Override the python package dir on the bridge. */
  readonly pythonPackageDir?: string;
}

export async function runVoiceDiagnose(
  opts: RunVoiceDiagnoseOptions = {},
): Promise<VoiceDiagnoseResult> {
  const stdout = opts.stdout ?? process.stdout;
  const stderr = opts.stderr ?? process.stderr;
  const format = opts.format ?? 'human';
  const t0 = performance.now();

  // 1. Verify venv (skipped when caller injects an explicit pythonPath)
  if (opts.pythonPath === undefined) {
    const summary = resolveVoiceEnv(opts.homeDir);
    if (!summary.exists) {
      const result: VoiceDiagnoseResult = {
        ok: false,
        exitCode: 1,
        reason: 'voice-env-missing',
        speechSegments: 0,
        events: [],
        stderrTail: '',
        durationMs: Math.round(performance.now() - t0),
      };
      emit(stdout, stderr, format, result, summary.pythonPath);
      return result;
    }
  }

  // 2. Resolve fixture
  let fixturePath: string;
  try {
    fixturePath = opts.fixturePath ?? voiceDiagnoseFixturePath();
  } catch (cause) {
    const result: VoiceDiagnoseResult = {
      ok: false,
      exitCode: 1,
      reason: 'fixture-missing',
      speechSegments: 0,
      events: [],
      stderrTail: String(cause),
      durationMs: Math.round(performance.now() - t0),
    };
    emit(stdout, stderr, format, result);
    return result;
  }

  const fixtureBytes = await fsp.readFile(fixturePath);

  // 3. Spawn bridge
  const bridge = opts.bridgeFactory ? opts.bridgeFactory() : new VoiceBridge();
  const events: VoiceBridgeEvent[] = [];
  bridge.on('event', (e) => events.push(e));

  try {
    await bridge.start({
      inputMode: 'stdin-pcm',
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
    const reason: VoiceDiagnoseResult['reason'] = isReadyTimeout
      ? 'bridge-ready-timeout'
      : 'bridge-spawn-failed';
    const result: VoiceDiagnoseResult = {
      ok: false,
      exitCode: 1,
      reason,
      speechSegments: 0,
      events,
      stderrTail: bridge.getStderrTail(),
      durationMs: Math.round(performance.now() - t0),
    };
    emit(stdout, stderr, format, result);
    return result;
  }

  // 4. Pipe the fixture, chunk by chunk
  const stdin = bridge.childStdin;
  if (stdin === undefined) {
    const result: VoiceDiagnoseResult = {
      ok: false,
      exitCode: 1,
      reason: 'bridge-spawn-failed',
      speechSegments: 0,
      events,
      stderrTail: bridge.getStderrTail(),
      durationMs: Math.round(performance.now() - t0),
    };
    emit(stdout, stderr, format, result);
    await bridge.stop().catch(() => undefined);
    return result;
  }

  let offset = 0;
  while (offset < fixtureBytes.length) {
    const chunk = fixtureBytes.subarray(
      offset,
      Math.min(offset + PCM_CHUNK_BYTES, fixtureBytes.length),
    );
    await new Promise<void>((resolve, reject) => {
      stdin.write(chunk, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    offset += chunk.length;
    // Pace at ~10x realtime so Silero has time to process without
    // backpressure — fixture is 3s of audio; pacing puts the whole
    // run at ~300ms wall-clock plus model cold-start.
    await new Promise((r) => setTimeout(r, 25));
  }
  stdin.end();

  // 5. Wait for the bridge to drain + emit shutdown_ack on stdin EOF
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

  // 6. Wait for clean exit
  await bridge.stop({ graceMs: POST_PIPE_DRAIN_MS }).catch(() => undefined);

  // 7. Tally segments
  const speechStarts = events.filter((e) => e.type === 'speech_start').length;
  const speechEnds = events.filter((e) => e.type === 'speech_end').length;
  const segments = Math.min(speechStarts, speechEnds);

  const ok = segments >= EXPECTED_MIN_SEGMENTS;
  const result: VoiceDiagnoseResult = {
    ok,
    exitCode: ok ? 0 : 1,
    ...(ok ? {} : { reason: 'no-speech-detected' as const }),
    speechSegments: segments,
    events,
    stderrTail: bridge.getStderrTail(),
    durationMs: Math.round(performance.now() - t0),
  };
  emit(stdout, stderr, format, result);
  return result;
}

function emit(
  stdout: NodeJS.WritableStream,
  stderr: NodeJS.WritableStream,
  format: 'human' | 'json',
  result: VoiceDiagnoseResult,
  pythonPath?: string,
): void {
  if (format === 'json') {
    stdout.write(JSON.stringify(result) + '\n');
    return;
  }
  if (result.ok) {
    stdout.write(
      `[symphony] voice diagnose: PASS — ${result.speechSegments} speech segment(s) in ${result.durationMs}ms.\n`,
    );
  } else {
    stdout.write(
      `[symphony] voice diagnose: FAIL — reason=${result.reason ?? 'unknown'}, segments=${result.speechSegments}, duration=${result.durationMs}ms.\n`,
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
