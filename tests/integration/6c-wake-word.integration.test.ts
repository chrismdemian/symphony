/**
 * Phase 6C integration — real Python bridge + real openWakeWord against a
 * known PCM fixture. Asserts the wire-protocol contract:
 *   ready -> (≥1 wake_word event with score >= threshold + matching model name)
 *
 * Skip-gracefully when ANY of:
 *   - voice venv missing (run `symphony voice install`)
 *   - openwakeword not installed in the venv (6A-only venv)
 *   - assets/wake-models/hey-symphony.onnx absent (training hasn't run;
 *     see scripts/train-wake-word/README.md)
 *
 * NOTE: the wake-symphony-3s.pcm fixture is TTS-generated and synthetic.
 * Whether the bundled model fires reliably on it depends on how well the
 * model generalizes to pyttsx3-style voices. If this test passes
 * deterministically, the model has decent generalization. If it skips at
 * "no-wake-detected" despite a trained model, hardware-side validation
 * via `symphony voice listen` is the next step.
 */
import { promises as fsp } from 'node:fs';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import url from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { VoiceBridge } from '../../src/voice/bridge.js';
import { resolveVoiceEnv } from '../../src/voice/env.js';
import { voiceWakeModelPath, VoiceWakeModelNotFoundError } from '../../src/voice/path.js';
import type { VoiceBridgeEvent } from '../../src/voice/types.js';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const FIXTURE_WAKE = path.join(
  REPO_ROOT,
  'tests',
  'fixtures',
  'voice',
  'wake-symphony-3s.pcm',
);
const PCM_CHUNK_BYTES = 512 * 2 * 30; // 30 frames per chunk

interface VenvProbe {
  readonly available: boolean;
  readonly reason?: string;
  readonly pythonPath?: string;
  readonly modelPath?: string;
}

function probeWakeWordVenv(): VenvProbe {
  const summary = resolveVoiceEnv();
  if (!summary.exists) {
    return { available: false, reason: `python not at ${summary.pythonPath}` };
  }
  const silero = spawnSync(summary.pythonPath, ['-m', 'pip', 'show', 'silero-vad'], {
    encoding: 'utf8',
  });
  if (silero.status !== 0) {
    return { available: false, reason: 'silero-vad not installed in venv' };
  }
  const oww = spawnSync(
    summary.pythonPath,
    ['-c', 'from openwakeword.model import Model'],
    { encoding: 'utf8' },
  );
  if (oww.status !== 0) {
    return {
      available: false,
      reason: `openwakeword module not importable (${oww.stderr.slice(0, 200)})`,
    };
  }
  let modelPath: string;
  try {
    modelPath = voiceWakeModelPath('hey-symphony');
  } catch (cause) {
    if (cause instanceof VoiceWakeModelNotFoundError) {
      return {
        available: false,
        reason: 'hey-symphony.onnx not built yet (see scripts/train-wake-word/README.md)',
      };
    }
    return {
      available: false,
      reason: `unexpected wake-model resolve error: ${(cause as Error).message}`,
    };
  }
  if (!existsSync(FIXTURE_WAKE)) {
    return {
      available: false,
      reason: `wake-symphony-3s.pcm fixture missing at ${FIXTURE_WAKE}`,
    };
  }
  return { available: true, pythonPath: summary.pythonPath, modelPath };
}

const probe = probeWakeWordVenv();
const describeOrSkip = probe.available ? describe : describe.skip;

if (!probe.available) {
  console.warn(
    `[6c-integration] skipping: ${probe.reason}. Run \`symphony voice install\` ` +
      'and produce assets/wake-models/hey-symphony.onnx via scripts/train-wake-word/ ' +
      'to enable.',
  );
}

describeOrSkip('Phase 6C — wake-word real-bridge integration', () => {
  const bridges: VoiceBridge[] = [];

  afterEach(async () => {
    for (const b of bridges.splice(0)) {
      await b.stop({ graceMs: 2000 }).catch(() => undefined);
    }
  });

  it(
    'real openwakeword bridge fires ≥1 wake_word event on wake-symphony fixture',
    async () => {
      const events: VoiceBridgeEvent[] = [];
      const bridge = new VoiceBridge();
      bridges.push(bridge);
      bridge.on('event', (e) => events.push(e));

      await bridge.start({
        inputMode: 'stdin-pcm',
        sttEnabled: false,
        wakeWordEnabled: true,
        wakeWordModelPath: probe.modelPath,
        wakeWordModelName: 'hey-symphony',
        // Use a slightly relaxed threshold so synthetic-TTS fixtures
        // have a fighting chance. Real-mic threshold per voice.* config
        // can stay at 0.5.
        wakeWordThreshold: 0.4,
        wakeWordSustainFrames: 2, // shorter sustain on the test fixture
        onStderr: () => {},
      });

      const fixture = await fsp.readFile(FIXTURE_WAKE);
      const stdin = bridge.childStdin;
      expect(stdin).toBeDefined();
      let offset = 0;
      while (offset < fixture.length) {
        const chunk = fixture.subarray(
          offset,
          Math.min(offset + PCM_CHUNK_BYTES, fixture.length),
        );
        await new Promise<void>((resolve, reject) => {
          stdin!.write(chunk, (err) => (err ? reject(err) : resolve()));
        });
        offset += chunk.length;
        // Pace at ~10x realtime so openWakeWord has time to predict
        // without backpressure-eating frames.
        await new Promise((r) => setTimeout(r, 25));
      }
      stdin!.end();

      // Wait for drain
      await new Promise((r) => setTimeout(r, 1500));
      await bridge.stop({ graceMs: 2000 }).catch(() => undefined);

      const wakeEvents = events.filter((e) => e.type === 'wake_word');
      expect(wakeEvents.length).toBeGreaterThanOrEqual(1);
      expect(wakeEvents[0]!.model).toBe('hey-symphony');
      expect(wakeEvents[0]!.score).toBeGreaterThanOrEqual(0.4);
      expect(wakeEvents[0]!.tMs).toBeGreaterThan(0);
    },
    60_000, // openWakeWord cold-start + ONNX session warmup can take 5-15s
  );

  it('emits ready BEFORE any wake_word event', async () => {
    const seenOrder: string[] = [];
    const bridge = new VoiceBridge();
    bridges.push(bridge);
    bridge.on('event', (e) => {
      if (e.type === 'ready' || e.type === 'wake_word') {
        seenOrder.push(e.type);
      }
    });

    await bridge.start({
      inputMode: 'stdin-pcm',
      sttEnabled: false,
      wakeWordEnabled: true,
      wakeWordModelPath: probe.modelPath,
      wakeWordThreshold: 0.4,
      wakeWordSustainFrames: 2,
      onStderr: () => {},
    });

    const fixture = await fsp.readFile(FIXTURE_WAKE);
    const stdin = bridge.childStdin;
    let offset = 0;
    while (offset < fixture.length) {
      const chunk = fixture.subarray(offset, Math.min(offset + PCM_CHUNK_BYTES, fixture.length));
      await new Promise<void>((resolve, reject) => {
        stdin!.write(chunk, (err) => (err ? reject(err) : resolve()));
      });
      offset += chunk.length;
      await new Promise((r) => setTimeout(r, 25));
    }
    stdin!.end();
    await new Promise((r) => setTimeout(r, 1500));
    await bridge.stop({ graceMs: 2000 }).catch(() => undefined);

    // The contract: ready always precedes wake_word.
    expect(seenOrder[0]).toBe('ready');
    if (seenOrder.length > 1) {
      expect(seenOrder.slice(1).every((t) => t === 'wake_word')).toBe(true);
    }
  }, 60_000);
});
