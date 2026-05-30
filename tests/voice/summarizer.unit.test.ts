/**
 * Phase 6D.2 — LocalSummarizer unit tests.
 *
 * Drives `LocalSummarizer` against the fake-summarizer `.mjs` (no Python,
 * no model) to exercise every path WITHOUT throwing: the model path, the
 * per-request-error fallback, the fatal-load degrade, the timeout degrade,
 * a mid-session crash, and clean shutdown. The real model end-to-end is in
 * `tests/integration/6d2-summarizer` (skip-graceful when uninstalled).
 *
 * Invariant under test: `summarize()` NEVER throws and ALWAYS returns a
 * string — the LLM result when available, the deterministic heuristic
 * otherwise.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, copyFileSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';

import { LocalSummarizer } from '../../src/voice/summarizer.js';
import { heuristicSummarize } from '../../src/state/transcript-store.js';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const FAKE = path.join(HERE, 'fake-summarizer.mjs');

const dirs: string[] = [];
const live: LocalSummarizer[] = [];

function makeFake(scenario: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'fake-summarizer-'));
  dirs.push(dir);
  const scriptPath = path.join(dir, 'fake-summarizer.mjs');
  copyFileSync(FAKE, scriptPath);
  writeFileSync(path.join(dir, '.summarizer-scenario'), scenario, 'utf8');
  return scriptPath;
}

function newSummarizer(scriptPath: string, extra: Record<string, unknown> = {}): LocalSummarizer {
  const s = new LocalSummarizer({
    pythonPath: process.execPath, // run the .mjs with node
    scriptPath,
    readyTimeoutMs: 3000,
    summarizeTimeoutMs: 2000,
    ...extra,
  });
  live.push(s);
  return s;
}

afterEach(async () => {
  for (const s of live.splice(0)) await s.close().catch(() => undefined);
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

describe('LocalSummarizer', () => {
  it('returns the model summary when the subprocess is healthy', async () => {
    const s = newSummarizer(makeFake('ready-echo'));
    const out = await s.summarize(['refactor auth', 'update login']);
    expect(out).toBe('LLM:refactor auth|update login');
    expect(s.isDegraded).toBe(false);
  });

  it('falls back to the heuristic on a per-request error (subprocess stays up)', async () => {
    const s = newSummarizer(makeFake('per-request-error'));
    const texts = ['alpha', 'beta'];
    const out = await s.summarize(texts);
    expect(out).toBe(heuristicSummarize(texts));
    // Per-request errors do NOT degrade the instance.
    expect(s.isDegraded).toBe(false);
  });

  it('degrades to the heuristic when the model fails to load (fatal)', async () => {
    const s = newSummarizer(makeFake('fatal-load'));
    const texts = ['one', 'two'];
    const out = await s.summarize(texts);
    expect(out).toBe(heuristicSummarize(texts));
    expect(s.isDegraded).toBe(true);
    // Subsequent calls stay on the heuristic without respawning.
    expect(await s.summarize(['three'])).toBe(heuristicSummarize(['three']));
  });

  it('degrades on ready timeout when the subprocess never signals ready', async () => {
    const s = newSummarizer(makeFake('no-ready'), { readyTimeoutMs: 300 });
    const texts = ['x', 'y'];
    const out = await s.summarize(texts);
    expect(out).toBe(heuristicSummarize(texts));
    expect(s.isDegraded).toBe(true);
  });

  it('degrades on a per-request timeout (wedged inference)', async () => {
    const s = newSummarizer(makeFake('summarize-hang'), { summarizeTimeoutMs: 300 });
    const texts = ['hang', 'please'];
    const out = await s.summarize(texts);
    expect(out).toBe(heuristicSummarize(texts));
    expect(s.isDegraded).toBe(true);
  });

  it('falls back when the subprocess crashes mid-session', async () => {
    const s = newSummarizer(makeFake('crash-after-ready'));
    const texts = ['boom'];
    const out = await s.summarize(texts);
    expect(out).toBe(heuristicSummarize(texts));
  });

  it('degrades after a mid-session crash so the NEXT call short-circuits (audit-C1)', async () => {
    // The fake crashes on the FIRST summarize (after a clean ready). The
    // exit handler must set `degraded` so the SECOND summarize returns the
    // heuristic PROMPTLY — not after stalling the full summarizeTimeoutMs.
    const s = newSummarizer(makeFake('crash-after-ready'), { summarizeTimeoutMs: 5000 });
    await s.summarize(['first']); // triggers the crash + fallback
    expect(s.isDegraded).toBe(true);
    const start = Date.now();
    const out = await s.summarize(['second']);
    const elapsed = Date.now() - start;
    expect(out).toBe(heuristicSummarize(['second']));
    // Must NOT have waited anywhere near the 5s summarize timeout.
    expect(elapsed).toBeLessThan(1000);
  });

  it('close() after use is clean and idempotent', async () => {
    const s = newSummarizer(makeFake('ready-echo'));
    await s.summarize(['a']);
    await s.close();
    await s.close(); // idempotent
    // After close, summarize uses the heuristic.
    expect(await s.summarize(['b'])).toBe(heuristicSummarize(['b']));
  });

  it('toSummarizer() returns a bound Summarizer usable by the capture runner', async () => {
    const s = newSummarizer(makeFake('ready-echo'));
    const fn = s.toSummarizer();
    expect(await fn(['z'])).toBe('LLM:z');
  });
});
