import os from 'node:os';

// Keys pulled through from process.env when present. Keep this list Symphony-
// relevant — arbitrary additions belong in WorkerConfig.extraEnv (which the
// caller owns explicitly).
const ALLOWLIST: readonly string[] = [
  // Auth for Claude itself
  'ANTHROPIC_API_KEY',
  'CLAUDE_CONFIG_DIR',
  // Tools workers may shell to
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GOOGLE_API_KEY',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_DEFAULT_REGION',
  'AWS_PROFILE',
  'AWS_REGION',
  // Network
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  // Locale (filtered to UTF-8 via isUtf8Locale below)
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  // Unix hosting
  'HOME',
  'USER',
  'SHELL',
  'TERM',
  'TMPDIR',
];

// Keys that user-supplied `extraEnv` MUST NOT override. Over-reaching here is
// safer than under-reaching — these are keys that would break Symphony's
// contract with the worker or leak parent-process identity.
const EXTRA_ENV_BLOCKLIST: readonly string[] = [
  'HOME',
  'PATH',
  'USER',
  'SHELL',
  'TERM',
];

const EXTRA_ENV_BLOCKLIST_PREFIXES: readonly string[] = [
  'CLAUDECODE',
  'CLAUDE_CODE_',
  'SYMPHONY_',
];

// Claude Code sets these in its own subprocess env (`CLAUDECODE=1`,
// `CLAUDE_CODE_ENTRYPOINT=...`). When Symphony itself is invoked from within
// a Claude Code session, we must strip them from the inherited env so spawned
// workers don't think they're nested Claude Code sessions.
const CLAUDECODE_POLLUTION_PREFIXES = ['CLAUDECODE', 'CLAUDE_CODE_'] as const;

const DEFAULT_UTF8_LOCALE = 'C.UTF-8';

export interface BuildWorkerEnvInput {
  extraEnv?: Record<string, string>;
  sourceEnv?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  onBlocklistHit?: (key: string) => void;
}

export interface BuildWorkerEnvResult {
  env: Record<string, string>;
  blockedKeys: string[];
}

export function buildWorkerEnv(input: BuildWorkerEnvInput = {}): BuildWorkerEnvResult {
  const source = input.sourceEnv ?? process.env;
  const platform = input.platform ?? process.platform;
  const env: Record<string, string> = {};

  for (const key of ALLOWLIST) {
    const value = source[key];
    if (typeof value !== 'string' || value.length === 0) continue;
    if (isLocaleKey(key) && !isUtf8Locale(value)) continue;
    env[key] = value;
  }

  if (platform === 'win32') {
    Object.assign(env, getWindowsEssentialEnv(source));
  } else {
    const pathValue = source.PATH;
    if (typeof pathValue === 'string' && pathValue.length > 0) {
      env.PATH = pathValue;
    }
    // Guarantee a UTF-8 locale is present on non-Windows so child stdout is
    // decoded consistently.
    if (env.LANG === undefined && env.LC_ALL === undefined && env.LC_CTYPE === undefined) {
      env.LANG = DEFAULT_UTF8_LOCALE;
      env.LC_CTYPE = DEFAULT_UTF8_LOCALE;
    }
  }

  const blocked: string[] = [];
  if (input.extraEnv !== undefined) {
    for (const [key, value] of Object.entries(input.extraEnv)) {
      if (isExtraEnvBlocked(key)) {
        blocked.push(key);
        input.onBlocklistHit?.(key);
        continue;
      }
      if (typeof value === 'string') env[key] = value;
    }
  }

  // Defensive: any allowlist leak or extraEnv-with-prefix sneak must be
  // stripped before spawn. Parent Claude Code pollution would otherwise
  // confuse nested workers.
  for (const key of Object.keys(env)) {
    if (CLAUDECODE_POLLUTION_PREFIXES.some((p) => key.startsWith(p))) {
      delete env[key];
    }
  }

  return { env, blockedKeys: blocked };
}

export function getWindowsEssentialEnv(
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const home = os.homedir();
  const pathValue = source.PATH ?? source.Path ?? '';
  const env: Record<string, string> = {
    PATH: pathValue,
    PATHEXT: source.PATHEXT ?? '.COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC',
    SystemRoot: source.SystemRoot ?? 'C:\\Windows',
    ComSpec: source.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe',
    TEMP: source.TEMP ?? source.TMP ?? '',
    TMP: source.TMP ?? source.TEMP ?? '',
    USERPROFILE: source.USERPROFILE ?? home,
    APPDATA: source.APPDATA ?? '',
    LOCALAPPDATA: source.LOCALAPPDATA ?? '',
    HOMEDRIVE: source.HOMEDRIVE ?? '',
    HOMEPATH: source.HOMEPATH ?? '',
    USERNAME: source.USERNAME ?? os.userInfo().username,
    ProgramFiles: source.ProgramFiles ?? 'C:\\Program Files',
    'ProgramFiles(x86)': source['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)',
    ProgramData: source.ProgramData ?? 'C:\\ProgramData',
    CommonProgramFiles: source.CommonProgramFiles ?? 'C:\\Program Files\\Common Files',
    'CommonProgramFiles(x86)':
      source['CommonProgramFiles(x86)'] ?? 'C:\\Program Files (x86)\\Common Files',
    ProgramW6432: source.ProgramW6432 ?? 'C:\\Program Files',
    CommonProgramW6432: source.CommonProgramW6432 ?? 'C:\\Program Files\\Common Files',
  };
  // Scrub empty strings we know are optional — they'd confuse child processes.
  for (const key of ['TEMP', 'TMP', 'APPDATA', 'LOCALAPPDATA', 'HOMEDRIVE', 'HOMEPATH']) {
    if (env[key] === '') delete env[key];
  }
  return env;
}

export function isExtraEnvBlocked(key: string): boolean {
  if (EXTRA_ENV_BLOCKLIST.includes(key)) return true;
  return EXTRA_ENV_BLOCKLIST_PREFIXES.some((prefix) => key.startsWith(prefix));
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

export { ALLOWLIST as ENV_ALLOWLIST };
