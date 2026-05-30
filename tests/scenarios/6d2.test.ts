/**
 * Phase 6D.2 production scenario — the local-LLM summarizer flows through
 * the real capture → compaction → buffer pipeline, CI-safe (fake bridge +
 * fake summarizer subprocess, no Python/model):
 *
 *   capture session (fake bridge emits finals)
 *     -> SqliteTranscriptStore on a real on-disk DB
 *     -> aged compaction calls the LocalSummarizer (fake echoes "LLM:<...>")
 *     -> the summary row carries the model's output, not the heuristic join.
 *
 * Proves the 6D.2 wiring end-to-end: `runVoiceCapture({ summarizer })` ->
 * `store.compact` -> `LocalSummarizer.summarize` -> persisted summary.
 */
import { mkdtempSync, copyFileSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { runVoiceCapture } from '../../src/cli/voice-capture.js';
import { LocalSummarizer } from '../../src/voice/summarizer.js';
import { SymphonyDatabase } from '../../src/state/db.js';
import { SqliteTranscriptStore } from '../../src/state/sqlite-transcript-store.js';
import {
  DEFAULT_COMPACTION_WINDOW_MS,
  type CompactionConfig,
} from '../../src/state/transcript-store.js';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const FAKE_BRIDGE = path.join(REPO_ROOT, 'tests', 'voice', 'fake-bridge.mjs');
const FAKE_SUMMARIZER = path.join(REPO_ROOT, 'tests', 'voice', 'fake-summarizer.mjs');
const DUMMY_PCM = path.join(REPO_ROOT, 'tests', 'fixtures', 'voice', 'silence-2s.pcm');

const tmp: string[] = [];
function fakePkg(file: string, sidecar: string, scenario: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), '6d2-scenario-'));
  tmp.push(dir);
  const scriptPath = path.join(dir, path.basename(file));
  copyFileSync(file, scriptPath);
  writeFileSync(path.join(dir, sidecar), scenario, 'utf8');
  return scriptPath;
}

afterEach(() => {
  for (const d of tmp.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

describe('Phase 6D.2 scenario — local-LLM summarizer through capture + compaction', () => {
  it('persists a model-produced summary on aged compaction', async () => {
    const bridgeScript = fakePkg(FAKE_BRIDGE, '.scenario', 'stt-capture-multi');
    const summarizerScript = fakePkg(FAKE_SUMMARIZER, '.summarizer-scenario', 'ready-echo');
    const dbDir = mkdtempSync(path.join(os.tmpdir(), '6d2-db-'));
    tmp.push(dbDir);
    const dbFile = path.join(dbDir, 'symphony.db');
    const noop: NodeJS.WritableStream = { write: () => true } as never;

    const local = new LocalSummarizer({
      pythonPath: process.execPath,
      scriptPath: summarizerScript,
      readyTimeoutMs: 5000,
      summarizeTimeoutMs: 4000,
    });

    // rawRetentionMs:-1 forces the just-stored finals (ts = now) to count as
    // aged on the runner's final compaction, so the rollup runs in-session.
    const config: CompactionConfig = {
      rawRetentionMs: -1,
      summaryRetentionMs: 1_000_000_000,
      maxChunks: 100_000,
      windowMs: DEFAULT_COMPACTION_WINDOW_MS,
      summaryMaxChars: 500,
    };

    try {
      const result = await runVoiceCapture({
        stdout: noop,
        stderr: noop,
        inputMode: 'stdin-pcm',
        fixturePath: DUMMY_PCM,
        pythonPath: process.execPath,
        pythonPackageDir: path.dirname(bridgeScript),
        scriptPath: bridgeScript,
        dbFilePath: dbFile,
        compactionConfig: config,
        summarizer: local.toSummarizer(),
        sessionId: 'llm-session',
        now: () => 1_700_000_000_000,
        format: 'json',
      });
      expect(result.ok).toBe(true);
      expect(result.chunksStored).toBe(3);
      expect(result.summariesCreated).toBe(1);
    } finally {
      await local.close().catch(() => undefined);
    }

    // The persisted summary carries the model's output (fake prefixes "LLM:"),
    // NOT the heuristic raw join.
    const db = SymphonyDatabase.open({ filePath: dbFile });
    try {
      const store = new SqliteTranscriptStore(db.db);
      const summaries = store.list({ sessionId: 'llm-session', kinds: ['summary'] });
      expect(summaries).toHaveLength(1);
      expect(summaries[0]!.text.startsWith('LLM:')).toBe(true);
      expect(summaries[0]!.text).toContain('refactor the auth module');
      expect(store.list({ sessionId: 'llm-session', kinds: ['raw'] })).toEqual([]);
    } finally {
      db.close();
    }
  });
});
