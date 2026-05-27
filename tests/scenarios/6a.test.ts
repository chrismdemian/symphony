/**
 * Phase 6A production scenario — `symphony voice diagnose` drives the
 * real Python voice bridge end-to-end. See `tests/scenarios/6a.md`.
 *
 * Skip-gracefully when:
 *   - `~/.symphony/voice-env/` doesn't exist (run `symphony voice install`)
 *   - silero-vad isn't installed in the venv
 *
 * Exercises the SAME `runVoiceDiagnose` entry point the CLI uses, so
 * regressions in the CLI surface, the bridge subprocess, the Python
 * Silero integration, OR the PCM fixture all fail here.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import url from 'node:url';

import { describe, expect, it } from 'vitest';

import { runVoiceDiagnose } from '../../src/cli/voice-diagnose.js';
import { resolveVoiceEnv } from '../../src/voice/env.js';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const FIXTURE_PATH = path.join(
  REPO_ROOT,
  'tests',
  'fixtures',
  'voice',
  'diagnose-3s.pcm',
);

interface VenvProbe {
  readonly available: boolean;
  readonly reason?: string;
}

function probeVenv(): VenvProbe {
  const summary = resolveVoiceEnv();
  if (!summary.exists) return { available: false, reason: 'venv missing' };
  const result = spawnSync(summary.pythonPath, ['-m', 'pip', 'show', 'silero-vad'], {
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    return { available: false, reason: 'silero-vad not installed in venv' };
  }
  return { available: true };
}

const probe = probeVenv();
const describeOrSkip = probe.available ? describe : describe.skip;

if (!probe.available) {
  console.warn(
    `[scenario 6a] skipping: ${probe.reason}. Run \`symphony voice install\` first.`,
  );
}

describeOrSkip('Phase 6A scenario — `symphony voice diagnose` PASSes', () => {
  it(
    'detects ≥1 speech segment in the committed PCM fixture and exits 0',
    async () => {
      // Suppress human/JSON output during the scenario — we read the
      // structured result directly.
      const stdout: NodeJS.WritableStream = {
        write: () => true,
      } as never;
      const stderr: NodeJS.WritableStream = {
        write: () => true,
      } as never;

      const result = await runVoiceDiagnose({
        stdout,
        stderr,
        fixturePath: FIXTURE_PATH,
        format: 'json',
      });

      expect(result.ok).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.reason).toBeUndefined();
      expect(result.speechSegments).toBeGreaterThanOrEqual(1);
      expect(result.speechSegments).toBeLessThanOrEqual(4);

      // Observable wire shape — verify ready / speech events fired
      const ready = result.events.find((e) => e.type === 'ready');
      expect(ready).toBeDefined();
      if (ready && ready.type === 'ready') {
        expect(ready.backend).toBe('stdin-pcm');
        expect(ready.sampleRate).toBe(16000);
      }
      expect(result.events.some((e) => e.type === 'speech_start')).toBe(true);
      expect(result.events.some((e) => e.type === 'speech_end')).toBe(true);

      // Budget: cold-start Silero + 3.3s of paced PCM
      expect(result.durationMs).toBeLessThan(60_000);
    },
    90_000,
  );
});
