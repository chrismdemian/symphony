/**
 * Phase 6A integration — spawn the REAL Python voice bridge with the
 * REAL Silero VAD against a known PCM fixture and assert the wire
 * protocol delivers the expected speech segmentation events.
 *
 * Skip-gracefully when:
 *   - the voice venv doesn't exist at `~/.symphony/voice-env/`
 *     (or `SYMPHONY_VOICE_ENV_DIR`)
 *   - silero-vad isn't installed in the venv
 *   - Python <3.10
 *
 * To run: `symphony voice install` first, then `pnpm vitest tests/integration/6a-bridge`.
 * CI: install voice deps as a setup step or these tests skip cleanly.
 */
import { promises as fsp } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import url from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { VoiceBridge } from '../../src/voice/bridge.js';
import { resolveVoiceEnv } from '../../src/voice/env.js';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const FIXTURE_DIAGNOSE = path.join(
  REPO_ROOT,
  'tests',
  'fixtures',
  'voice',
  'diagnose-3s.pcm',
);
const FIXTURE_SILENCE = path.join(
  REPO_ROOT,
  'tests',
  'fixtures',
  'voice',
  'silence-2s.pcm',
);
const PCM_CHUNK_BYTES = 480 * 2 * 30; // 30 frames per chunk

interface VenvProbe {
  readonly available: boolean;
  readonly reason?: string;
  readonly pythonPath?: string;
}

function probeVenv(): VenvProbe {
  const summary = resolveVoiceEnv();
  if (!summary.exists) {
    return { available: false, reason: `python not at ${summary.pythonPath}` };
  }
  // Verify silero-vad is installed
  const result = spawnSync(summary.pythonPath, ['-m', 'pip', 'show', 'silero-vad'], {
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    return { available: false, reason: 'silero-vad not installed in venv' };
  }
  return { available: true, pythonPath: summary.pythonPath };
}

const probe = probeVenv();
const describeOrSkip = probe.available ? describe : describe.skip;

if (!probe.available) {
  console.warn(
    `[6a-integration] skipping: ${probe.reason}. Run \`symphony voice install\` to enable.`,
  );
}

// Many bridges per test — ensure we tear them all down even on failure.
const liveBridges: VoiceBridge[] = [];
afterEach(async () => {
  for (const b of liveBridges.splice(0)) {
    await b.stop({ graceMs: 500 }).catch(() => undefined);
  }
});

async function pipePcmThrough(
  bridge: VoiceBridge,
  fixturePath: string,
): Promise<void> {
  const bytes = await fsp.readFile(fixturePath);
  const stdin = bridge.childStdin;
  if (stdin === undefined) throw new Error('bridge stdin unavailable');
  let offset = 0;
  while (offset < bytes.length) {
    const chunk = bytes.subarray(
      offset,
      Math.min(offset + PCM_CHUNK_BYTES, bytes.length),
    );
    await new Promise<void>((resolve, reject) => {
      stdin.write(chunk, (err) => (err ? reject(err) : resolve()));
    });
    offset += chunk.length;
    await new Promise((r) => setTimeout(r, 25));
  }
  stdin.end();
}

async function startBridgeStdinPcm(
  opts: Partial<Parameters<VoiceBridge['start']>[0]> = {},
): Promise<VoiceBridge> {
  const bridge = new VoiceBridge();
  liveBridges.push(bridge);
  await bridge.start({
    inputMode: 'stdin-pcm',
    onStderr: () => {
      // Silence stderr during tests — bridge.getStderrTail() retains
      // it for failure reporting.
    },
    ...opts,
  });
  return bridge;
}

describeOrSkip('Phase 6A — real Silero VAD via Python bridge (stdin-pcm)', () => {
  it(
    'detects at least one speech segment in the diagnose fixture',
    async () => {
      const bridge = await startBridgeStdinPcm();
      const segments: Array<{ start?: number; end?: number; durationMs?: number }> = [];
      bridge.on('speech_start', (e) => segments.push({ start: e.tMs }));
      bridge.on('speech_end', (e) => {
        // Pair with the most recent open segment (manual reverse-find
        // to keep es2022 target; findLast is es2023).
        let open: (typeof segments)[number] | undefined;
        for (let i = segments.length - 1; i >= 0; i -= 1) {
          if (segments[i]!.end === undefined) {
            open = segments[i];
            break;
          }
        }
        if (open) {
          open.end = e.tMs;
          open.durationMs = e.durationMs;
        } else {
          segments.push({ end: e.tMs, durationMs: e.durationMs });
        }
      });

      await pipePcmThrough(bridge, FIXTURE_DIAGNOSE);

      // Wait for stdin EOF to drain through Silero + emit shutdown_ack
      const ackOrExit = new Promise<void>((resolve) => {
        bridge.once('shutdown_ack', () => resolve());
        bridge.once('exit', () => resolve());
        setTimeout(() => resolve(), 5_000);
      });
      await ackOrExit;
      await bridge.stop({ graceMs: 500 }).catch(() => undefined);

      const closed = segments.filter((s) => s.start !== undefined && s.end !== undefined);
      expect(closed.length).toBeGreaterThanOrEqual(1);
      // Silero is sensitive enough that the two-burst fixture often
      // produces two segments. Don't pin the exact count — Silero
      // updates between versions could shift it by ±1.
      expect(closed.length).toBeLessThanOrEqual(4);
      // Every closed segment has positive duration
      for (const s of closed) {
        expect(s.durationMs).toBeGreaterThan(0);
      }
    },
    60_000,
  );

  it(
    'emits zero speech segments on a pure-silence fixture',
    async () => {
      const bridge = await startBridgeStdinPcm();
      let starts = 0;
      bridge.on('speech_start', () => {
        starts += 1;
      });

      await pipePcmThrough(bridge, FIXTURE_SILENCE);

      const drain = new Promise<void>((resolve) => {
        bridge.once('shutdown_ack', () => resolve());
        bridge.once('exit', () => resolve());
        setTimeout(() => resolve(), 5_000);
      });
      await drain;
      await bridge.stop({ graceMs: 500 }).catch(() => undefined);

      expect(starts).toBe(0);
    },
    60_000,
  );

  it(
    'ready event reports stdin-pcm backend and configured VAD knobs',
    async () => {
      const bridge = new VoiceBridge();
      liveBridges.push(bridge);
      const ready = await bridge.start({
        inputMode: 'stdin-pcm',
        vadThreshold: 0.6,
        vadMinSpeechMs: 150,
        vadMinSilenceMs: 500,
        onStderr: () => {},
      });
      expect(ready.backend).toBe('stdin-pcm');
      expect(ready.sampleRate).toBe(16000);
      expect(ready.vadThreshold).toBeCloseTo(0.6, 5);
      expect(ready.vadMinSpeechMs).toBe(150);
      expect(ready.vadMinSilenceMs).toBe(500);
      await bridge.stop({ graceMs: 500 });
    },
    60_000,
  );
});
