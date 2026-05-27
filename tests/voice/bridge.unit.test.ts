/**
 * Phase 6A — VoiceBridge unit tests.
 *
 * Uses a fake JS bridge (`tests/voice/fake-bridge.mjs`) instead of the
 * real Python voice_bridge so these tests run without a Python install.
 * The real Python pipeline is exercised in `tests/integration/6a-*`.
 *
 * We point VoiceBridge at the Node executable as the "Python" path,
 * with the fake bridge script as the package dir. The wire protocol is
 * identical (newline-delimited JSON in both directions).
 */
import path from 'node:path';
import url from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { VoiceBridge, VoiceBridgeError } from '../../src/voice/bridge.js';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const FAKE_BRIDGE = path.join(HERE, 'fake-bridge.mjs');

import { mkdtempSync, copyFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';

const fakeDirs: string[] = [];
function makeFakePackage(scenario: string): {
  readonly dir: string;
  readonly scriptPath: string;
} {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'voice-fake-pkg-'));
  fakeDirs.push(dir);
  // Copy fake bridge keeping the .mjs extension so Node treats it as
  // ESM (.py rejected by Node's ESM loader, even with package.json).
  // VoiceBridge gets the explicit scriptPath override below.
  const scriptPath = path.join(dir, 'fake-bridge.mjs');
  copyFileSync(FAKE_BRIDGE, scriptPath);
  // Scenario sidecar — fake-bridge.mjs reads it on startup. Out-of-band
  // channel because VoiceBridge's argv shape is fixed and its env
  // allowlist drops SYMPHONY_FAKE_* by design.
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

// We need the fake to consume `--scenario` from EITHER its own argv
// path (it expects --scenario) OR from env. Patch via env.
// fake-bridge.mjs reads --scenario from argv; let's update it to fall
// back to SYMPHONY_FAKE_SCENARIO env. We can do that here by writing
// a wrapper that re-reads env.

// Simplest path: pass scenario via env (fake bridge reads it).
// Update the fake-bridge.mjs is a separate file. We DON'T want a circular
// edit — let's add an env fallback to the fake-bridge later.

async function spawnBridge(
  scenario: string,
  opts: { inputMode?: 'mic' | 'stdin-pcm' } = {},
): Promise<VoiceBridge> {
  const pkg = makeFakePackage(scenario);
  const bridge = new VoiceBridge();
  await bridge.start({
    inputMode: opts.inputMode ?? 'stdin-pcm',
    pythonPath: process.execPath,
    pythonPackageDir: pkg.dir,
    scriptPath: pkg.scriptPath,
    venvDir: '/tmp/fake-voice-env',
    sourceEnv: { ...process.env },
    onStderr: () => {},
  });
  return bridge;
}

describe('VoiceBridge — happy path', () => {
  it('starts, emits ready, status flips to ready', async () => {
    const bridge = await spawnBridge('ready-then-idle');
    expect(bridge.isReady).toBe(true);
    expect(bridge.getStatus().kind).toBe('ready');
    await bridge.stop();
  });

  it('emits multiple speech_start / speech_end events in order', async () => {
    const bridge = await spawnBridge('ready-then-segments');
    const starts: number[] = [];
    const ends: { t: number; d: number }[] = [];
    bridge.on('speech_start', (e) => starts.push(e.tMs));
    bridge.on('speech_end', (e) => ends.push({ t: e.tMs, d: e.durationMs }));
    // Wait for the second speech_end (the fake schedules them within 20ms)
    await bridge.waitForEvent('speech_end', 2_000);
    // Give the second one a chance to land
    await new Promise((r) => setTimeout(r, 50));
    expect(starts.length).toBeGreaterThanOrEqual(2);
    expect(ends.length).toBeGreaterThanOrEqual(2);
    expect(ends[0]!.d).toBe(1000);
    await bridge.stop();
  });
});

describe('VoiceBridge — shutdown', () => {
  it('graceful: shutdown command -> ack -> exit 0', async () => {
    const bridge = await spawnBridge('ready-then-idle', { inputMode: 'mic' });
    const exitPromise = new Promise<{ exitCode: number | null }>((resolve) => {
      bridge.on('exit', resolve);
    });
    await bridge.stop({ graceMs: 1_500 });
    const exit = await exitPromise;
    expect(exit.exitCode).toBe(0);
    expect(bridge.getStatus().kind).toBe('stopped');
  });

  it('no-ack: falls through to force-stop', async () => {
    const bridge = await spawnBridge('no-ack', { inputMode: 'mic' });
    const exitPromise = new Promise<{ signal: NodeJS.Signals | null; exitCode: number | null }>(
      (resolve) => bridge.on('exit', resolve),
    );
    await bridge.stop({ graceMs: 200 });
    const exit = await exitPromise;
    // POSIX SIGTERM gives non-zero; Win32 taskkill /T /F also gives non-zero
    // either way: not a clean code-0 shutdown.
    const cleanExit = exit.exitCode === 0 && exit.signal === null;
    expect(cleanExit).toBe(false);
  });
});

