import { spawn } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Readable, Writable } from 'node:stream';

import { resolveVoiceEnv, voiceBinDir } from './env.js';
import type { VoiceInstallResult } from './types.js';
import { voiceEnvDir } from './path.js';

/**
 * Phase 6A — `~/.symphony/voice-env/` Python venv bootstrap.
 *
 * Idempotent: detects an existing venv + verifies dep presence via
 * `pip show`. If everything's already present at any version, returns
 * `idempotent: true` with `exitCode: 0`.
 *
 * Strategy:
 *   1. Probe a usable Python (>= 3.10) on PATH. Refuse Windows Store
 *      install — its subprocess-launch semantics are broken in ways
 *      that bite voice subprocesses (`research/voice-stack-research.md`
 *      §7 "Python in PATH").
 *   2. `python -m venv ~/.symphony/voice-env`
 *   3. Upgrade pip inside the venv (silero-vad needs >=23).
 *   4. `pip install silero-vad sounddevice numpy` — these are the
 *      required deps for 6A.
 *   5. Best-effort `pip install pyaudio` — Win32 wheels often miss.
 *      Logs a warning if it fails; install succeeds anyway.
 *
 * The runner is a single function so tests can inject a fake spawner
 * via `deps.spawner` for unit coverage of the decision tree.
 */

const MIN_PYTHON_MAJOR = 3;
const MIN_PYTHON_MINOR = 10;

export interface InstallerSpawnResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
}

export interface InstallerSpawnerArgs {
  readonly cmd: string;
  readonly args: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
  readonly stdinBytes?: Buffer;
  readonly onProgress?: (line: string) => void;
}

/**
 * Dependency-injection seam for tests. Production uses
 * `defaultInstallerSpawner` (Node child_process.spawn).
 */
export type InstallerSpawner = (args: InstallerSpawnerArgs) => Promise<InstallerSpawnResult>;

export interface RunVoiceInstallOptions {
  /** Override the venv directory (test isolation). */
  readonly venvDir?: string;
  /** Override the system Python lookup. */
  readonly pythonOverride?: string;
  /** Force reinstall even when deps already present. */
  readonly force?: boolean;
  /** Progress callback for pip stdout lines. */
  readonly onProgress?: (line: string) => void;
  /** Override the spawner (tests). */
  readonly spawner?: InstallerSpawner;
  /** Override the platform (tests). */
  readonly platform?: NodeJS.Platform;
  /** Override the home dir (tests). */
  readonly homeDir?: string;
}

/** Default spawner — wraps `child_process.spawn` with a stdout/err capture. */
export const defaultInstallerSpawner: InstallerSpawner = async (args) => {
  return new Promise((resolve, reject) => {
    const child = spawn(args.cmd, [...args.args], {
      env: args.env,
      cwd: args.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
    }) as {
      stdin: Writable;
      stdout: Readable;
      stderr: Readable;
      on: (event: 'error' | 'exit', listener: (...a: unknown[]) => void) => void;
    };
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      if (args.onProgress !== undefined) {
        for (const line of chunk.split(/\r?\n/)) {
          if (line.length > 0) args.onProgress(line);
        }
      }
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', (err: unknown) => reject(err));
    child.on('exit', (exitCode: unknown, signal: unknown) =>
      resolve({
        stdout,
        stderr,
        exitCode: exitCode as number | null,
        signal: signal as NodeJS.Signals | null,
      }),
    );
    if (args.stdinBytes !== undefined) {
      child.stdin.end(args.stdinBytes);
    } else {
      child.stdin.end();
    }
  });
};

// Required deps:
//   - silero-vad: VAD model + Python wrapper (PyPI: silero-vad)
//   - onnxruntime: ONNX backend (silero-vad's PyPI dist does NOT pull
//     this in; without it `load_silero_vad(onnx=True)` raises
//     ModuleNotFoundError). Verified empirically on Win11 + Python 3.12.
//   - sounddevice: audio capture (primary)
//   - numpy: int16 -> float32 conversion in vad_segmenter's prob fn
const REQUIRED_PIP_PACKAGES = [
  'silero-vad',
  'onnxruntime',
  'sounddevice',
  'numpy',
] as const;
const OPTIONAL_PIP_PACKAGES = ['pyaudio'] as const;

