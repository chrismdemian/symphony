import { existsSync } from 'node:fs';
import os from 'node:os';

import { voiceBinDir, voiceEnvDir, voicePythonPath } from './path.js';

/**
 * Phase 6A — env builder for the voice bridge subprocess.
 *
 * Distinct from `src/workers/env.ts`'s `buildWorkerEnv` because:
 *   - Voice bridge is ONE long-lived process per Symphony session, not
 *     a per-worker spawn.
 *   - Voice bridge needs the venv's `VIRTUAL_ENV` + a `PATH` prefix to
 *     resolve `python` / `pip` to the venv binaries.
 *   - Voice bridge does NOT need Anthropic / cloud-tool env (no API keys
 *     reach the Python side by design — fully local STT/VAD).
 *
 * Allowlist is narrow on purpose. Adds: no `ANTHROPIC_*`, no `GH_TOKEN`,
 * no `AWS_*`. The Python bridge has zero need for any of these — every
 * dep is local. Blocking them defends against a future supply-chain
 * attack on `silero-vad` / `sounddevice` from exfiltrating credentials
 * the user already has in process env.
 */

/** Positive env-var allowlist for the voice-bridge subprocess. */
export const VOICE_ENV_ALLOWLIST: readonly string[] = [
  // Locale (filtered to UTF-8 by isUtf8Locale)
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  // POSIX hosting
  'HOME',
  'USER',
  'SHELL',
  'TERM',
  'TMPDIR',
  // Network — Silero ONNX downloads model weights on first use via
  // torch.hub or pip; HuggingFace HF_HOME may be set by the user to
  // pre-cache. Honor http(s)_proxy so corp networks work.
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'HF_HOME',
  'HF_HUB_CACHE',
  'XDG_CACHE_HOME',
  // Audio backend selection — let the user force one
  'SYMPHONY_VOICE_BACKEND',
];

const DEFAULT_UTF8_LOCALE = 'C.UTF-8';

export interface VoiceEnvSummary {
  /** Absolute path to the venv directory. May not exist yet. */
  readonly venvDir: string;
  /** Absolute path to the venv's python interpreter. May not exist yet. */
  readonly pythonPath: string;
  /** Absolute path to the venv's bin/Scripts dir. May not exist yet. */
  readonly binDir: string;
  /** True when `pythonPath` exists on disk. */
  readonly exists: boolean;
}

/** Probe the voice venv layout; returns existence info without throwing. */
export function resolveVoiceEnv(home?: string): VoiceEnvSummary {
  const venvDir = voiceEnvDir(home);
  const pythonPath = voicePythonPath(venvDir);
  const binDir = voiceBinDir(venvDir);
  return {
    venvDir,
    pythonPath,
    binDir,
    exists: existsSync(pythonPath),
  };
}

export interface BuildVoiceEnvInput {
  readonly venvDir?: string;
  readonly sourceEnv?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly homeDir?: string;
}

export interface BuildVoiceEnvResult {
  readonly env: Record<string, string>;
  /** Keys present on `sourceEnv` that were dropped (for debug logging). */
  readonly droppedKeys: readonly string[];
}

/**
 * Build the env Object passed to `child_process.spawn` when launching
 * the Python voice bridge.
 *
 * Strategy mirrors `buildWorkerEnv`:
 *   1. Walk the allowlist; copy values present on `sourceEnv`.
 *   2. Add platform-specific essentials (PATH/PATHEXT on Win32).
 *   3. Inject venv activation (`VIRTUAL_ENV` + `PATH` prefix).
 *   4. Guarantee a UTF-8 locale on POSIX.
 *   5. Set `PYTHONUNBUFFERED=1` so stdout JSON events flush
 *      line-by-line (the JSON-line protocol's load-bearing assumption).
 */
