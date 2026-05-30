/**
 * Phase 6D.1 — `symphony voice capture` runner unit tests.
 *
 * Drives `runVoiceCapture` with the fake-bridge `stt-capture-multi`
 * scenario (no Python, no mic, no model) against an injected in-memory
 * transcript store. The real end-to-end pipeline (real venv + real
 * sqlite) is exercised in `tests/integration/6d-capture` (skip-graceful
 * when the venv is absent).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, copyFileSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import { PassThrough } from 'node:stream';

import { runVoiceCapture } from '../../src/cli/voice-capture.js';
import {
  createMemoryTranscriptStore,
  type CompactionConfig,
} from '../../src/state/transcript-store.js';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const FAKE_BRIDGE = path.join(HERE, '..', 'voice', 'fake-bridge.mjs');
// A tiny PCM payload — the fake bridge discards it and fires finals on EOF.
const DUMMY_PCM = path.join(HERE, '..', 'fixtures', 'voice', 'silence-2s.pcm');

const fakeDirs: string[] = [];
function makeFakePackage(scenario: string): { dir: string; scriptPath: string } {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'voice-capture-pkg-'));
  fakeDirs.push(dir);
  const scriptPath = path.join(dir, 'fake-bridge.mjs');
  copyFileSync(FAKE_BRIDGE, scriptPath);
  writeFileSync(path.join(dir, '.scenario'), scenario, 'utf8');
  return { dir, scriptPath };
}

afterEach(() => {
  for (const d of fakeDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

function collectStdout(): { stream: PassThrough; text: () => string } {
  const stream = new PassThrough();
  const chunks: Buffer[] = [];
  stream.on('data', (c) => chunks.push(Buffer.from(c)));
  return { stream, text: () => Buffer.concat(chunks).toString('utf8') };
}

function bigConfig(overrides: Partial<CompactionConfig> = {}): CompactionConfig {
  return {
    rawRetentionMs: 1_000_000_000, // nothing ages during the session
    summaryRetentionMs: 1_000_000_000,
    maxChunks: 100_000,
    windowMs: 15 * 60 * 1000,
    summaryMaxChars: 500,
    ...overrides,
  };
}

describe('runVoiceCapture — store wiring', () => {
  it('stores non-empty finals and skips whitespace-only finals', async () => {
    const pkg = makeFakePackage('stt-capture-multi');
    const store = createMemoryTranscriptStore();
    const { stream: stdout, text } = collectStdout();
    const { stream: stderr } = collectStdout();
    const result = await runVoiceCapture({
      stdout,
      stderr,
      inputMode: 'stdin-pcm',
      fixturePath: DUMMY_PCM,
      pythonPath: process.execPath,
      pythonPackageDir: pkg.dir,
      scriptPath: pkg.scriptPath,
      store,
      compactionConfig: bigConfig(),
      now: () => 1_700_000_000_000,
      sessionId: 'sess-A',
      format: 'human',
    });
    expect(result.ok).toBe(true);
    // 4 finals emitted, 1 is whitespace-only → 3 stored.
    expect(result.chunksStored).toBe(3);
    const rows = store.list({ sessionId: 'sess-A', order: 'asc' });
    expect(rows.map((r) => r.text)).toEqual([
      'refactor the auth module',
      'and update the login flow',
      'then run the tests',
    ]);
    expect(rows.every((r) => r.source === 'vad' && r.kind === 'raw')).toBe(true);
    expect(text()).toMatch(/\[capture\] refactor the auth module/);
  });

  it('emits one JSON line per stored chunk in --json mode', async () => {
    const pkg = makeFakePackage('stt-capture-multi');
    const store = createMemoryTranscriptStore();
    const { stream: stdout, text } = collectStdout();
    const { stream: stderr } = collectStdout();
    await runVoiceCapture({
      stdout,
      stderr,
      inputMode: 'stdin-pcm',
      fixturePath: DUMMY_PCM,
      pythonPath: process.execPath,
      pythonPackageDir: pkg.dir,
      scriptPath: pkg.scriptPath,
      store,
      compactionConfig: bigConfig(),
      format: 'json',
    });
    const lines = text().split('\n').filter((l) => l.length > 0).map((l) => JSON.parse(l));
    expect(lines.find((p) => p.type === 'capture_ready')).toBeDefined();
    expect(lines.filter((p) => p.type === 'stored')).toHaveLength(3);
  });

  it('runs a final compaction that rolls aged chunks into a summary', async () => {
    const pkg = makeFakePackage('stt-capture-multi');
    const store = createMemoryTranscriptStore();
    const { stream: stdout } = collectStdout();
    const { stream: stderr } = collectStdout();
    // Appends happen at `now`; compaction uses the same `now`, but
    // rawRetentionMs=0 means cutoff == now and `ts < now` is false, so
    // nothing ages. To force the rollup we use a NEGATIVE retention so the
    // cutoff is just past `now` and the just-stored chunks qualify.
    const result = await runVoiceCapture({
      stdout,
      stderr,
      inputMode: 'stdin-pcm',
      fixturePath: DUMMY_PCM,
      pythonPath: process.execPath,
      pythonPackageDir: pkg.dir,
      scriptPath: pkg.scriptPath,
      store,
      compactionConfig: bigConfig({ rawRetentionMs: -1 }),
      now: () => 1_700_000_000_000,
      sessionId: 'sess-B',
      format: 'human',
    });
    expect(result.ok).toBe(true);
    expect(result.summariesCreated).toBe(1);
    expect(store.list({ kinds: ['raw'] })).toHaveLength(0);
    const summaries = store.list({ kinds: ['summary'] });
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.text).toBe(
      'refactor the auth module and update the login flow then run the tests',
    );
  });

  it('maxEvents auto-exits after N stored chunks', async () => {
    const pkg = makeFakePackage('stt-capture-multi');
    const store = createMemoryTranscriptStore();
    const { stream: stdout } = collectStdout();
    const { stream: stderr } = collectStdout();
    const result = await runVoiceCapture({
      stdout,
      stderr,
      inputMode: 'stdin-pcm',
      fixturePath: DUMMY_PCM,
      pythonPath: process.execPath,
      pythonPackageDir: pkg.dir,
      scriptPath: pkg.scriptPath,
      store,
      compactionConfig: bigConfig(),
      maxEvents: 1,
    });
    expect(result.ok).toBe(true);
    expect(result.chunksStored).toBe(1);
  });
});

describe('runVoiceCapture — failure modes', () => {
  it('reports fixture-missing when stdin-pcm has no fixture path', async () => {
    const store = createMemoryTranscriptStore();
    const { stream: stdout, text } = collectStdout();
    const { stream: stderr } = collectStdout();
    const result = await runVoiceCapture({
      stdout,
      stderr,
      inputMode: 'stdin-pcm',
      pythonPath: process.execPath,
      store,
      compactionConfig: bigConfig(),
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('fixture-missing');
    expect(text()).toMatch(/voice capture: FAIL.*fixture-missing/);
  });

  it('reports bridge-spawn-failed on an ENOENT python', async () => {
    const pkg = makeFakePackage('stt-capture-multi');
    const store = createMemoryTranscriptStore();
    const { stream: stdout } = collectStdout();
    const { stream: stderr } = collectStdout();
    const result = await runVoiceCapture({
      stdout,
      stderr,
      inputMode: 'stdin-pcm',
      fixturePath: DUMMY_PCM,
      pythonPath: '/this/binary/definitely/does/not/exist',
      pythonPackageDir: pkg.dir,
      scriptPath: pkg.scriptPath,
      store,
      compactionConfig: bigConfig(),
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('bridge-spawn-failed');
  });
});
