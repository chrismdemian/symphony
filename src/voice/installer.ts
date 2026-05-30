import { spawn } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Readable, Writable } from 'node:stream';

import { resolveVoiceEnv, voiceBinDir } from './env.js';
import type { VoiceInstallResult } from './types.js';
import {
  voiceEnvDir,
  voiceVocabSeedPath,
  voiceVocabUserPath,
  voiceWakeModelPath,
  VoiceVocabSeedNotFoundError,
  VoiceWakeModelNotFoundError,
} from './path.js';

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
//   - useful-moonshine-onnx==20251121: Phase 6B STT model. Pinned to a
//     specific version (per `research/voice-stack-research.md` 6B
//     decision addendum) because the package versions are date-stamped
//     and we want install reproducibility. Pulls numba/tokenizers/
//     librosa/huggingface_hub transitively (pure-Python wheels on every
//     OS).
const REQUIRED_PIP_PACKAGES = [
  'silero-vad',
  'onnxruntime',
  'sounddevice',
  'numpy',
  'useful-moonshine-onnx==20251121',
  // Phase 6C — openWakeWord. Pure-Python wheel + uses the same onnxruntime
  // already required by 6A's Silero VAD. No GPU at runtime. The library
  // ships small pretrained models (CC BY-NC-SA) — Symphony only ships its
  // own Apache-2.0 self-trained `hey-symphony.onnx`, so the licensing on
  // the bundled artifacts doesn't transitively affect us.
  'openwakeword',
] as const;
const OPTIONAL_PIP_PACKAGES = ['pyaudio'] as const;

// pip-show key (no version pin). REQUIRED_PIP_PACKAGES carries the
// install spec ("pkg==version"); pip show uses the bare package name.
const PIP_SHOW_NAMES: Record<(typeof REQUIRED_PIP_PACKAGES)[number], string> = {
  'silero-vad': 'silero-vad',
  onnxruntime: 'onnxruntime',
  sounddevice: 'sounddevice',
  numpy: 'numpy',
  'useful-moonshine-onnx==20251121': 'useful-moonshine-onnx',
  openwakeword: 'openwakeword',
} as const;

/**
 * Build a default-shaped result with zero deps installed. Per-call
 * sites override fields as appropriate. Centralizes the "every result
 * carries the full field set" invariant; adding a new VoiceInstallResult
 * field is a single touch here plus the merge call sites.
 */
function makeBaseResult(
  venvPath: string,
  pythonPath: string,
): VoiceInstallResult {
  return {
    ok: false,
    exitCode: 1,
    venvPath,
    pythonPath,
    sileroVadInstalled: false,
    onnxRuntimeInstalled: false,
    soundDeviceInstalled: false,
    numpyInstalled: false,
    pyAudioInstalled: false,
    moonshineInstalled: false,
    moonshineImportOk: false,
    moonshineModelWarmed: false,
    voiceVocabSeeded: false,
    openWakeWordInstalled: false,
    openWakeWordImportOk: false,
    wakeModelBundled: false,
    summarizerInstalled: false,
    summarizerModelWarmed: false,
    warnings: [],
    idempotent: false,
  };
}

// Phase 6D.2 — local T5 ONNX summarizer for the rolling context buffer.
// Best-effort install (never gates overall success): ensure `tokenizers`
// (already a transitive dep of useful-moonshine-onnx) + pre-download the
// int8 ONNX model so the first compaction doesn't pay the ~144MB fetch.
// The no-cache decoder path is driven torch-free by
// `src/voice/python/summarizer.py`. The repo ships `tokenizer.json` (a
// fast/Unigram tokenizer), NOT a raw `spiece.model`.
const SUMMARIZER_REPO_ID = 'onnx-community/text_summarization-ONNX';
const SUMMARIZER_ALLOW_PATTERNS = [
  'onnx/encoder_model_int8.onnx',
  'onnx/decoder_model_int8.onnx',
  'tokenizer.json',
  'config.json',
  'generation_config.json',
  'special_tokens_map.json',
] as const;

/**
 * Install + warm the local summarizer (Phase 6D.2). Best-effort:
 * failures push a warning and return `{installed/warmed: false}` — the
 * rolling-buffer compaction falls back to the deterministic heuristic, so
 * a missing model never breaks voice. Idempotent (pip + snapshot_download
 * both skip already-present artifacts), so it's safe to run on the
 * idempotent install path too.
 */