export async function runVoiceInstall(
  opts: RunVoiceInstallOptions = {},
): Promise<VoiceInstallResult> {
  const spawner = opts.spawner ?? defaultInstallerSpawner;
  const home = opts.homeDir ?? os.homedir();
  const platform = opts.platform ?? process.platform;
  const venvDir = opts.venvDir ?? voiceEnvDir(home);
  const warnings: string[] = [];
  const progress = opts.onProgress ?? ((_l) => {});

  // 1. Probe Python
  const pythonCmd =
    opts.pythonOverride ?? (platform === 'win32' ? 'python' : 'python3');

  let pythonVersion: string;
  try {
    const probe = await spawner({
      cmd: pythonCmd,
      args: ['--version'],
    });
    if (probe.exitCode !== 0) {
      return {
        ok: false,
        exitCode: 1,
        reason: 'python-not-found',
        venvPath: venvDir,
        pythonPath: '',
        sileroVadInstalled: false,
        onnxRuntimeInstalled: false,
        soundDeviceInstalled: false,
        numpyInstalled: false,
        pyAudioInstalled: false,
        warnings: [
          `\`${pythonCmd} --version\` failed (exit ${probe.exitCode}): ${probe.stderr.slice(0, 500)}`,
        ],
        idempotent: false,
      };
    }
    pythonVersion = (probe.stdout + probe.stderr).trim();
  } catch (cause) {
    return {
      ok: false,
      exitCode: 1,
      reason: 'python-not-found',
      venvPath: venvDir,
      pythonPath: '',
      sileroVadInstalled: false,
      onnxRuntimeInstalled: false,
      soundDeviceInstalled: false,
      numpyInstalled: false,
      pyAudioInstalled: false,
      warnings: [`Failed to invoke \`${pythonCmd}\`: ${describeError(cause)}`],
      idempotent: false,
    };
  }

  const versionMatch = /Python (\d+)\.(\d+)/.exec(pythonVersion);
  if (versionMatch !== null) {
    const major = Number.parseInt(versionMatch[1]!, 10);
    const minor = Number.parseInt(versionMatch[2]!, 10);
    if (
      major < MIN_PYTHON_MAJOR ||
      (major === MIN_PYTHON_MAJOR && minor < MIN_PYTHON_MINOR)
    ) {
      return {
        ok: false,
        exitCode: 1,
        reason: 'python-version-too-old',
        venvPath: venvDir,
        pythonPath: '',
        sileroVadInstalled: false,
        onnxRuntimeInstalled: false,
        soundDeviceInstalled: false,
        numpyInstalled: false,
        pyAudioInstalled: false,
        warnings: [
          `${pythonVersion} too old — Symphony voice requires Python >= ${MIN_PYTHON_MAJOR}.${MIN_PYTHON_MINOR}.`,
        ],
        idempotent: false,
      };
    }
  }

  // Detect Windows Store install. `sys.base_prefix` lands under
  // `WindowsApps` for those installs; spawned subprocesses inherit a
  // restricted execution model that breaks our long-lived bridge.
  if (platform === 'win32') {
    const basePrefix = await spawner({
      cmd: pythonCmd,
      args: ['-c', 'import sys; print(sys.base_prefix)'],
    });
    if (
      basePrefix.exitCode === 0 &&
      /\\WindowsApps\\/i.test(basePrefix.stdout)
    ) {
      return {
        ok: false,
        exitCode: 1,
        reason: 'python-store-install',
        venvPath: venvDir,
        pythonPath: '',
        sileroVadInstalled: false,
        onnxRuntimeInstalled: false,
        soundDeviceInstalled: false,
        numpyInstalled: false,
        pyAudioInstalled: false,
        warnings: [
          `Windows Store Python detected at ${basePrefix.stdout.trim()} — install a real Python ` +
            'from python.org or use winget (`winget install Python.Python.3.12`).',
        ],
        idempotent: false,
      };
    }
  }

  progress(`Using ${pythonVersion}`);

  // 2. Probe existing venv. If python binary exists AND pip-show
  // confirms every required dep, we're idempotent.
  const summary = resolveVoiceEnv(home);
  const venvPython =
    opts.venvDir !== undefined
      ? path.join(opts.venvDir, platform === 'win32' ? 'Scripts' : 'bin', platform === 'win32' ? 'python.exe' : 'python')
      : summary.pythonPath;

  const venvExists =
    opts.venvDir !== undefined
      ? await pathExists(venvPython)
      : summary.exists;

  if (venvExists && opts.force !== true) {
    const depStatus = await probeDeps(spawner, venvPython);
    if (depStatus.allPresent) {
      progress('voice-env exists, all deps present — idempotent.');
      return {
        ok: true,
        exitCode: 0,
        venvPath: venvDir,
        pythonPath: venvPython,
        sileroVadInstalled: depStatus.silero,
        onnxRuntimeInstalled: depStatus.onnxruntime,
        soundDeviceInstalled: depStatus.sounddevice,
        numpyInstalled: depStatus.numpy,
        pyAudioInstalled: depStatus.pyaudio,
        warnings: [],
        idempotent: true,
      };
    }
  }

  // 3. Create venv (skip if it already exists)
  if (!venvExists) {
    progress(`Creating venv at ${venvDir}...`);
    // Ensure the parent dir exists
    await fsp.mkdir(path.dirname(venvDir), { recursive: true, mode: 0o700 });
    const venvCreate = await spawner({
      cmd: pythonCmd,
      args: ['-m', 'venv', venvDir],
      onProgress: progress,
    });
    if (venvCreate.exitCode !== 0) {
      return {
        ok: false,
        exitCode: 1,
        reason: 'venv-creation-failed',
        venvPath: venvDir,
        pythonPath: '',
        sileroVadInstalled: false,
        onnxRuntimeInstalled: false,
        soundDeviceInstalled: false,
        numpyInstalled: false,
        pyAudioInstalled: false,
        warnings: [
          `\`python -m venv ${venvDir}\` failed (exit ${venvCreate.exitCode}): ` +
            (venvCreate.stderr || venvCreate.stdout).slice(0, 800),
        ],
        idempotent: false,
      };
    }
  } else {
    progress('voice-env exists, refreshing deps...');
  }

  // 4. Bootstrap pip + install required deps
  progress('Upgrading pip...');
  const pipUpgrade = await spawner({
    cmd: venvPython,
    args: ['-m', 'pip', 'install', '--upgrade', 'pip'],
    onProgress: progress,
  });
  if (pipUpgrade.exitCode !== 0) {
    warnings.push(
      `pip upgrade failed (exit ${pipUpgrade.exitCode}). Continuing anyway: ${
        (pipUpgrade.stderr || pipUpgrade.stdout).slice(0, 400)
      }`,
    );
  }

  // 5. Install required packages
  for (const pkg of REQUIRED_PIP_PACKAGES) {
    progress(`pip install ${pkg}...`);
    const install = await spawner({
      cmd: venvPython,
      args: ['-m', 'pip', 'install', pkg],
      onProgress: progress,
    });
    if (install.exitCode !== 0) {
      const reason: VoiceInstallResult['reason'] =
        pkg === 'silero-vad' || pkg === 'onnxruntime'
          ? 'silero-install-failed'
          : pkg === 'sounddevice'
            ? 'sounddevice-install-failed'
            : 'numpy-install-failed';
      return {
        ok: false,
        exitCode: 1,
        reason,
        venvPath: venvDir,
        pythonPath: venvPython,
        sileroVadInstalled: false,
        onnxRuntimeInstalled: false,
        soundDeviceInstalled: false,
        numpyInstalled: false,
        pyAudioInstalled: false,
        warnings: [
          `\`pip install ${pkg}\` failed (exit ${install.exitCode}): ` +
            (install.stderr || install.stdout).slice(0, 800),
        ],
        idempotent: false,
      };
    }
  }

  // 6. Optional packages — best effort
  for (const pkg of OPTIONAL_PIP_PACKAGES) {
    progress(`pip install ${pkg} (best-effort)...`);
    const install = await spawner({
      cmd: venvPython,
      args: ['-m', 'pip', 'install', pkg],
      onProgress: progress,
    });
    if (install.exitCode !== 0) {
      warnings.push(
        `pip install ${pkg} failed (best-effort, not fatal): ` +
          (install.stderr || install.stdout).slice(0, 400),
      );
    }
  }

  // 7. Re-probe
  const finalStatus = await probeDeps(spawner, venvPython);
  return {
    ok: true,
    exitCode: 0,
    venvPath: venvDir,
    pythonPath: venvPython,
    sileroVadInstalled: finalStatus.silero,
    onnxRuntimeInstalled: finalStatus.onnxruntime,
    soundDeviceInstalled: finalStatus.sounddevice,
    numpyInstalled: finalStatus.numpy,
    pyAudioInstalled: finalStatus.pyaudio,
    warnings,
    idempotent: false,
  };
}

