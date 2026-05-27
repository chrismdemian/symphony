import path from 'node:path';
import os from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  runVoiceInstall,
  type InstallerSpawner,
  type InstallerSpawnResult,
} from '../../src/voice/installer.js';

/** Build a spawner that returns scripted results in order, keyed by argv prefix. */
function scriptedSpawner(
  responses: Array<{
    readonly match: (cmd: string, args: readonly string[]) => boolean;
    readonly result: Partial<InstallerSpawnResult>;
  }>,
): InstallerSpawner {
  return async (req) => {
    const match = responses.find((r) => r.match(req.cmd, req.args));
    if (match === undefined) {
      throw new Error(
        `unmatched spawner call: ${req.cmd} ${req.args.join(' ')}`,
      );
    }
    return {
      stdout: '',
      stderr: '',
      exitCode: 0,
      signal: null,
      ...match.result,
    };
  };
}

const tmpDirs: string[] = [];
function makeTmp(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
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

describe('runVoiceInstall — python probe', () => {
  it('refuses when python is not found', async () => {
    const spawner = scriptedSpawner([
      {
        match: (cmd, args) => cmd === 'python3' && args[0] === '--version',
        result: { exitCode: 1, stderr: 'command not found: python3' },
      },
    ]);
    const result = await runVoiceInstall({
      venvDir: '/tmp/voice-not-used',
      platform: 'linux',
      homeDir: '/tmp/fake-home',
      spawner,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('python-not-found');
  });

  it('refuses on Python < 3.10', async () => {
    const spawner = scriptedSpawner([
      {
        match: (cmd, args) => args[0] === '--version',
        result: { stdout: 'Python 3.9.7', exitCode: 0 },
      },
    ]);
    const result = await runVoiceInstall({
      venvDir: '/tmp/voice-not-used',
      platform: 'linux',
      homeDir: '/tmp/fake-home',
      spawner,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('python-version-too-old');
  });

  it('refuses Windows Store Python install', async () => {
    const spawner = scriptedSpawner([
      {
        match: (cmd, args) => args[0] === '--version',
        result: { stdout: 'Python 3.11.5', exitCode: 0 },
      },
      {
        match: (cmd, args) =>
          args[0] === '-c' && args[1]?.includes('base_prefix') === true,
        result: {
          stdout: 'C:\\Program Files\\WindowsApps\\PythonSoftwareFoundation.Python.3.11_3.11.5_x64__qbz5n2kfra8p0',
          exitCode: 0,
        },
      },
    ]);
    const result = await runVoiceInstall({
      venvDir: 'C:\\fake\\voice-env',
      platform: 'win32',
      homeDir: 'C:\\fake-home',
      pythonOverride: 'python',
      spawner,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('python-store-install');
  });
});

describe('runVoiceInstall — happy path', () => {
  it('creates venv + installs all deps + reports OK', async () => {
    const venvDir = makeTmp('voice-installer-');
    // The installer probes existence via fs.access on the venv python.
    // We use a real tmp dir so resolveVoiceEnv-by-explicit-venvDir branch
    // sees the file. Since we override every spawner call we never
    // really write the python binary; instead, we test that the
    // sequence of spawns happens correctly + the result reflects it.

    const calls: Array<{ cmd: string; args: readonly string[] }> = [];
    const spawner: InstallerSpawner = async (req) => {
      calls.push({ cmd: req.cmd, args: req.args });
      if (req.args[0] === '--version') {
        return { stdout: 'Python 3.11.5', stderr: '', exitCode: 0, signal: null };
      }
      // probeDeps returns 0 for missing deps if we want to force install.
      // For the "fresh venv" path we want pip-show to fail initially.
      if (req.args[0] === '-m' && req.args[1] === 'pip' && req.args[2] === 'show') {
        return { stdout: '', stderr: '', exitCode: 1, signal: null };
      }
      return { stdout: 'installed', stderr: '', exitCode: 0, signal: null };
    };

    const result = await runVoiceInstall({
      venvDir,
      platform: 'linux',
      homeDir: '/tmp/fake-home',
      spawner,
      force: true, // bypass the idempotent fast-path probe
    });

    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.venvPath).toBe(venvDir);
    // Required deps must have been attempted
    const pipInstallArgs = calls
      .filter((c) => c.args[0] === '-m' && c.args[1] === 'pip' && c.args[2] === 'install')
      .map((c) => c.args[c.args.length - 1]);
    expect(pipInstallArgs).toContain('silero-vad');
    expect(pipInstallArgs).toContain('sounddevice');
    expect(pipInstallArgs).toContain('numpy');
    expect(pipInstallArgs).toContain('pyaudio');
  });

  it('reports idempotent when venv + all deps already present', async () => {
    const venvDir = makeTmp('voice-installer-');
    // Touch the python binary so pathExists sees it
    const venvPython = path.join(venvDir, 'bin', 'python');
    const fsp = await import('node:fs/promises');
    await fsp.mkdir(path.dirname(venvPython), { recursive: true });
    await fsp.writeFile(venvPython, '#!/usr/bin/env false\n');
    await fsp.chmod(venvPython, 0o755);

    let installCount = 0;
    const spawner: InstallerSpawner = async (req) => {
      if (req.args[0] === '--version') {
        return { stdout: 'Python 3.11.5', stderr: '', exitCode: 0, signal: null };
      }
      if (req.args[0] === '-m' && req.args[1] === 'pip' && req.args[2] === 'show') {
        // All packages present
        return {
          stdout: `Name: ${req.args[3]}\nVersion: 1.0`,
          stderr: '',
          exitCode: 0,
          signal: null,
        };
      }
      if (req.args[0] === '-m' && req.args[1] === 'pip' && req.args[2] === 'install') {
        installCount += 1;
      }
      return { stdout: '', stderr: '', exitCode: 0, signal: null };
    };

    const result = await runVoiceInstall({
      venvDir,
      platform: 'linux',
      homeDir: '/tmp/fake-home',
      spawner,
    });
    expect(result.ok).toBe(true);
    expect(result.idempotent).toBe(true);
    expect(result.sileroVadInstalled).toBe(true);
    expect(result.onnxRuntimeInstalled).toBe(true);
    expect(result.soundDeviceInstalled).toBe(true);
    expect(result.numpyInstalled).toBe(true);
    expect(installCount).toBe(0); // no installs in idempotent path
  });

  it('audit-m2 regression: idempotent fast-path requires ALL REQUIRED deps, not just three', async () => {
    // Pre-fix bug: probeDeps.allPresent = silero && onnxruntime && sounddevice,
    // omitting numpy. A venv with everything except numpy would short-circuit
    // through the idempotent fast-path and crash later at `import numpy`.
    // The fix made `allPresent` reduce over REQUIRED_PIP_PACKAGES dynamically.
    const venvDir = makeTmp('voice-installer-');
    const venvPython = path.join(venvDir, 'bin', 'python');
    const fsp = await import('node:fs/promises');
    await fsp.mkdir(path.dirname(venvPython), { recursive: true });
    await fsp.writeFile(venvPython, '#!/usr/bin/env false\n');
    await fsp.chmod(venvPython, 0o755);

    let installCount = 0;
    const spawner: InstallerSpawner = async (req) => {
      if (req.args[0] === '--version') {
        return { stdout: 'Python 3.11.5', stderr: '', exitCode: 0, signal: null };
      }
      if (req.args[0] === '-m' && req.args[1] === 'pip' && req.args[2] === 'show') {
        // numpy missing; all others present
        const pkg = req.args[3];
        if (pkg === 'numpy') {
          return { stdout: '', stderr: '', exitCode: 1, signal: null };
        }
        return {
          stdout: `Name: ${pkg}\nVersion: 1.0`,
          stderr: '',
          exitCode: 0,
          signal: null,
        };
      }
      if (req.args[0] === '-m' && req.args[1] === 'pip' && req.args[2] === 'install') {
        installCount += 1;
      }
      return { stdout: '', stderr: '', exitCode: 0, signal: null };
    };

    const result = await runVoiceInstall({
      venvDir,
      platform: 'linux',
      homeDir: '/tmp/fake-home',
      spawner,
    });
    // Must NOT be idempotent — numpy missing forces full install
    expect(result.idempotent).toBe(false);
    expect(result.ok).toBe(true);
    // numpy install was attempted
    expect(installCount).toBeGreaterThan(0);
  });
});

describe('runVoiceInstall — partial failures', () => {
  it('non-fatal: pyaudio fails on Win32 (best-effort)', async () => {
    const venvDir = makeTmp('voice-installer-');
    const spawner: InstallerSpawner = async (req) => {
      if (req.args[0] === '--version') {
        return { stdout: 'Python 3.11.5', stderr: '', exitCode: 0, signal: null };
      }
      if (req.args[0] === '-c' && req.args[1]?.includes('base_prefix')) {
        return { stdout: 'C:\\Python311', stderr: '', exitCode: 0, signal: null };
      }
      if (req.args[0] === '-m' && req.args[1] === 'pip' && req.args[2] === 'show') {
        return { stdout: '', stderr: '', exitCode: 1, signal: null };
      }
      // pyaudio install fails; everything else succeeds
      if (
        req.args[0] === '-m' &&
        req.args[1] === 'pip' &&
        req.args[2] === 'install' &&
        req.args[req.args.length - 1] === 'pyaudio'
      ) {
        return {
          stdout: '',
          stderr: "ERROR: Microsoft Visual C++ 14.0 or greater is required",
          exitCode: 1,
          signal: null,
        };
      }
      return { stdout: '', stderr: '', exitCode: 0, signal: null };
    };

    const result = await runVoiceInstall({
      venvDir,
      platform: 'win32',
      homeDir: 'C:\\fake-home',
      pythonOverride: 'python',
      spawner,
      force: true,
    });
    expect(result.ok).toBe(true);
    expect(result.warnings.some((w) => w.includes('pyaudio'))).toBe(true);
  });

  it('fatal: silero install fails -> overall fail', async () => {
    const venvDir = makeTmp('voice-installer-');
    const spawner: InstallerSpawner = async (req) => {
      if (req.args[0] === '--version') {
        return { stdout: 'Python 3.11.5', stderr: '', exitCode: 0, signal: null };
      }
      if (req.args[0] === '-m' && req.args[1] === 'pip' && req.args[2] === 'show') {
        return { stdout: '', stderr: '', exitCode: 1, signal: null };
      }
      if (
        req.args[0] === '-m' &&
        req.args[1] === 'pip' &&
        req.args[2] === 'install' &&
        req.args[req.args.length - 1] === 'silero-vad'
      ) {
        return {
          stdout: '',
          stderr: 'ERROR: Could not find a version that satisfies silero-vad',
          exitCode: 1,
          signal: null,
        };
      }
      return { stdout: '', stderr: '', exitCode: 0, signal: null };
    };

    const result = await runVoiceInstall({
      venvDir,
      platform: 'linux',
      homeDir: '/tmp/fake-home',
      spawner,
      force: true,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('silero-install-failed');
  });
});

describe('runVoiceInstall — progress callback', () => {
  it('forwards progress lines from spawner to the caller', async () => {
    const venvDir = makeTmp('voice-installer-');
    const progressLines: string[] = [];
    const spawner: InstallerSpawner = async (req) => {
      if (req.args[0] === '--version') {
        return { stdout: 'Python 3.11.5', stderr: '', exitCode: 0, signal: null };
      }
      if (req.args[0] === '-m' && req.args[1] === 'pip' && req.args[2] === 'show') {
        return { stdout: '', stderr: '', exitCode: 1, signal: null };
      }
      if (req.onProgress) {
        req.onProgress('Collecting silero-vad');
        req.onProgress('Successfully installed silero-vad');
      }
      return { stdout: '', stderr: '', exitCode: 0, signal: null };
    };
    await runVoiceInstall({
      venvDir,
      platform: 'linux',
      homeDir: '/tmp/fake-home',
      spawner,
      force: true,
      onProgress: (line) => progressLines.push(line),
    });
    expect(progressLines.some((l) => l.includes('Using Python'))).toBe(true);
    // Spawner-fired progress should also reach the caller
    expect(progressLines.some((l) => l.includes('silero-vad'))).toBe(true);
  });
});

// Avoid unused-import lint
void vi;
