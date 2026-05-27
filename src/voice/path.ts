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