describe('VoiceBridge — failure modes', () => {
  it('rejects start when child exits before ready', async () => {
    const bridge = new VoiceBridge();
    const pkg = makeFakePackage('immediate-exit');
    await expect(
      bridge.start({
        inputMode: 'stdin-pcm',
        pythonPath: process.execPath,
        pythonPackageDir: pkg.dir,
        scriptPath: pkg.scriptPath,
        venvDir: '/tmp/fake',
        sourceEnv: { ...process.env },
        onStderr: () => {},
      }),
    ).rejects.toBeInstanceOf(VoiceBridgeError);
  });

  it('rejects when ready never arrives (timeout path)', async () => {
    const bridge = new VoiceBridge();
    const pkg = makeFakePackage('no-ready');
    const started = bridge.start({
      inputMode: 'mic',
      pythonPath: process.execPath,
      pythonPackageDir: pkg.dir,
      scriptPath: pkg.scriptPath,
      venvDir: '/tmp/fake',
      sourceEnv: { ...process.env },
      onStderr: () => {},
    });
    // Don't wait the full 30s — kill it via stop()
    await new Promise((r) => setTimeout(r, 50));
    await bridge.stop({ graceMs: 100 });
    await expect(started).rejects.toBeInstanceOf(VoiceBridgeError);
  });

  it('rejects on bad pythonPath (ENOENT)', async () => {
    const bridge = new VoiceBridge();
    const pkg = makeFakePackage('ready-then-idle');
    await expect(
      bridge.start({
        inputMode: 'stdin-pcm',
        pythonPath: '/this/binary/definitely/does/not/exist',
        pythonPackageDir: pkg.dir,
        scriptPath: pkg.scriptPath,
        venvDir: '/tmp/fake',
        sourceEnv: { ...process.env },
        onStderr: () => {},
      }),
    ).rejects.toBeInstanceOf(VoiceBridgeError);
  });
});

describe('VoiceBridge — malformed input', () => {
  it('survives non-JSON lines on stdout via synthetic error event', async () => {
    const errors: Array<{ code: string }> = [];
    const bridge = new VoiceBridge();
    bridge.on('error', (e) => errors.push({ code: e.code }));
    const pkg = makeFakePackage('bad-json');
    await bridge.start({
      inputMode: 'stdin-pcm',
      pythonPath: process.execPath,
      pythonPackageDir: pkg.dir,
      scriptPath: pkg.scriptPath,
      venvDir: '/tmp/fake',
      sourceEnv: { ...process.env },
      onStderr: () => {},
    });
    expect(bridge.isReady).toBe(true);
    expect(errors.some((e) => e.code === 'malformed-json')).toBe(true);
    await bridge.stop();
  });

  it('rejects unknown event types with synthetic error event', async () => {
    const errors: Array<{ code: string }> = [];
    const bridge = new VoiceBridge();
    bridge.on('error', (e) => errors.push({ code: e.code }));
    const pkg = makeFakePackage('unknown-event');
    await bridge.start({
      inputMode: 'stdin-pcm',
      pythonPath: process.execPath,
      pythonPackageDir: pkg.dir,
      scriptPath: pkg.scriptPath,
      venvDir: '/tmp/fake',
      sourceEnv: { ...process.env },
      onStderr: () => {},
    });
    expect(bridge.isReady).toBe(true);
    expect(errors.some((e) => e.code === 'malformed-event')).toBe(true);
    await bridge.stop();
  });
});

describe('VoiceBridge — stderr capture', () => {
  it('captures stderr tail bytes for diagnostic surface', async () => {
    const bridge = await spawnBridge('ready-then-idle');
    // The fake writes "fake-bridge: scenario=ready-then-idle" to stderr
    // before any event. Give the readline a tick to flush.
    await new Promise((r) => setTimeout(r, 30));
    const tail = bridge.getStderrTail();
    expect(tail).toMatch(/fake-bridge/);
    await bridge.stop();
  });
});

describe('VoiceBridge — start guard', () => {
  it('throws when start() is called twice without stop()', async () => {
    const bridge = await spawnBridge('ready-then-idle');
    const pkg = makeFakePackage('ready-then-idle');
    await expect(
      bridge.start({
        inputMode: 'stdin-pcm',
        pythonPath: process.execPath,
        pythonPackageDir: pkg.dir,
        scriptPath: pkg.scriptPath,
        venvDir: '/tmp',
        sourceEnv: { ...process.env },
      }),
    ).rejects.toBeInstanceOf(VoiceBridgeError);
    await bridge.stop();
  });
});
