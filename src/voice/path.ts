import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';

import { symphonyDataDir } from '../utils/config.js';

/**
 * Phase 6A — paths for the voice subsystem.
 *
 * The Python venv lives under `~/.symphony/voice-env/` (single-install,
 * cross-project — mirrors `skillsDir` 4D.3 and `audit.log` 3R). Override
 * via `SYMPHONY_VOICE_ENV_DIR` for tests.
 *
 * The Python source files (`voice_bridge.py` etc.) ship two ways:
 *   - dev (`pnpm dev` / `tsx`): `<repo>/src/voice/python/`
 *   - built (`pnpm build` then `node dist/index.js`):
 *     `<repo>/dist/voice/python/` (copied by `tsup onSuccess`)
 *
 * `voicePythonPackageDir` walks `import.meta.url` candidates in order,
 * mirroring `resolveMaestroPromptsDir` (2C.1 m6) and `resolveBundledDroidsDir`
 * (4F.2). Throws when neither layout is present so a packaging defect
 * fails loud at boot rather than silently disabling voice.
 */

export const SYMPHONY_VOICE_ENV_DIR_ENV = 'SYMPHONY_VOICE_ENV_DIR' as const;

/** Resolve `~/.symphony/voice-env/` (or the env override). */
export function voiceEnvDir(home?: string): string {
  const override = process.env[SYMPHONY_VOICE_ENV_DIR_ENV]?.trim();
  if (override !== undefined && override.length > 0) {
    return path.resolve(override);
  }
  return path.join(symphonyDataDir(home), 'voice-env');
}

/**
 * Path to the venv's Python interpreter. Win32: `Scripts\python.exe`;
 * POSIX: `bin/python`. Does NOT check existence — callers that need
 * an existence check use `resolveVoiceEnv()`.
 */
export function voicePythonPath(
  venvDir: string = voiceEnvDir(),
  platform: NodeJS.Platform = process.platform,
): string {
  return platform === 'win32'
    ? path.join(venvDir, 'Scripts', 'python.exe')
    : path.join(venvDir, 'bin', 'python');
}

/**
 * Path to the venv's bin/Scripts dir. Used to set `PATH` prefix for
 * subprocess spawns so shell-out from the bridge (e.g. `pip show`)
 * resolves the venv's tools.
 */
export function voiceBinDir(
  venvDir: string = voiceEnvDir(),
  platform: NodeJS.Platform = process.platform,
): string {
  return platform === 'win32'
    ? path.join(venvDir, 'Scripts')
    : path.join(venvDir, 'bin');
}

/**
 * Resolve the on-disk directory containing the Python bridge source
 * files. Walks `import.meta.url` candidates so dev (`src/voice/python/`)
 * and built (`dist/voice/python/`) layouts both work.
 *
 * Throws `VoicePythonPackageNotFoundError` when neither layout is found
 * — fail-loud on packaging defects (4F.2 / 2C.1 precedent).
 */
export function voicePythonPackageDir(): string {
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  const candidates = [
    // Dev: src/voice/path.ts → src/voice/python/
    path.join(here, 'python'),
    // Built: dist/index.js sits in dist/, copy lives at dist/voice/python/
    path.join(here, 'voice', 'python'),
    // Defensive: caller built tsup elsewhere and `import.meta.url` lands
    // inside a tarball-extracted dist/. Mirror 4F.2 candidate walk shape.
    path.join(path.dirname(here), 'voice', 'python'),
  ];
  for (const candidate of candidates) {
    if (existsSync(path.join(candidate, 'voice_bridge.py'))) {
      return candidate;
    }
  }
  throw new VoicePythonPackageNotFoundError(
    `voice_bridge.py not found in any candidate location: ${candidates.join(', ')}. ` +
      'Did `pnpm build` complete? See tsup.config.ts copyTree(src/voice/python → dist/voice/python).',
  );
}

/**
 * Phase 6B — resolve the bundled vocab seed JSON (`vocab-seed.json`).
 * Shipped in both `src/voice/` (dev) and `dist/voice/` (built). Used by
 * the installer to atomically copy onto `~/.symphony/voice-vocab.json`
 * on first install (NEVER overwrites an existing user file).
 *
 * Throws when neither layout has it — fail-loud on packaging defects.
 */
