/**
 * Phase 6D.1 integration — real Python bridge + real Moonshine STT +
 * real SQLite buffer. Drives `runVoiceCapture` in stdin-pcm mode against
 * the committed diagnose fixture and asserts transcribed finals land in
 * the rolling context buffer, retrievable via `getContext`.
 *
 * Skip-gracefully when the voice venv / Moonshine isn't installed (run
 * `symphony voice install` first — ~120MB Moonshine weights on first run).
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import url from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { runVoiceCapture } from '../../src/cli/voice-capture.js';
import { resolveVoiceEnv } from '../../src/voice/env.js';
import { SymphonyDatabase } from '../../src/state/db.js';
import { SqliteTranscriptStore } from '../../src/state/sqlite-transcript-store.js';
import {
  DEFAULT_COMPACTION_WINDOW_MS,
  type CompactionConfig,
} from '../../src/state/transcript-store.js';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const FIXTURE_DIAGNOSE = path.join(REPO_ROOT, 'tests', 'fixtures', 'voice', 'diagnose-3s.pcm');

function probeMoonshineVenv(): { available: boolean; reason?: string } {
  const summary = resolveVoiceEnv();
  if (!summary.exists) return { available: false, reason: `python not at ${summary.pythonPath}` };
  const moonshine = spawnSync(
    summary.pythonPath,
    ['-c', 'from moonshine_onnx import transcribe'],
    { encoding: 'utf8' },
  );
  if (moonshine.status !== 0) {
    return { available: false, reason: 'moonshine_onnx not importable (run `symphony voice install`)' };
  }
  return { available: true };
}

const probe = probeMoonshineVenv();
const describeOrSkip = probe.available ? describe : describe.skip;
if (!probe.available) {
  console.warn(`[6d-integration] skipping: ${probe.reason}.`);
}

const bigConfig: CompactionConfig = {
  rawRetentionMs: 1_000_000_000,
  summaryRetentionMs: 1_000_000_000,
  maxChunks: 100_000,
  windowMs: DEFAULT_COMPACTION_WINDOW_MS,
  summaryMaxChars: 500,
};

const dbs: SymphonyDatabase[] = [];
afterEach(() => {
  for (const d of dbs.splice(0)) {
    try {
      d.close();
    } catch {
      // ignore
    }
  }
});

describeOrSkip('Phase 6D.1 — voice capture persists transcripts to the buffer', () => {
  it(
    'stores ≥1 transcribed final and getContext returns it',
    async () => {
      const db = SymphonyDatabase.open({ filePath: ':memory:' });
      dbs.push(db);
      const store = new SqliteTranscriptStore(db.db);
      const stdout: NodeJS.WritableStream = { write: () => true } as never;
      const stderr: NodeJS.WritableStream = { write: () => true } as never;

      const result = await runVoiceCapture({
        stdout,
        stderr,
        inputMode: 'stdin-pcm',
        fixturePath: FIXTURE_DIAGNOSE,
        store,
        compactionConfig: bigConfig,
        sessionId: 'integ-session',
        format: 'json',
      });

      expect(result.ok).toBe(true);
      expect(result.exitCode).toBe(0);
      // The diagnose fixture is real speech → Moonshine should yield ≥1 final.
      expect(result.chunksStored).toBeGreaterThanOrEqual(1);

      const rows = store.list({ sessionId: 'integ-session', kinds: ['raw'] });
      expect(rows.length).toBe(result.chunksStored);
      expect(rows.every((r) => r.text.trim().length > 0)).toBe(true);

      const ctx = store.getContext({ sessionId: 'integ-session', maxChars: 4000 });
      expect(ctx.text.length).toBeGreaterThan(0);
      expect(ctx.rawCount).toBeGreaterThanOrEqual(1);
    },
    180_000,
  );
});