interface DepStatus {
  readonly silero: boolean;
  readonly onnxruntime: boolean;
  readonly sounddevice: boolean;
  readonly numpy: boolean;
  readonly pyaudio: boolean;
  /** All REQUIRED packages present; OPTIONAL `pyaudio` excluded. */
  readonly allPresent: boolean;
}

/**
 * Probe each REQUIRED_PIP_PACKAGES entry + the OPTIONAL pyaudio.
 * `allPresent` reduces over the REQUIRED list dynamically so adding a new
 * required dep (e.g. `moonshine-onnx` in 6B) updates the check
 * automatically — defends against the 6A audit-m2 "silently omits one"
 * pattern recurring.
 */
async function probeDeps(
  spawner: InstallerSpawner,
  venvPython: string,
): Promise<DepStatus> {
  const check = async (pkg: string): Promise<boolean> => {
    const result = await spawner({
      cmd: venvPython,
      args: ['-m', 'pip', 'show', pkg],
    });
    return result.exitCode === 0;
  };
  const requiredResults = await Promise.all(
    REQUIRED_PIP_PACKAGES.map(async (p) => [p, await check(p)] as const),
  );
  const required = new Map(requiredResults);
  const pyaudio = await check('pyaudio');
  return {
    silero: required.get('silero-vad') === true,
    onnxruntime: required.get('onnxruntime') === true,
    sounddevice: required.get('sounddevice') === true,
    numpy: required.get('numpy') === true,
    pyaudio,
    allPresent: requiredResults.every(([, present]) => present),
  };
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

function describeError(cause: unknown): string {
  if (cause instanceof Error) {
    const code = (cause as NodeJS.ErrnoException).code;
    return code !== undefined ? `${code} ${cause.message}` : cause.message;
  }
  return String(cause);
}

// Re-export so installer consumers don't have to dual-import path/env.
export { voiceBinDir };