export function voiceVocabSeedPath(): string {
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  const candidates = [
    // Dev: src/voice/path.ts -> src/voice/vocab-seed.json
    path.join(here, 'vocab-seed.json'),
    // Built: dist/index.js -> dist/voice/vocab-seed.json (tsup copyTree)
    path.join(here, 'voice', 'vocab-seed.json'),
    // Defensive
    path.join(path.dirname(here), 'voice', 'vocab-seed.json'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new VoiceVocabSeedNotFoundError(
    `vocab-seed.json not found in: ${candidates.join(', ')}. ` +
      'Did `pnpm build` complete? See tsup.config.ts copyTree(src/voice -> dist/voice).',
  );
}

/**
 * Phase 6B — resolve the user-global vocab path at `~/.symphony/voice-vocab.json`.
 * Override via `SYMPHONY_VOICE_VOCAB_FILE` env var. May not exist on disk;
 * caller checks `existsSync` separately.
 */
export const SYMPHONY_VOICE_VOCAB_FILE_ENV = 'SYMPHONY_VOICE_VOCAB_FILE' as const;

export function voiceVocabUserPath(home?: string): string {
  const override = process.env[SYMPHONY_VOICE_VOCAB_FILE_ENV]?.trim();
  if (override !== undefined && override.length > 0) {
    return path.resolve(override);
  }
  return path.join(symphonyDataDir(home), 'voice-vocab.json');
}

/**
 * Phase 6B — resolve a project-local vocab path at
 * `<project>/.symphony/voice-vocab.json`. Returns `undefined` when
 * `projectRoot` is missing.
 */
export function voiceVocabProjectPath(projectRoot: string | undefined): string | undefined {
  if (projectRoot === undefined || projectRoot.length === 0) return undefined;
  return path.join(projectRoot, '.symphony', 'voice-vocab.json');
}

/**
 * Phase 6B — collect existing vocab paths in load order (user-global
 * first, then project-local — later overrides earlier on key collision
 * inside `voice_vocab.py`'s merge).
 */
export function resolveVoiceVocabPaths(opts: {
  readonly home?: string;
  readonly projectRoot?: string;
}): string[] {
  const paths: string[] = [];
  const userGlobal = voiceVocabUserPath(opts.home);
  if (existsSync(userGlobal)) paths.push(userGlobal);
  const projectLocal = voiceVocabProjectPath(opts.projectRoot);
  if (projectLocal !== undefined && existsSync(projectLocal)) {
    paths.push(projectLocal);
  }
  return paths;
}

/**
 * Path to the Phase 6A diagnose PCM fixture. The fixture is committed
 * under `tests/fixtures/voice/` and bundled with the repo (NOT shipped
 * in `dist/`). Used by `runVoiceDiagnose` to drive the bridge in
 * `--input-mode stdin-pcm` without a real microphone.
 *
 * Returns the in-repo path when discoverable, else throws — this is
 * a dev/test affordance, not a production runtime path.
 */
export function voiceDiagnoseFixturePath(): string {
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  // Dev layout: src/voice/path.ts → ../../tests/fixtures/voice/diagnose-3s.pcm
  // Built layout: dist/index.js → ../tests/fixtures/voice/diagnose-3s.pcm
  // We don't ship the fixture in dist/, so the built layout looks one level up.
  const candidates = [
    path.join(here, '..', '..', 'tests', 'fixtures', 'voice', 'diagnose-3s.pcm'),
    path.join(here, '..', 'tests', 'fixtures', 'voice', 'diagnose-3s.pcm'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new VoiceDiagnoseFixtureNotFoundError(
    `diagnose-3s.pcm not found in: ${candidates.join(', ')}. ` +
      'Run `~/.symphony/voice-env/bin/python tests/fixtures/voice/generate.py` ' +
      '(Win32: `~/.symphony/voice-env/Scripts/python tests/fixtures/voice/generate.py`) to regenerate.',
  );
}

export class VoicePythonPackageNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VoicePythonPackageNotFoundError';
  }
}

export class VoiceDiagnoseFixtureNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VoiceDiagnoseFixtureNotFoundError';
  }
}

