/**
 * Phase 6D.1 production scenario — the full always-capture storage
 * pipeline end-to-end, with NO microphone and NO venv (CI-safe):
 *
 *   capture session (fake bridge emits finals)
 *     → SqliteTranscriptStore on a REAL on-disk DB
 *     → reopen the DB in a fresh process-like store
 *     → getContext returns the spoken transcript
 *     → aged compaction rolls the raw chunks into ONE local summary
 *     → getContext now returns the summary, raw rows gone.
 *
 * The real `runVoiceCapture` entry point is exercised (same code the CLI
 * runs), so a regression in the runner, the store, the migration, or
 * persistence surfaces here. The local-LLM summarizer (6D.2) layers in
 * front of the heuristic without changing this contract.
 */
import { mkdtempSync, copyFileSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { runVoiceCapture } from '../../src/cli/voice-capture.js';
import { SymphonyDatabase } from '../../src/state/db.js';
import { SqliteTranscriptStore } from '../../src/state/sqlite-transcript-store.js';
import {
  DEFAULT_COMPACTION_WINDOW_MS,
  heuristicSummarizer,
  type CompactionConfig,
} from '../../src/state/transcript-store.js';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const FAKE_BRIDGE = path.join(REPO_ROOT, 'tests', 'voice', 'fake-bridge.mjs');
const DUMMY_PCM = path.join(REPO_ROOT, 'tests', 'fixtures', 'voice', 'silence-2s.pcm');

const tmpDirs: string[] = [];
function makeFakePackage(scenario: string): { dir: string; scriptPath: string } {
  const dir = mkdtempSync(path.join(os.tmpdir(), '6d-scenario-'));
  tmpDirs.push(dir);
  const scriptPath = path.join(dir, 'fake-bridge.mjs');
  copyFileSync(FAKE_BRIDGE, scriptPath);
  writeFileSync(path.join(dir, '.scenario'), scenario, 'utf8');
  return { dir, scriptPath };
}

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

const captureConfig: CompactionConfig = {
  // Nothing ages DURING the capture session (chunks are timestamped "now").
  rawRetentionMs: 1_000_000_000,
  summaryRetentionMs: 1_000_000_000,
  maxChunks: 100_000,
  windowMs: DEFAULT_COMPACTION_WINDOW_MS,
  summaryMaxChars: 500,
};

describe('Phase 6D.1 scenario — always-capture buffer end-to-end', () => {
  it('captures → persists → retrieves context → compacts to a local summary', async () => {
    const pkg = makeFakePackage('stt-capture-multi');
    const dbDir = mkdtempSync(path.join(os.tmpdir(), '6d-db-'));
    tmpDirs.push(dbDir);
    const dbFile = path.join(dbDir, 'symphony.db');
    const noopOut: NodeJS.WritableStream = { write: () => true } as never;

    // 1. Capture session — finals stored to the real on-disk DB.
    const result = await runVoiceCapture({
      stdout: noopOut,
      stderr: noopOut,
      inputMode: 'stdin-pcm',
      fixturePath: DUMMY_PCM,
      pythonPath: process.execPath,
      pythonPackageDir: pkg.dir,
      scriptPath: pkg.scriptPath,
      dbFilePath: dbFile,
      compactionConfig: captureConfig,
      sessionId: 'scenario-session',
      now: () => 1_700_000_000_000,
      format: 'json',
    });
    expect(result.ok).toBe(true);
    expect(result.chunksStored).toBe(3); // 4 finals, 1 whitespace-only skipped
    expect(result.summariesCreated).toBe(0); // nothing aged during the session

    // 2. Reopen the DB independently (proves durability across "processes").
    const db = SymphonyDatabase.open({ filePath: dbFile });
    try {
      const store = new SqliteTranscriptStore(db.db);
      const before = store.getContext({ sessionId: 'scenario-session', maxChars: 4000 });
      expect(before.rawCount).toBe(3);
      expect(before.summaryCount).toBe(0);
      expect(before.text).toContain('refactor the auth module');
      expect(before.text).toContain('then run the tests');

      // 3. Aged compaction — `now` two hours past the stored ts, retention
      //    1h → the three raw rows (one window) roll into ONE summary.
      const compRes = await store.compact(1_700_000_000_000 + 7_200_000, heuristicSummarizer, {
        ...captureConfig,
        rawRetentionMs: 3_600_000,
      });
      expect(compRes.summariesCreated).toBe(1);
      expect(compRes.rawChunksRolledUp).toBe(3);

      // 4. The buffer now holds the summary, raw rows gone.
      expect(store.list({ sessionId: 'scenario-session', kinds: ['raw'] })).toEqual([]);
      const after = store.getContext({ sessionId: 'scenario-session', maxChars: 4000 });
      expect(after.summaryCount).toBe(1);
      expect(after.rawCount).toBe(0);
      expect(after.text).toBe(
        'refactor the auth module and update the login flow then run the tests',
      );
    } finally {
      db.close();
    }
  });
});