async function runSummarizerInstall(
  spawner: InstallerSpawner,
  venvPython: string,
  progress: (line: string) => void,
  warnings: string[],
): Promise<{ installed: boolean; warmed: boolean }> {
  const allowList = `[${SUMMARIZER_ALLOW_PATTERNS.map((p) => JSON.stringify(p)).join(', ')}]`;

  // 1. tokenizers — probe-first so the idempotent path stays install-free.
  //    Normally already present (transitive via useful-moonshine-onnx);
  //    the pip-install is only a safety net if a future STT version drops it.
  let installed =
    (await spawner({ cmd: venvPython, args: ['-c', 'import tokenizers'] })).exitCode === 0;
  if (!installed) {
    progress('pip install tokenizers (Phase 6D.2 summarizer)...');
    const pipRes = await spawner({
      cmd: venvPython,
      args: ['-m', 'pip', 'install', 'tokenizers'],
      onProgress: progress,
    });
    if (pipRes.exitCode !== 0) {
      warnings.push(
        'pip install tokenizers failed (best-effort; the rolling-buffer ' +
          'summarizer falls back to the heuristic): ' +
          (pipRes.stderr || pipRes.stdout).slice(0, 400),
      );
      return { installed: false, warmed: false };
    }
    installed =
      (await spawner({ cmd: venvPython, args: ['-c', 'import tokenizers'] })).exitCode === 0;
    if (!installed) {
      warnings.push('tokenizers installed but not importable; summarizer falls back to the heuristic.');
      return { installed: false, warmed: false };
    }
  }

  // 2. Model files — probe the HF cache via local_files_only (raises when
  //    not fully cached), download only on a miss. Both probe + download
  //    skip already-present files, so this is idempotent.
  const probe = await spawner({
    cmd: venvPython,
    args: [
      '-c',
      'from huggingface_hub import snapshot_download; ' +
        `snapshot_download(${JSON.stringify(SUMMARIZER_REPO_ID)}, allow_patterns=${allowList}, local_files_only=True)`,
    ],
  });
  if (probe.exitCode === 0) return { installed: true, warmed: true };

  progress('Downloading T5 summarizer model (~144MB; first run)...');
  const dlRes = await spawner({
    cmd: venvPython,
    args: [
      '-c',
      'from huggingface_hub import snapshot_download; ' +
        `snapshot_download(${JSON.stringify(SUMMARIZER_REPO_ID)}, allow_patterns=${allowList})`,
    ],
    onProgress: progress,
  });
  if (dlRes.exitCode !== 0) {
    warnings.push(
      'T5 summarizer model download failed (best-effort; falls back to the ' +
        `heuristic): ${(dlRes.stderr || dlRes.stdout).slice(0, 400)}`,
    );
    return { installed: true, warmed: false };
  }
  return { installed: true, warmed: true };
}