/**
 * Phase 6C — locate the Phase 6C wake-word PCM fixture. Generated by
 * `tests/fixtures/voice/generate.py::build_wake_symphony()` and committed
 * to the repo (NOT shipped in dist/). Used by `symphony voice diagnose
 * --wake-word` + the 6C integration / scenario tests to drive the bridge
 * end-to-end without a real microphone.
 *
 * Same resolver shape as `voiceDiagnoseFixturePath` (6A).
 */
export function voiceWakeFixturePath(): string {
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, '..', '..', 'tests', 'fixtures', 'voice', 'wake-symphony-3s.pcm'),
    path.join(here, '..', 'tests', 'fixtures', 'voice', 'wake-symphony-3s.pcm'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new VoiceWakeFixtureNotFoundError(
    `wake-symphony-3s.pcm not found in: ${candidates.join(', ')}. ` +
      'Regenerate via the voice venv: ' +
      '`~/.symphony/voice-env/bin/python tests/fixtures/voice/generate.py` ' +
      '(Win32: `~/.symphony/voice-env/Scripts/python tests/fixtures/voice/generate.py`).',
  );
}

export class VoiceWakeFixtureNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VoiceWakeFixtureNotFoundError';
  }
}

export class VoiceVocabSeedNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VoiceVocabSeedNotFoundError';
  }
}

/**
 * Phase 6C — resolve the bundled wake-word ONNX model.
 *
 * Models live under `assets/wake-models/<name>.onnx` in the repo (dev) and
 * `dist/assets/wake-models/<name>.onnx` after `pnpm build` (tsup copyTree).
 * Walks `import.meta.url` candidates so both layouts resolve.
 *
 * `modelName` is the configured name (`voice.wakeWordModel`, default
 * `'hey-symphony'`) WITHOUT the `.onnx` suffix. Users dropping a custom
 * model at `~/.symphony/wake-models/<name>.onnx` are handled by a
 * separate user-override resolver (deferred until a real user wants it).
 *
 * Throws `VoiceWakeModelNotFoundError` when neither layout has the file —
 * fail-loud on packaging defects rather than handing the bridge a missing
 * path that errors on the first frame.
 */
export function voiceWakeModelPath(modelName: string): string {
  if (!isSafeModelName(modelName)) {
    throw new VoiceWakeModelNotFoundError(
      `invalid wake-word model name: ${JSON.stringify(modelName)}. ` +
        'Must be a single path segment (a-z, 0-9, dash, underscore).',
    );
  }
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  const filename = `${modelName}.onnx`;
  const candidates = [
    // Dev: src/voice/path.ts -> ../../assets/wake-models/<name>.onnx
    path.join(here, '..', '..', 'assets', 'wake-models', filename),
    // Built: dist/index.js -> dist/assets/wake-models/<name>.onnx
    path.join(here, 'assets', 'wake-models', filename),
    // Defensive: tarball-extracted dist sometimes has index.js one level up
    path.join(here, '..', 'assets', 'wake-models', filename),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new VoiceWakeModelNotFoundError(
    `wake-word model "${filename}" not found in: ${candidates.join(', ')}. ` +
      'Did `pnpm build` complete? Did training produce `assets/wake-models/' +
      `${filename}\`? See scripts/train-wake-word/README.md.`,
  );
}

/**
 * Validate that a wake-word model name is a single safe path segment.
 * Rejects: dots, slashes, backslashes, null, empty, anything that could
 * traverse out of `assets/wake-models/` via interpolation.
 *
 * Pattern: `^[a-z0-9][a-z0-9_-]{0,63}$` — same shape as Phase 5C's
 * task-id validator. Lowercase enforced so model files are portable
 * across case-sensitive (Linux) and case-insensitive (Win32, macOS-default)
 * filesystems.
 */
function isSafeModelName(name: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,63}$/.test(name);
}

export class VoiceWakeModelNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VoiceWakeModelNotFoundError';
  }
}

/** Test seam — strip env overrides so unit tests resolve from `~`. */
export function _voicePathsForTest(home: string = os.homedir()): {
  readonly envDir: string;
  readonly pythonPath: string;
  readonly binDir: string;
} {
  const envDir = path.join(home, '.symphony', 'voice-env');
  return {
    envDir,
    pythonPath: voicePythonPath(envDir),
    binDir: voiceBinDir(envDir),
  };
}
