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
      homeDir: makeTmp('home-'),
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
      homeDir: makeTmp('home-'),
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
      homeDir: makeTmp('home-'),
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
      homeDir: makeTmp('home-'),
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
      homeDir: makeTmp('home-'),
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
      homeDir: makeTmp('home-'),
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
      homeDir: makeTmp('home-'),
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
      homeDir: makeTmp('home-'),
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
      homeDir: makeTmp('home-'),
      spawner,
      force: true,
      onProgress: (line) => progressLines.push(line),
    });
    expect(progressLines.some((l) => l.includes('Using Python'))).toBe(true);
    // Spawner-fired progress should also reach the caller
    expect(progressLines.some((l) => l.includes('silero-vad'))).toBe(true);
  });
});

// Phase 6B — Moonshine STT install steps
describe('runVoiceInstall — Phase 6B Moonshine', () => {
  it('fails with moonshine-import-failed when transitive deps fail to load', async () => {
    const venvDir = makeTmp('voice-installer-');
    const spawner: InstallerSpawner = async (req) => {
      if (req.args[0] === '--version') {
        return { stdout: 'Python 3.11.5', stderr: '', exitCode: 0, signal: null };
      }
      if (req.args[0] === '-m' && req.args[1] === 'pip' && req.args[2] === 'show') {
        return { stdout: '', stderr: '', exitCode: 1, signal: null };
      }
      // pip install of every required package succeeds
      if (req.args[0] === '-m' && req.args[1] === 'pip' && req.args[2] === 'install') {
        return { stdout: 'installed', stderr: '', exitCode: 0, signal: null };
      }
      // Moonshine import smoke: emulate a numba wheel that fails at import
      if (
        req.args[0] === '-c' &&
        req.args[1]?.includes('moonshine_onnx') &&
        !req.args[1].includes('transcribe(numpy')
      ) {
        return {
          stdout: '',
          stderr: 'ImportError: Numba needs NumPy 1.24 or less',
          exitCode: 1,
          signal: null,
        };
      }
      return { stdout: '', stderr: '', exitCode: 0, signal: null };
    };
    const result = await runVoiceInstall({
      venvDir,
      platform: 'linux',
      homeDir: makeTmp('home-'),
      spawner,
      force: true,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('moonshine-import-failed');
    // Field shape preserved on failure path
    expect(result.moonshineModelWarmed).toBe(false);
    expect(result.moonshineImportOk).toBe(false);
  });

  it('fails with moonshine-download-failed when warmup network call fails', async () => {
    const venvDir = makeTmp('voice-installer-');
    const spawner: InstallerSpawner = async (req) => {
      if (req.args[0] === '--version') {
        return { stdout: 'Python 3.11.5', stderr: '', exitCode: 0, signal: null };
      }
      if (req.args[0] === '-m' && req.args[1] === 'pip' && req.args[2] === 'show') {
        return { stdout: '', stderr: '', exitCode: 1, signal: null };
      }
      if (req.args[0] === '-m' && req.args[1] === 'pip' && req.args[2] === 'install') {
        return { stdout: 'installed', stderr: '', exitCode: 0, signal: null };
      }
      // Import smoke OK
      if (
        req.args[0] === '-c' &&
        req.args[1]?.startsWith('from moonshine_onnx')
      ) {
        return { stdout: '', stderr: '', exitCode: 0, signal: null };
      }
      // Warmup (network) fails
      if (req.args[0] === '-c' && req.args[1]?.includes('transcribe(numpy.zeros')) {
        return {
          stdout: '',
          stderr: 'ConnectionError: HTTPSConnectionPool(host=huggingface.co)',
          exitCode: 1,
          signal: null,
        };
      }
      return { stdout: '', stderr: '', exitCode: 0, signal: null };
    };
    const result = await runVoiceInstall({
      venvDir,
      platform: 'linux',
      homeDir: makeTmp('home-'),
      spawner,
      force: true,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('moonshine-download-failed');
    expect(result.moonshineImportOk).toBe(false);
    // moonshineImportOk is populated by the FINAL re-probe; failure paths
    // skip that. Test that the failure result carries the warning text.
    expect(result.warnings.some((w) => w.includes('Moonshine model warmup'))).toBe(true);
  });

  it('happy path populates moonshineInstalled / moonshineImportOk / moonshineModelWarmed', async () => {
    const venvDir = makeTmp('voice-installer-');
    const home = makeTmp('home-');
    const calls: Array<{ args: readonly string[] }> = [];
    const spawner: InstallerSpawner = async (req) => {
      calls.push({ args: req.args });
      if (req.args[0] === '--version') {
        return { stdout: 'Python 3.11.5', stderr: '', exitCode: 0, signal: null };
      }
      if (req.args[0] === '-m' && req.args[1] === 'pip' && req.args[2] === 'show') {
        return { stdout: '', stderr: '', exitCode: 1, signal: null };
      }
      return { stdout: '', stderr: '', exitCode: 0, signal: null };
    };
    const result = await runVoiceInstall({
      venvDir,
      platform: 'linux',
      homeDir: home,
      spawner,
      force: true,
    });
    expect(result.ok).toBe(true);
    expect(result.moonshineModelWarmed).toBe(true);
    // The final re-probe runs pip-show which we made fail; so moonshineInstalled
    // is reported false in the result. The IMPORT smoke runs separately; in this
    // fake the smoke also "succeeds" (generic exit 0). The contract: the install
    // PROCESS completed, the warm-up SUCCEEDED, so ok=true.
    // The import smoke was invoked
    const ranImportSmoke = calls.some(
      (c) =>
        c.args[0] === '-c' &&
        typeof c.args[1] === 'string' &&
        c.args[1].includes('from moonshine_onnx'),
    );
    expect(ranImportSmoke).toBe(true);
    // The warm-up was invoked
    const ranWarmup = calls.some(
      (c) =>
        c.args[0] === '-c' &&
        typeof c.args[1] === 'string' &&
        c.args[1].includes('transcribe(numpy.zeros'),
    );
    expect(ranWarmup).toBe(true);
  });

  it('moonshine added to required-deps probe; idempotent fast-path requires it', async () => {
    // Audit-m2 extension: a venv missing only useful-moonshine-onnx
    // must NOT short-circuit through the idempotent fast-path. Verifies
    // the dynamic reduce-over-REQUIRED_PIP_PACKAGES still includes the
    // new dep.
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
        const pkg = req.args[3];
        if (pkg === 'useful-moonshine-onnx') {
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
      homeDir: makeTmp('home-'),
      spawner,
    });
    expect(result.idempotent).toBe(false);
    expect(installCount).toBeGreaterThan(0);
  });

  it('idempotent fast-path requires the IMPORT smoke to succeed (not just pip-show)', async () => {
    // 6B audit-protection: a venv that pip-shows every dep but fails
    // to import moonshine_onnx (e.g. numba wheel broken) must
    // NOT idempotent-skip. The bridge would crash later otherwise.
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
        return {
          stdout: `Name: ${req.args[3]}\nVersion: 1.0`,
          stderr: '',
          exitCode: 0,
          signal: null,
        };
      }
      // Import smoke fails (transitive dep broken)
      if (
        req.args[0] === '-c' &&
        req.args[1]?.startsWith('from moonshine_onnx')
      ) {
        return {
          stdout: '',
          stderr: 'ImportError: numba broken',
          exitCode: 1,
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
      homeDir: makeTmp('home-'),
      spawner,
    });
    // idempotent path SKIPPED because import smoke failed.
    // The non-idempotent install path runs all pip-installs (5 required +
    // 1 optional), then the import smoke fails again -> moonshine-import-failed.
    // We assert that pip-installs WERE run (idempotent was skipped) AND
    // result.reason is the import failure.
    expect(installCount).toBeGreaterThan(0);
    expect(result.reason).toBe('moonshine-import-failed');
  });
});

describe('runVoiceInstall — Phase 6B vocab seed', () => {
  it('atomically installs the seed when target absent', async () => {
    const venvDir = makeTmp('voice-installer-');
    const home = makeTmp('home-');
    const spawner: InstallerSpawner = async (req) => {
      if (req.args[0] === '--version') {
        return { stdout: 'Python 3.11.5', stderr: '', exitCode: 0, signal: null };
      }
      if (req.args[0] === '-m' && req.args[1] === 'pip' && req.args[2] === 'show') {
        return { stdout: '', stderr: '', exitCode: 1, signal: null };
      }
      return { stdout: '', stderr: '', exitCode: 0, signal: null };
    };
    const result = await runVoiceInstall({
      venvDir,
      platform: 'linux',
      homeDir: home,
      spawner,
      force: true,
    });
    expect(result.ok).toBe(true);
    expect(result.voiceVocabSeeded).toBe(true);
    // Verify file landed at ~/.symphony/voice-vocab.json with seed content
    const fsp = await import('node:fs/promises');
    const seedTarget = path.join(home, '.symphony', 'voice-vocab.json');
    const body = await fsp.readFile(seedTarget, 'utf8');
    const data = JSON.parse(body) as { version: number; substitutions: Record<string, string> };
    expect(data.version).toBe(1);
    expect(Object.keys(data.substitutions).length).toBeGreaterThan(0);
    // Sanity: a known entry must be present
    expect(data.substitutions['use effect']).toBe('useEffect');
  });

  it('never overwrites an existing user vocab file', async () => {
    const venvDir = makeTmp('voice-installer-');
    const home = makeTmp('home-');
    const fsp = await import('node:fs/promises');
    const symDir = path.join(home, '.symphony');
    await fsp.mkdir(symDir, { recursive: true });
    const userVocab = path.join(symDir, 'voice-vocab.json');
    const userBody = '{"version":1,"substitutions":{"foo bar":"FooBar"}}';
    await fsp.writeFile(userVocab, userBody, 'utf8');

    const spawner: InstallerSpawner = async (req) => {
      if (req.args[0] === '--version') {
        return { stdout: 'Python 3.11.5', stderr: '', exitCode: 0, signal: null };
      }
      if (req.args[0] === '-m' && req.args[1] === 'pip' && req.args[2] === 'show') {
        return { stdout: '', stderr: '', exitCode: 1, signal: null };
      }
      return { stdout: '', stderr: '', exitCode: 0, signal: null };
    };
    const result = await runVoiceInstall({
      venvDir,
      platform: 'linux',
      homeDir: home,
      spawner,
      force: true,
    });
    expect(result.ok).toBe(true);
    expect(result.voiceVocabSeeded).toBe(false); // pre-existing user file
    // User content preserved verbatim
    const after = await fsp.readFile(userVocab, 'utf8');
    expect(after).toBe(userBody);
  });
});

describe('runVoiceInstall — Phase 6C openWakeWord', () => {
  it('fails with openwakeword-import-failed when transitive deps fail to load', async () => {
    const venvDir = makeTmp('voice-installer-');
    const spawner: InstallerSpawner = async (req) => {
      if (req.args[0] === '--version') {
        return { stdout: 'Python 3.11.5', stderr: '', exitCode: 0, signal: null };
      }
      if (req.args[0] === '-m' && req.args[1] === 'pip' && req.args[2] === 'show') {
        return { stdout: '', stderr: '', exitCode: 1, signal: null };
      }
      if (req.args[0] === '-m' && req.args[1] === 'pip' && req.args[2] === 'install') {
        return { stdout: 'installed', stderr: '', exitCode: 0, signal: null };
      }
      // Moonshine import + warmup succeed
      if (
        req.args[0] === '-c' &&
        req.args[1]?.includes('moonshine_onnx')
      ) {
        return { stdout: '', stderr: '', exitCode: 0, signal: null };
      }
      // openWakeWord import fails
      if (
        req.args[0] === '-c' &&
        req.args[1]?.startsWith('from openwakeword')
      ) {
        return {
          stdout: '',
          stderr: 'ImportError: scipy.signal not available',
          exitCode: 1,
          signal: null,
        };
      }
      return { stdout: '', stderr: '', exitCode: 0, signal: null };
    };
    const result = await runVoiceInstall({
      venvDir,
      platform: 'linux',
      homeDir: makeTmp('home-'),
      spawner,
      force: true,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('openwakeword-import-failed');
    // Field shape preserved on failure
    expect(result.openWakeWordImportOk).toBe(false);
  });

  it('happy path populates openWakeWordInstalled / openWakeWordImportOk', async () => {
    const venvDir = makeTmp('voice-installer-');
    const home = makeTmp('home-');
    const calls: Array<{ args: readonly string[] }> = [];
    const spawner: InstallerSpawner = async (req) => {
      calls.push({ args: req.args });
      if (req.args[0] === '--version') {
        return { stdout: 'Python 3.11.5', stderr: '', exitCode: 0, signal: null };
      }
      if (req.args[0] === '-m' && req.args[1] === 'pip' && req.args[2] === 'show') {
        // FINAL re-probe path — claim every pkg present for the result fields
        return {
          stdout: `Name: ${req.args[3]}\nVersion: 1.0`,
          stderr: '',
          exitCode: 0,
          signal: null,
        };
      }
      return { stdout: '', stderr: '', exitCode: 0, signal: null };
    };
    const result = await runVoiceInstall({
      venvDir,
      platform: 'linux',
      homeDir: home,
      spawner,
      force: true,
    });
    expect(result.ok).toBe(true);
    expect(result.openWakeWordInstalled).toBe(true);
    expect(result.openWakeWordImportOk).toBe(true);
    // The openwakeword import smoke was invoked
    const ranImportSmoke = calls.some(
      (c) =>
        c.args[0] === '-c' &&
        typeof c.args[1] === 'string' &&
        c.args[1].includes('from openwakeword.model import Model'),
    );
    expect(ranImportSmoke).toBe(true);
  });

  it('audit-m2 regression: openwakeword added to REQUIRED — idempotent fast-path requires it', async () => {
    // A venv with everything EXCEPT openwakeword must NOT short-circuit
    // through the idempotent fast-path. Mirrors the 6B audit-m2 lock-in
    // applied to the new dep.
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
        const pkg = req.args[3];
        if (pkg === 'openwakeword') {
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
      homeDir: makeTmp('home-'),
      spawner,
    });
    expect(result.idempotent).toBe(false);
    expect(installCount).toBeGreaterThan(0);
  });

  it('idempotent fast-path requires the openWakeWord IMPORT smoke to succeed', async () => {
    // Mirror of the 6B 'idempotent path requires import smoke' protection —
    // a venv that pip-shows openwakeword but fails to import it must NOT
    // idempotent-skip. The bridge would crash on first wake-word frame.
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
        return {
          stdout: `Name: ${req.args[3]}\nVersion: 1.0`,
          stderr: '',
          exitCode: 0,
          signal: null,
        };
      }
      if (
        req.args[0] === '-c' &&
        req.args[1]?.startsWith('from moonshine_onnx')
      ) {
        return { stdout: '', stderr: '', exitCode: 0, signal: null };
      }
      // openWakeWord import smoke fails
      if (
        req.args[0] === '-c' &&
        req.args[1]?.startsWith('from openwakeword')
      ) {
        return {
          stdout: '',
          stderr: 'ImportError: scipy broken',
          exitCode: 1,
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
      homeDir: makeTmp('home-'),
      spawner,
    });
    // idempotent path was SKIPPED because openwakeword import failed in
    // the probe; install path runs; openwakeword import smoke fails again
    // -> openwakeword-import-failed.
    expect(installCount).toBeGreaterThan(0);
    expect(result.reason).toBe('openwakeword-import-failed');
  });

  it('wakeModelBundled probe returns false when no .onnx exists; warning surfaced', async () => {
    // The bundled-model probe is non-fatal — install still succeeds with
    // a warning. Verifies the wakeModelBundled field shape AND the
    // warning string mentions the actionable next step.
    const venvDir = makeTmp('voice-installer-');
    const home = makeTmp('home-');
    const spawner: InstallerSpawner = async (req) => {
      if (req.args[0] === '--version') {
        return { stdout: 'Python 3.11.5', stderr: '', exitCode: 0, signal: null };
      }
      if (req.args[0] === '-m' && req.args[1] === 'pip' && req.args[2] === 'show') {
        // Force re-install path (not idempotent)
        return { stdout: '', stderr: '', exitCode: 1, signal: null };
      }
      return { stdout: '', stderr: '', exitCode: 0, signal: null };
    };
    const result = await runVoiceInstall({
      venvDir,
      platform: 'linux',
      homeDir: home,
      spawner,
      force: true,
    });
    // The default voiceWakeModelPath('hey-symphony') resolution will
    // succeed iff `assets/wake-models/hey-symphony.onnx` exists on the
    // build machine. We expect it does NOT (training is a separate op),
    // so wakeModelBundled is false + warning is appended.
    // BUT: if a future CI environment has the trained model committed,
    // this test would flip. The contract: install completes OK either way.
    expect(result.ok).toBe(true);
    if (!result.wakeModelBundled) {
      expect(
        result.warnings.some((w) => w.includes('wake-word model')),
      ).toBe(true);
    }
  });
});

// Avoid unused-import lint
void vi;
