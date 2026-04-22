import { accessSync, constants, statSync } from 'node:fs';
import path from 'node:path';

/**
 * Resolve a command to an absolute executable path. Walks `PATH` and, on
 * Windows, tries every suffix from `PATHEXT`. Returns `null` if nothing
 * executable matches. Results are cached per (command, platform, PATH).
 */
export interface ResolveCommandOptions {
  platform?: NodeJS.Platform;
  sourceEnv?: NodeJS.ProcessEnv;
  cache?: Map<string, string | null>;
}

export function resolveCommandPath(
  command: string,
  options: ResolveCommandOptions = {},
): string | null {
  const trimmed = command.trim();
  if (trimmed.length === 0) return null;
  const platform = options.platform ?? process.platform;
  const source = options.sourceEnv ?? process.env;
  const cache = options.cache ?? defaultCache;

  const cacheKey = `${platform}::${source.PATH ?? ''}::${source.PATHEXT ?? ''}::${trimmed}`;
  const cached = cache.get(cacheKey);
  if (cached !== undefined) return cached;

  const result = resolveUncached(trimmed, platform, source);
  cache.set(cacheKey, result);
  return result;
}

function resolveUncached(
  trimmed: string,
  platform: NodeJS.Platform,
  source: NodeJS.ProcessEnv,
): string | null {
  const pathLike =
    trimmed.includes('/') ||
    trimmed.includes('\\') ||
    trimmed.startsWith('.') ||
    /^[A-Za-z]:/.test(trimmed);

  if (pathLike) {
    const candidates = appendWindowsExts(trimmed, platform, source);
    for (const candidate of candidates) {
      const abs = path.resolve(candidate);
      if (isExecutableFile(abs, platform)) return abs;
    }
    return null;
  }

  const pathEnv = source.PATH ?? (platform === 'win32' ? source.Path : undefined);
  if (pathEnv === undefined || pathEnv.length === 0) return null;

  const dirs = pathEnv.split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const base = path.join(dir, trimmed);
    const candidates = appendWindowsExts(base, platform, source);
    for (const candidate of candidates) {
      if (isExecutableFile(candidate, platform)) return candidate;
    }
  }
  return null;
}

function appendWindowsExts(
  base: string,
  platform: NodeJS.Platform,
  source: NodeJS.ProcessEnv,
): string[] {
  if (platform !== 'win32') return [base];
  if (path.extname(base).length > 0) return [base];
  const pathExt = source.PATHEXT ?? '.COM;.EXE;.BAT;.CMD';
  const exts = pathExt
    .split(';')
    .map((ext) => ext.trim())
    .filter((ext) => ext.length > 0);
  return [base, ...exts.map((ext) => `${base}${ext.toLowerCase()}`)];
}

function isExecutableFile(candidate: string, platform: NodeJS.Platform): boolean {
  try {
    const stat = statSync(candidate);
    if (!stat.isFile()) return false;
    if (platform === 'win32') return true;
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

const defaultCache = new Map<string, string | null>();

/**
 * Resolve the `claude` executable. Defaults to whatever's on PATH; if the
 * caller passes an explicit absolute path, that's used directly. Returns the
 * resolved path if found, otherwise the original input so `child_process.spawn`
 * reports its own error.
 */
export function resolveClaudePath(
  command: string | undefined,
  options: ResolveCommandOptions = {},
): string {
  const input = command ?? 'claude';
  const resolved = resolveCommandPath(input, options);
  return resolved ?? input;
}

/** @internal testing only */
export function _clearResolveCache(): void {
  defaultCache.clear();
}
