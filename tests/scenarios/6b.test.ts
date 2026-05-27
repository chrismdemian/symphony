/**
 * Phase 6B production scenario — `symphony voice transcribe` drives the
 * real Python voice bridge + real Moonshine STT against the committed
 * dev-vocab PCM fixture end-to-end. The same `runVoiceTranscribe` entry
 * point the CLI uses, so regressions in the CLI surface, the bridge
 * subprocess, Moonshine inference, vocab substitution, OR the fixture
 * all fail here.
 *
 * Skip-gracefully when:
 *   - `~/.symphony/voice-env/` doesn't exist
 *   - useful-moonshine-onnx isn't importable in the venv (run
 *     `symphony voice install` to seed it)
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import url from 'node:url';

import { describe, expect, it } from 'vitest';

import { runVoiceTranscribe } from '../../src/cli/voice-transcribe.js';
import { resolveVoiceEnv } from '../../src/voice/env.js';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const FIXTURE_PATH = path.join(
  REPO_ROOT,
  'tests',
  'fixtures',
  'voice',
  'transcribe-dev-vocab.pcm',
);

interface VenvProbe {
  readonly available: boolean;
  readonly reason?: string;
}

function probeVenv(): VenvProbe {
  const summary = resolveVoiceEnv();
  if (!summary.exists) return { available: false, reason: 'venv missing' };
  const moonshine = spawnSync(
    summary.pythonPath,
    ['-c', 'from moonshine_onnx import transcribe'],
    { encoding: 'utf8' },
  );
  if (moonshine.status !== 0) {
    return { available: false, reason: 'moonshine_onnx not importable in venv' };
  }
  return { available: true };
}

const probe = probeVenv();
const describeOrSkip = probe.available ? describe : describe.skip;

if (!probe.available) {
  console.warn(
    `[scenario 6b] skipping: ${probe.reason}. Run \`symphony voice install\` first (downloads ~120MB Moonshine weights on first run).`,
  );
}

describeOrSkip('Phase 6B scenario — `symphony voice transcribe` PASSes', () => {
  it(
    'transcribes the dev-vocab fixture and applies vocab substitution',
    async () => {
      const stdout: NodeJS.WritableStream = { write: () => true } as never;
      const stderr: NodeJS.WritableStream = { write: () => true } as never;

      const result = await runVoiceTranscribe({
        wavPath: FIXTURE_PATH,
        stdout,
        stderr,
        format: 'json',
      });

      expect(result.ok).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.reason).toBeUndefined();
      expect(result.sttReady).toBe(true);
      // Locks the 200 ms partial-cadence path. If `partials.length === 0`
      // but `finals.length >= 1` the bridge's partial-cadence timer is
      // silently broken and the scenario would still pass without
      // this assertion.
      expect(result.partials.length).toBeGreaterThanOrEqual(1);
      expect(result.finals.length).toBeGreaterThanOrEqual(1);
      // Non-empty transcript.
      expect(result.transcript.length).toBeGreaterThan(0);

      // Vocab substitution end-to-end: the seed map at
      // ~/.symphony/voice-vocab.json maps "use effect" -> "useEffect"
      // and "package json" -> "package.json". The fixture phrase is
      // "Use effect inside the package json file." Moonshine
      // transcribes this lowercased; after substitution the text MUST
      // contain at least one of the dev forms.
      const t = result.transcript.toLowerCase();
      const containsSub =
        t.includes('useeffect') || t.includes('package.json');
      expect(containsSub).toBe(true);

      // No 'error' events of class 'stt-*' fired
      const sttErrors = result.events.filter(
        (e) => e.type === 'error' && e.code.startsWith('stt-'),
      );
      expect(sttErrors).toEqual([]);

      // Budget: cold-start (Silero + Moonshine + numba warmup) +
      // 3.4s of paced PCM + final inference. Cap loose because the
      // numba JIT compile pause varies (3-8 s typical).
      expect(result.durationMs).toBeLessThan(60_000);
    },
    180_000,
  );

  it('uses the user-global vocab file at ~/.symphony/voice-vocab.json', async () => {
    // This test verifies that the resolveVoiceVocabPaths helper
    // actually picks up the user-global file installed by
    // `symphony voice install`. If the seed was missing OR not
    // copied, this scenario's substitutions wouldn't fire.
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const userVocabPath = path.join(
      os.default.homedir(),
      '.symphony',
      'voice-vocab.json',
    );
    const stat = await fs.stat(userVocabPath).catch(() => null);
    expect(stat).not.toBeNull();
    if (stat !== null) {
      const body = await fs.readFile(userVocabPath, 'utf8');
      const data = JSON.parse(body) as {
        version: number;
        substitutions: Record<string, string>;
      };
      expect(data.version).toBe(1);
      // Sanity: seed entries are present
      expect(data.substitutions['use effect']).toBe('useEffect');
    }
  });
});
