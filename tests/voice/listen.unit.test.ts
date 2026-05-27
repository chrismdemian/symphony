/**
 * Phase 6C — `symphony voice listen` unit tests.
 *
 * Drives `runVoiceListen` with the fake-bridge `wake-fire` scenario so
 * tests run without a real microphone OR a trained ONNX model. The real
 * end-to-end pipeline is exercised in `tests/integration/6c-wake-word`
 * (skip-graceful when the trained model is absent).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, copyFileSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import { PassThrough } from 'node:stream';

import { runVoiceListen } from '../../src/cli/voice-listen.js';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const FAKE_BRIDGE = path.join(HERE, 'fake-bridge.mjs');

const fakeDirs: string[] = [];
function makeFakePackage(scenario: string): {
  readonly dir: string;
  readonly scriptPath: string;
} {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'voice-listen-pkg-'));
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

describe('runVoiceListen — wake-word event flow', () => {
  it('forwards a wake_word event to stdout in human format', async () => {
    const pkg = makeFakePackage('wake-fire');
    const { stream: stdout, text } = collectStdout();
    const { stream: stderr } = collectStdout();
    const result = await runVoiceListen({
      stdout,
      stderr,
      pythonPath: process.execPath,
      pythonPackageDir: pkg.dir,
      scriptPath: pkg.scriptPath,
      wakeModelPathOverride: '<test>',
      bridgeOptionsOverride: {
        modelName: 'hey-symphony',
        threshold: 0.5,
        sustainFrames: 3,
        cooldownMs: 2000,
      },
      maxEvents: 1, // auto-exit after first detection
      format: 'human',
    });
    expect(result.ok).toBe(true);
    expect(result.wakeEvents).toBe(1);
    const out = text();
    // Banner + wake line
    expect(out).toMatch(/\[ready\] listening for "hey-symphony"/);
    expect(out).toMatch(/\[wake\] hey-symphony @\s+1234ms \(score 0.870\)/);
  });

  it('emits one JSON object per event in --json mode', async () => {
    const pkg = makeFakePackage('wake-fire');
    const { stream: stdout, text } = collectStdout();
    const { stream: stderr } = collectStdout();
    const result = await runVoiceListen({
      stdout,
      stderr,
      pythonPath: process.execPath,
      pythonPackageDir: pkg.dir,
      scriptPath: pkg.scriptPath,
      wakeModelPathOverride: '<test>',
      bridgeOptionsOverride: {
        modelName: 'hey-symphony',
        threshold: 0.5,
        sustainFrames: 3,
        cooldownMs: 2000,
      },
      maxEvents: 1,
      format: 'json',
    });
    expect(result.ok).toBe(true);
    const lines = text().split('\n').filter((l) => l.length > 0);
    // Banner + wake_word event
    expect(lines.length).toBeGreaterThanOrEqual(2);
    const parsed = lines.map((l) => JSON.parse(l));
    const banner = parsed.find((p) => p.type === 'listen_ready');
    const wake = parsed.find((p) => p.type === 'wake_word');
    expect(banner).toBeDefined();
    expect(banner.modelName).toBe('hey-symphony');
    expect(wake).toBeDefined();
    expect(wake.score).toBeCloseTo(0.87);
    expect(wake.tMs).toBe(1234);
  });

  it('maxEvents=N auto-exits after N detections', async () => {
    // The fake bridge emits exactly ONE wake_word; maxEvents=1 should
    // tear down the bridge after that first detection.
    const pkg = makeFakePackage('wake-fire');
    const { stream: stdout } = collectStdout();
    const { stream: stderr } = collectStdout();
    const start = Date.now();
    const result = await runVoiceListen({
      stdout,
      stderr,
      pythonPath: process.execPath,
      pythonPackageDir: pkg.dir,
      scriptPath: pkg.scriptPath,
      wakeModelPathOverride: '<test>',
      bridgeOptionsOverride: {
        modelName: 'hey-symphony',
        threshold: 0.5,
        sustainFrames: 3,
        cooldownMs: 2000,
      },
      maxEvents: 1,
    });
    const elapsed = Date.now() - start;
    expect(result.ok).toBe(true);
    expect(result.wakeEvents).toBe(1);
    // Should NOT hang waiting for more events; total time well under 5s.
    expect(elapsed).toBeLessThan(5000);
  });

  it('aborts cleanly when the AbortSignal fires', async () => {
    // The `ready-then-idle` scenario emits ready but never wake_word.
    // We abort the signal after a short delay; runVoiceListen should
    // resolve quickly with reason='aborted'.
    const pkg = makeFakePackage('ready-then-idle');
    const { stream: stdout } = collectStdout();
    const { stream: stderr } = collectStdout();
    const abortController = new AbortController();
    setTimeout(() => abortController.abort(), 100);
    const start = Date.now();
    const result = await runVoiceListen({
      stdout,
      stderr,
      pythonPath: process.execPath,
      pythonPackageDir: pkg.dir,
      scriptPath: pkg.scriptPath,
      wakeModelPathOverride: '<test>',
      bridgeOptionsOverride: {
        modelName: 'hey-symphony',
        threshold: 0.5,
        sustainFrames: 3,
        cooldownMs: 2000,
      },
      signal: abortController.signal,
    });
    const elapsed = Date.now() - start;
    expect(result.ok).toBe(true);
    expect(result.reason).toBe('aborted');
    expect(elapsed).toBeLessThan(3000);
  });
});

describe('runVoiceListen — failure modes', () => {
  it('reports wake-model-missing when no override + no bundled model', async () => {
    const pkg = makeFakePackage('wake-fire');
    const { stream: stdout, text } = collectStdout();
    const { stream: stderr } = collectStdout();
    const result = await runVoiceListen({
      stdout,
      stderr,
      pythonPath: process.execPath,
      pythonPackageDir: pkg.dir,
      scriptPath: pkg.scriptPath,
      bridgeOptionsOverride: {
        modelName: 'definitely-not-a-real-model-zxq42',
        threshold: 0.5,
        sustainFrames: 3,
        cooldownMs: 2000,
      },
      // NO wakeModelPathOverride — forces the resolver path
      format: 'human',
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('wake-model-missing');
    expect(text()).toMatch(/voice listen.*FAIL.*wake-model-missing/i);
  });

  it('reports bridge-spawn-failed on ENOENT python', async () => {
    const pkg = makeFakePackage('wake-fire');
    const { stream: stdout } = collectStdout();
    const { stream: stderr } = collectStdout();
    const result = await runVoiceListen({
      stdout,
      stderr,
      pythonPath: '/this/binary/definitely/does/not/exist',
      pythonPackageDir: pkg.dir,
      scriptPath: pkg.scriptPath,
      wakeModelPathOverride: '<test>',
      bridgeOptionsOverride: {
        modelName: 'hey-symphony',
        threshold: 0.5,
        sustainFrames: 3,
        cooldownMs: 2000,
      },
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('bridge-spawn-failed');
  });
});
