/**
 * Phase 6C production scenario — `symphony voice diagnose --wake-word`
 * drives the real Python voice bridge + real openWakeWord against the
 * committed wake-symphony PCM fixture end-to-end. Same `runVoiceDiagnose`
 * entry point the CLI uses, so regressions in the CLI, bridge subprocess,
 * openWakeWord wiring, OR the fixture all surface here.
 *
 * Skip-gracefully when:
 *   - `~/.symphony/voice-env/` doesn't exist
 *   - openwakeword isn't importable in the venv (run `symphony voice install`)
 *   - `assets/wake-models/hey-symphony.onnx` is absent (training hasn't
 *     produced the model yet; see scripts/train-wake-word/README.md)
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import url from 'node:url';

import { describe, expect, it } from 'vitest';

import { runVoiceDiagnose } from '../../src/cli/voice-diagnose.js';
import { resolveVoiceEnv } from '../../src/voice/env.js';
import { voiceWakeModelPath, VoiceWakeModelNotFoundError } from '../../src/voice/path.js';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const FIXTURE_PATH = path.join(
  REPO_ROOT,
  'tests',
  'fixtures',
  'voice',
  'wake-symphony-3s.pcm',
);

interface VenvProbe {
  readonly available: boolean;
  readonly reason?: string;
}

function probeVenv(): VenvProbe {
  const summary = resolveVoiceEnv();
  if (!summary.exists) return { available: false, reason: 'venv missing' };
  const oww = spawnSync(
    summary.pythonPath,
    ['-c', 'from openwakeword.model import Model'],
    { encoding: 'utf8' },
  );
  if (oww.status !== 0) {
    return {
      available: false,
      reason: `openwakeword not importable (${oww.stderr.slice(0, 200)})`,
    };
  }
  try {
    voiceWakeModelPath('hey-symphony');
  } catch (cause) {
    if (cause instanceof VoiceWakeModelNotFoundError) {
      return {
        available: false,
        reason: 'hey-symphony.onnx not built; see scripts/train-wake-word/README.md',
      };
    }
    throw cause;
  }
  if (!existsSync(FIXTURE_PATH)) {
    return { available: false, reason: `fixture missing: ${FIXTURE_PATH}` };
  }
  return { available: true };
}

const probe = probeVenv();
const describeOrSkip = probe.available ? describe : describe.skip;

if (!probe.available) {
  console.warn(
    `[scenario 6c] skipping: ${probe.reason}. Run \`symphony voice install\` + ` +
      'produce the trained model under assets/wake-models/ first.',
  );
}

describeOrSkip('Phase 6C scenario — `symphony voice diagnose --wake-word` PASSes', () => {
  it(
    'fires ≥1 wake_word event on the wake-symphony fixture',
    async () => {
      const stdout: NodeJS.WritableStream = { write: () => true } as never;
      const stderr: NodeJS.WritableStream = { write: () => true } as never;

      const result = await runVoiceDiagnose({
        stdout,
        stderr,
        format: 'json',
        wakeWord: true,
        // Slightly relaxed threshold for the synthetic-TTS fixture.
        // The real-mic threshold per voice.* config can stay at 0.5.
        wakeWordThreshold: 0.4,
      });

      expect(result.ok).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.reason).toBeUndefined();
      expect(result.wakeMode).toBe(true);
      expect(result.wakeDetected).toBe(true);
      expect(result.wakeEvents).toBeGreaterThanOrEqual(1);

      // No errors of class 'wake-*' fired
      const wakeErrors = result.events.filter(
        (e) => e.type === 'error' && e.code.startsWith('wake-'),
      );
      expect(wakeErrors).toEqual([]);

      // Budget: openWakeWord cold-start (~5-15s) + ~7s of paced fixture
      // + drain. Cap loose because warmup variance is wide.
      expect(result.durationMs).toBeLessThan(60_000);
    },
    180_000,
  );
});