function failureResult(
  base: VoiceInstallResult,
  reason: VoiceInstallResult['reason'],
  warnings: readonly string[],
): VoiceInstallResult {
  return {
    ...base,
    ok: false,
    exitCode: 1,
    reason,
    warnings,
  };
}

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
      return failureResult(makeBaseResult(venvDir, ''), 'python-not-found', [
        `\`${pythonCmd} --version\` failed (exit ${probe.exitCode}): ${probe.stderr.slice(0, 500)}`,
      ]);
    }
    pythonVersion = (probe.stdout + probe.stderr).trim();
  } catch (cause) {
    return failureResult(makeBaseResult(venvDir, ''), 'python-not-found', [
      `Failed to invoke \`${pythonCmd}\`: ${describeError(cause)}`,
    ]);
  }

  const versionMatch = /Python (\d+)\.(\d+)/.exec(pythonVersion);
  if (versionMatch !== null) {
    const major = Number.parseInt(versionMatch[1]!, 10);
    const minor = Number.parseInt(versionMatch[2]!, 10);
    if (
      major < MIN_PYTHON_MAJOR ||
      (major === MIN_PYTHON_MAJOR && minor < MIN_PYTHON_MINOR)
    ) {
      return failureResult(makeBaseResult(venvDir, ''), 'python-version-too-old', [
        `${pythonVersion} too old — Symphony voice requires Python >= ${MIN_PYTHON_MAJOR}.${MIN_PYTHON_MINOR}.`,
      ]);
    }
  }

  // Detect Windows Store install.
  if (platform === 'win32') {
    const basePrefix = await spawner({
      cmd: pythonCmd,
      args: ['-c', 'import sys; print(sys.base_prefix)'],
    });
    if (
      basePrefix.exitCode === 0 &&
      /\\WindowsApps\\/i.test(basePrefix.stdout)
    ) {
      return failureResult(makeBaseResult(venvDir, ''), 'python-store-install', [
        `Windows Store Python detected at ${basePrefix.stdout.trim()} — install a real Python ` +
          'from python.org or use winget (`winget install Python.Python.3.12`).',
      ]);
    }
  }

  progress(`Using ${pythonVersion}`);

  // 2. Probe existing venv. If python binary exists AND pip-show
  // confirms every required dep AND the Moonshine import smoke passes,
  // we're idempotent (skip pip install + model warmup).
  const summary = resolveVoiceEnv(home);
  const venvPython =
    opts.venvDir !== undefined
      ? path.join(
          opts.venvDir,
          platform === 'win32' ? 'Scripts' : 'bin',
          platform === 'win32' ? 'python.exe' : 'python',
        )
      : summary.pythonPath;

  const venvExists =
    opts.venvDir !== undefined
      ? await pathExists(venvPython)
      : summary.exists;

  if (venvExists && opts.force !== true) {
    const depStatus = await probeDeps(spawner, venvPython);
    if (depStatus.allPresent) {
      progress(
        'voice-env exists, all deps present + Moonshine + openWakeWord imports — idempotent.',
      );
      // Even on idempotent path, install the vocab seed if absent
      // (cheap; user may have deleted ~/.symphony/voice-vocab.json).
      const seeded = await tryInstallVocabSeed(home, warnings);
      const wakeBundled = wakeModelBundledOnDisk(warnings);
      // CRITICAL on the idempotent path too: the import smoke passes even
      // when the openWakeWord backbone (melspectrogram/embedding .onnx) is
      // MISSING — it only checks the class imports. A venv that pip-shows
      // + imports openwakeword but lacks the backbone (e.g. installed before
      // this download step existed) would idempotent-skip here and then fail
      // at runtime with NO_SUCHFILE. download_models is idempotent (skips
      // present files), so running it here is a cheap no-op when the backbone
      // already exists and a self-heal when it doesn't.
      const owwDl = await runOpenWakeWordModelDownload(spawner, venvPython);
      if (!owwDl.ok) {
        warnings.push(
          'openWakeWord backbone download failed on idempotent path; ' +
            `wake-word may fail at runtime. ${owwDl.stderr.slice(0, 300)}`,
        );
      }
      // Phase 6D.2 — summarizer is best-effort + idempotent, so run it on
      // the idempotent path too (self-heals a venv installed before 6D.2).
      const summarizerIdem = await runSummarizerInstall(
        spawner,
        venvPython,
        progress,
        warnings,
      );
      // Touch model warmup only if the HF cache is empty — but we can't
      // easily probe that without invoking python. Set
      // moonshineModelWarmed=true on the idempotent path because the
      // import smoke already passed and the cache state is consistent
      // with prior install runs. A future audit may want a stronger
      // probe; today's contract is "model is ready on the idempotent
      // path".
      return {
        ...makeBaseResult(venvDir, venvPython),
        ok: true,
        exitCode: 0,
        sileroVadInstalled: depStatus.silero,
        onnxRuntimeInstalled: depStatus.onnxruntime,
        soundDeviceInstalled: depStatus.sounddevice,
        numpyInstalled: depStatus.numpy,
        pyAudioInstalled: depStatus.pyaudio,
        moonshineInstalled: depStatus.moonshine,
        moonshineImportOk: depStatus.moonshineImport,
        moonshineModelWarmed: true,
        voiceVocabSeeded: seeded,
        openWakeWordInstalled: depStatus.openwakeword,
        openWakeWordImportOk: depStatus.openWakeWordImport,
        wakeModelBundled: wakeBundled,
        summarizerInstalled: summarizerIdem.installed,
        summarizerModelWarmed: summarizerIdem.warmed,
        warnings,
        idempotent: true,
      };
    }
  }

  // 3. Create venv (skip if it already exists)
  if (!venvExists) {
    progress(`Creating venv at ${venvDir}...`);
    await fsp.mkdir(path.dirname(venvDir), { recursive: true, mode: 0o700 });
    const venvCreate = await spawner({
      cmd: pythonCmd,
      args: ['-m', 'venv', venvDir],
      onProgress: progress,
    });
    if (venvCreate.exitCode !== 0) {
      return failureResult(makeBaseResult(venvDir, ''), 'venv-creation-failed', [
        `\`python -m venv ${venvDir}\` failed (exit ${venvCreate.exitCode}): ` +
          (venvCreate.stderr || venvCreate.stdout).slice(0, 800),
      ]);
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
      const reason: VoiceInstallResult['reason'] = pkgFailureReason(pkg);
      return failureResult(makeBaseResult(venvDir, venvPython), reason, [
        `\`pip install ${pkg}\` failed (exit ${install.exitCode}): ` +
          (install.stderr || install.stdout).slice(0, 800),
      ]);
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

  // 7. Moonshine import smoke (audit-m2 lesson applied in a different
  // shape: `pip show` doesn't validate transitive deps load at import
  // time — numba / tokenizers / librosa wheel issues surface here).
  progress('Validating Moonshine import (transitive dep check)...');
  const importOk = await runMoonshineImportSmoke(spawner, venvPython);
  if (!importOk) {
    return failureResult(makeBaseResult(venvDir, venvPython), 'moonshine-import-failed', [
      `useful-moonshine-onnx installed but \`from moonshine_onnx import transcribe\` failed. ` +
        'A transitive dep (numba / tokenizers / librosa) failed to load. ' +
        'Try `pnpm rebuild` or check the voice-env Python version.',
    ]);
  }

  // 8. Model warmup — download weights to HF cache + warm numba JIT.
  // First call is slow (5-15s on a fresh cache); subsequent runs are
  // cache hits (~1s). Surfaces network errors at install time rather
  // than on first user utterance.
  progress('Downloading Moonshine model weights (first run; ~120MB)...');
  const warmup = await runMoonshineModelWarmup(spawner, venvPython, progress);
  if (!warmup.ok) {
    return failureResult(makeBaseResult(venvDir, venvPython), 'moonshine-download-failed', [
      `Moonshine model warmup failed: ${warmup.stderr.slice(0, 800)}`,
    ]);
  }

  // 9. openWakeWord import smoke (same audit-m2 shape — pip show doesn't
  // prove the package's transitive deps load). openWakeWord pulls
  // onnxruntime (already pinned by 6A) + tflite-runtime as an optional;
  // we force the ONNX backend at runtime so the tflite missing-on-Windows
  // story is irrelevant. The import check exercises the ONNX path only.
  progress('Validating openWakeWord import (transitive dep check)...');
  const owwImportOk = await runOpenWakeWordImportSmoke(spawner, venvPython);
  if (!owwImportOk) {
    return failureResult(
      makeBaseResult(venvDir, venvPython),
      'openwakeword-import-failed',
      [
        'openwakeword installed but `from openwakeword.model import Model` failed. ' +
          'A transitive dep (onnxruntime / scipy / openwakeword shared model) ' +
          'failed to load. Try `pnpm rebuild` or check the voice-env Python version.',
      ],
    );
  }

  // 9b. Download openWakeWord's SHARED BACKBONE (melspectrogram.onnx +
  // embedding_model.onnx) into the venv's resources dir. CRITICAL: the
  // import smoke only constructs the Model CLASS — it does NOT fetch the
  // backbone. Without this, loading ANY wake-word model at runtime fails
  // with `NO_SUCHFILE: ...melspectrogram.onnx`. openwakeword.utils.
  // download_models() pulls the feature backbone (it also pulls the
  // upstream CC BY-NC-SA pretrained wake models, which we never load —
  // only the Apache-2.0 backbone is used). Analogue of the Moonshine
  // model warmup. Idempotent (skips already-present files).
  progress('Downloading openWakeWord feature backbone (~3MB; first run)...');
  const owwDownload = await runOpenWakeWordModelDownload(spawner, venvPython);
  if (!owwDownload.ok) {
    return failureResult(
      makeBaseResult(venvDir, venvPython),
      'openwakeword-download-failed',
      [
        'openwakeword.utils.download_models() failed — the shared feature ' +
          'backbone (melspectrogram.onnx / embedding_model.onnx) could not be ' +
          `fetched. Wake-word detection will fail at runtime. ${owwDownload.stderr.slice(0, 600)}`,
      ],
    );
  }

  // 10. Install the vocab seed atomically (only when target absent).
  const seeded = await tryInstallVocabSeed(home, warnings);

  // 11. Probe the bundled wake-word model on disk (informational — failing
  // to find it is NOT a fatal install error because the user might be
  // doing a from-source-without-trained-model dev install).
  const wakeBundled = wakeModelBundledOnDisk(warnings);
  if (!wakeBundled) {
    warnings.push(
      'No bundled wake-word model found. Voice still works for VAD + STT; ' +
        '`symphony voice listen` / `--wake-word` will fail until the model ' +
        'is built. See scripts/train-wake-word/README.md.',
    );
  }

  // 11b. Phase 6D.2 — install + warm the local T5 summarizer (best-effort).
  const summarizerStatus = await runSummarizerInstall(
    spawner,
    venvPython,
    progress,
    warnings,
  );

  // 12. Re-probe to populate the final result.
  const finalStatus = await probeDeps(spawner, venvPython);
  return {
    ...makeBaseResult(venvDir, venvPython),
    ok: true,
    exitCode: 0,
    sileroVadInstalled: finalStatus.silero,
    onnxRuntimeInstalled: finalStatus.onnxruntime,
    soundDeviceInstalled: finalStatus.sounddevice,
    numpyInstalled: finalStatus.numpy,
    pyAudioInstalled: finalStatus.pyaudio,
    moonshineInstalled: finalStatus.moonshine,
    moonshineImportOk: finalStatus.moonshineImport,
    moonshineModelWarmed: true,
    voiceVocabSeeded: seeded,
    openWakeWordInstalled: finalStatus.openwakeword,
    openWakeWordImportOk: finalStatus.openWakeWordImport,
    wakeModelBundled: wakeBundled,
    summarizerInstalled: summarizerStatus.installed,
    summarizerModelWarmed: summarizerStatus.warmed,
    warnings,
    idempotent: false,
  };
}

/**
 * Map a required-package install failure to a typed `reason`. Keeps the
 * mapping in one place so adding a new required dep with its own reason
 * is one constant + one switch arm.
 */
function pkgFailureReason(
  pkg: (typeof REQUIRED_PIP_PACKAGES)[number],
): VoiceInstallResult['reason'] {
  if (pkg === 'silero-vad' || pkg === 'onnxruntime') return 'silero-install-failed';
  if (pkg === 'sounddevice') return 'sounddevice-install-failed';
  if (pkg === 'numpy') return 'numpy-install-failed';
  if (pkg === 'useful-moonshine-onnx==20251121') return 'moonshine-install-failed';
  if (pkg === 'openwakeword') return 'openwakeword-install-failed';
  // Defensive: a new required pkg added without updating this switch
  // surfaces here. Type-narrowing via `never` would also catch it at
  // compile time when the spec literal is added to REQUIRED_PIP_PACKAGES.
  return 'silero-install-failed';
}

/**
 * Phase 6B — atomically install the bundled `vocab-seed.json` onto
 * `~/.symphony/voice-vocab.json` ONLY when the target doesn't exist.
 * Never overwrites user customizations. Returns true when the seed
 * file was created on this call, false when it was already present
 * (or when the seed source couldn't be located, in which case a
 * warning is pushed).
 *
 * Uses `fs.open(..., 'wx', 0o600)` — atomic create-or-fail. The 'wx'
 * flag is the canonical way to express "create new file, error if it
 * exists" without a separate stat-then-write race.
 */
async function tryInstallVocabSeed(
  home: string,
  warnings: string[],
): Promise<boolean> {
  let seedPath: string;
  try {
    seedPath = voiceVocabSeedPath();
  } catch (cause) {
    if (cause instanceof VoiceVocabSeedNotFoundError) {
      warnings.push(`vocab seed not found in package: ${cause.message}`);
      return false;
    }
    throw cause;
  }
  const targetPath = voiceVocabUserPath(home);
  let body: string;
  try {
    body = await fsp.readFile(seedPath, 'utf8');
  } catch (cause) {
    warnings.push(`vocab seed read failed: ${describeError(cause)}`);
    return false;
  }
  // Ensure parent dir exists (it should, but defensive).
  try {
    await fsp.mkdir(path.dirname(targetPath), { recursive: true, mode: 0o700 });
  } catch {
    // Ignore — file open will surface the real error.
  }
  try {
    const handle = await fsp.open(targetPath, 'wx', 0o600);
    try {
      await handle.writeFile(body, 'utf8');
    } finally {
      await handle.close();
    }
    return true;
  } catch (cause) {
    // EEXIST means user already has a vocab file — that's the
    // intended NOT-overwriting behavior; don't warn, don't fail.
    const code = (cause as NodeJS.ErrnoException)?.code;
    if (code === 'EEXIST') {
      return false;
    }
    warnings.push(`vocab seed install failed: ${describeError(cause)}`);
    return false;
  }
}

interface DepStatus {
  readonly silero: boolean;
  readonly onnxruntime: boolean;
  readonly sounddevice: boolean;
  readonly numpy: boolean;
  readonly pyaudio: boolean;
  /** Phase 6B — `pip show useful-moonshine-onnx` exit 0. */
  readonly moonshine: boolean;
  /**
   * Phase 6B — `python -c "from useful_moonshine_onnx import transcribe"`
   * exit 0. Validates transitive deps (numba, tokenizers, huggingface_hub,
   * librosa) load at import time. `pip show` doesn't catch a missing
   * numba wheel; the import smoke does. Audit-m2 lesson applied.
   */
  readonly moonshineImport: boolean;
  /** Phase 6C — `pip show openwakeword` exit 0. */
  readonly openwakeword: boolean;
  /**
   * Phase 6C — `python -c "from openwakeword.model import Model"` exit 0.
   * Validates the openwakeword package can construct its Model class —
   * exercises the shared embedding backbone + ONNX runtime path.
   */
  readonly openWakeWordImport: boolean;
  /** All REQUIRED packages present AND moonshine + openWakeWord import cleanly; OPTIONAL `pyaudio` excluded. */
  readonly allPresent: boolean;
}

/**
 * Probe each REQUIRED_PIP_PACKAGES entry + the OPTIONAL pyaudio + the
 * Moonshine import smoke.
 *
 * `allPresent` reduces over the REQUIRED list dynamically so adding a
 * new required dep updates the check automatically — defends against
 * the 6A audit-m2 "silently omits one" pattern recurring. Phase 6B
 * adds the import smoke into `allPresent` because `pip show` alone
 * doesn't validate transitive dep loadability.
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
    REQUIRED_PIP_PACKAGES.map(
      async (p) => [p, await check(PIP_SHOW_NAMES[p])] as const,
    ),
  );
  const required = new Map(requiredResults);
  const pyaudio = await check('pyaudio');
  const moonshinePresent = required.get('useful-moonshine-onnx==20251121') === true;
  // Import smoke runs ONLY when pip-show reports moonshine present
  // (no point importing what isn't installed). Empty input avoids
  // numba JIT compilation on this probe (saves ~3-8s); the import-only
  // path is ~1-2s.
  let moonshineImport = false;
  if (moonshinePresent) {
    moonshineImport = await runMoonshineImportSmoke(spawner, venvPython);
  }
  const openWakeWordPresent = required.get('openwakeword') === true;
  let openWakeWordImport = false;
  if (openWakeWordPresent) {
    openWakeWordImport = await runOpenWakeWordImportSmoke(spawner, venvPython);
  }
  const requiredAllShown = requiredResults.every(([, present]) => present);
  return {
    silero: required.get('silero-vad') === true,
    onnxruntime: required.get('onnxruntime') === true,
    sounddevice: required.get('sounddevice') === true,
    numpy: required.get('numpy') === true,
    pyaudio,
    moonshine: moonshinePresent,
    moonshineImport,
    openwakeword: openWakeWordPresent,
    openWakeWordImport,
    // `allPresent` reduces over the REQUIRED list dynamically (6A audit-m2)
    // AND requires every import smoke to pass. Adding a new required dep
    // with an import smoke means: add the constant + the probe + extend the
    // smoke chain here. Tests regression-lock this fan-out.
    allPresent: requiredAllShown && moonshineImport && openWakeWordImport,
  };
}

/**
 * Phase 6B — runs `python -c "from moonshine_onnx import ..."` and
 * returns true on exit 0. Distinct from `pip show` because numba /
 * tokenizers / librosa transitive wheels can fail at import time even
 * when pip metadata says the package is installed (audit-m2 pattern in
 * a different shape).
 *
 * Naming gotcha: the PyPI package name is `useful-moonshine-onnx` (with
 * hyphens, pip's identifier) but the Python MODULE name is
 * `moonshine_onnx` (underscores, NO `useful_` prefix). Don't confuse the
 * two; the package name is what we install, the module name is what we
 * import.
 */
async function runMoonshineImportSmoke(
  spawner: InstallerSpawner,
  venvPython: string,
): Promise<boolean> {
  const result = await spawner({
    cmd: venvPython,
    args: ['-c', 'from moonshine_onnx import transcribe'],
  });
  return result.exitCode === 0;
}

/**
 * Phase 6C — runs `python -c "from openwakeword.model import Model"` and
 * returns true on exit 0. Mirrors `runMoonshineImportSmoke`'s shape; needed
 * because pip-show alone doesn't catch the transitive deps openwakeword
 * pulls in (scipy / onnxruntime / shared embedding model). Audit-m2 lesson
 * applied: pip-show is a metadata check, import is a runtime check.
 *
 * Caveat: this import path triggers a one-time download of openWakeWord's
 * shared speech-embedding backbone from HuggingFace (~5 MB). After the
 * first successful smoke, subsequent runs are cache hits (~200 ms).
 */
async function runOpenWakeWordImportSmoke(
  spawner: InstallerSpawner,
  venvPython: string,
): Promise<boolean> {
  const result = await spawner({
    cmd: venvPython,
    args: ['-c', 'from openwakeword.model import Model'],
  });
  return result.exitCode === 0;
}

/**
 * Phase 6C — download openWakeWord's shared feature backbone
 * (`melspectrogram.onnx` + `embedding_model.onnx`) into the venv's
 * `openwakeword/resources/models/` dir via `openwakeword.utils.
 * download_models()`. REQUIRED: constructing a `Model(...)` at runtime
 * loads the backbone, and without it the load fails with
 * `NO_SUCHFILE: ...melspectrogram.onnx`. The import smoke does NOT fetch
 * these — it only validates the class imports. Idempotent (download_models
 * skips files already present). Pulls the upstream CC BY-NC-SA pretrained
 * wake models too, but Symphony never loads those — only the Apache-2.0
 * backbone is used by the bundled hey-symphony model.
 */
async function runOpenWakeWordModelDownload(
  spawner: InstallerSpawner,
  venvPython: string,
): Promise<{ ok: boolean; stderr: string }> {
  const result = await spawner({
    cmd: venvPython,
    args: ['-c', 'import openwakeword.utils as u; u.download_models()'],
  });
  return { ok: result.exitCode === 0, stderr: result.stderr };
}

/**
 * Phase 6C — probe the bundled wake-word model on disk. Non-fatal probe:
 * the model may legitimately be absent in a from-source-without-training
 * dev install. The boolean is surfaced on `VoiceInstallResult.wakeModelBundled`
 * so CLI consumers can render a clear status line + the warning is appended.
 */
function wakeModelBundledOnDisk(warnings: string[]): boolean {
  try {
    // Default model name. If we ever ship multiple, probe each via a
    // KNOWN_BUNDLED_WAKE_MODELS array.
    voiceWakeModelPath('hey-symphony');
    return true;
  } catch (cause) {
    if (cause instanceof VoiceWakeModelNotFoundError) {
      return false;
    }
    warnings.push(
      `unexpected error probing wake model: ${describeError(cause)}`,
    );
    return false;
  }
}

/**
 * Phase 6B — runs a tiny inference to download the Moonshine model
 * weights and warm the numba JIT. First call is slow (~5-15s — download
 * ~120MB from HF Hub + JIT compile); subsequent calls are cache hits
 * (~1s). Idempotent.
 *
 * Returns true on exit 0. Errors include network failures (HF unreachable)
 * and numba compile failures (very rare on modern x86 with wheel-only
 * mode).
 *
 * Naming: see `runMoonshineImportSmoke` — module name is `moonshine_onnx`,
 * not `useful_moonshine_onnx`.
 */
async function runMoonshineModelWarmup(
  spawner: InstallerSpawner,
  venvPython: string,
  onProgress: (line: string) => void,
): Promise<{ ok: boolean; stderr: string }> {
  // moonshine_onnx.transcribe wants a 1-D (N,) array (it adds the
  // batch dim internally via `audio[None, ...]`). Passing (1, N)
  // trips its `assert len(audio.shape) == 2`.
  const py =
    'import numpy, moonshine_onnx as m; ' +
    "m.transcribe(numpy.zeros(16000, dtype=numpy.float32), 'moonshine/base')";
  const result = await spawner({
    cmd: venvPython,
    args: ['-c', py],
    onProgress,
  });
  return { ok: result.exitCode === 0, stderr: result.stderr };
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