export function buildVoiceEnv(input: BuildVoiceEnvInput = {}): BuildVoiceEnvResult {
  const source = input.sourceEnv ?? process.env;
  const platform = input.platform ?? process.platform;
  const home = input.homeDir ?? os.homedir();
  const venvDir = input.venvDir ?? voiceEnvDir(home);
  const env: Record<string, string> = {};
  const dropped: string[] = [];

  for (const [key, value] of Object.entries(source)) {
    if (typeof value !== 'string' || value.length === 0) continue;
    if (!VOICE_ENV_ALLOWLIST.includes(key)) {
      dropped.push(key);
      continue;
    }
    if (isLocaleKey(key) && !isUtf8Locale(value)) {
      dropped.push(key);
      continue;
    }
    env[key] = value;
  }

  // Platform essentials
  if (platform === 'win32') {
    const pathValue = source.PATH ?? source.Path ?? '';
    env.PATH = pathValue;
    env.PATHEXT =
      source.PATHEXT ?? '.COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC';
    env.SystemRoot = source.SystemRoot ?? 'C:\\Windows';
    env.ComSpec = source.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe';
    if (typeof source.USERPROFILE === 'string') env.USERPROFILE = source.USERPROFILE;
    else env.USERPROFILE = home;
    if (typeof source.LOCALAPPDATA === 'string' && source.LOCALAPPDATA.length > 0) {
      env.LOCALAPPDATA = source.LOCALAPPDATA;
    }
    if (typeof source.APPDATA === 'string' && source.APPDATA.length > 0) {
      env.APPDATA = source.APPDATA;
    }
    if (typeof source.TEMP === 'string' && source.TEMP.length > 0) {
      env.TEMP = source.TEMP;
    }
    if (typeof source.TMP === 'string' && source.TMP.length > 0) {
      env.TMP = source.TMP;
    }
  } else {
    const pathValue = source.PATH;
    if (typeof pathValue === 'string' && pathValue.length > 0) {
      env.PATH = pathValue;
    } else {
      env.PATH = '/usr/local/bin:/usr/bin:/bin';
    }
    if (env.LANG === undefined && env.LC_ALL === undefined && env.LC_CTYPE === undefined) {
      env.LANG = DEFAULT_UTF8_LOCALE;
      env.LC_CTYPE = DEFAULT_UTF8_LOCALE;
    }
  }

  // Venv activation. `VIRTUAL_ENV` + PATH prefix is what `python -m venv`
  // does in its activate scripts. We replicate it without sourcing the
  // shell script. Mirrors how every Python venv launcher works.
  env.VIRTUAL_ENV = venvDir;
  const binDir = voiceBinDir(venvDir, platform);
  const existingPath = env.PATH ?? '';
  const pathSeparator = platform === 'win32' ? ';' : ':';
  env.PATH =
    existingPath.length > 0 ? `${binDir}${pathSeparator}${existingPath}` : binDir;

  // PYTHONUNBUFFERED=1 → stdout/stderr are unbuffered. The JSON-line
  // protocol REQUIRES each event flushes before the next read. Without
  // this, Python buffers stdout when not attached to a TTY and the
  // bridge appears to hang.
  env.PYTHONUNBUFFERED = '1';
  // Pin a deterministic locale for Python's str/bytes handling.
  env.PYTHONIOENCODING = 'utf-8';

  return { env, droppedKeys: dropped };
}

function isLocaleKey(key: string): boolean {
  return key === 'LANG' || key === 'LC_ALL' || key === 'LC_CTYPE';
}

function isUtf8Locale(value: string): boolean {
  const lower = value.toLowerCase();
  return (
    lower.includes('utf-8') ||
    lower.includes('utf8') ||
    lower === 'c.utf-8' ||
    lower === 'en_us.utf-8'
  );
}

// Re-export `path` consumers via path.ts; intentionally not re-exporting here.
// Test seam: `_voicePathsForTest` lives in path.ts.
export { voiceEnvDir, voicePythonPath, voiceBinDir };
