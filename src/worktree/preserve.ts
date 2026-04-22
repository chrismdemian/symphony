import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import { minimatch } from 'minimatch';

import { readSymphonyConfig } from './symphony-config.js';
import {
  DEFAULT_EXCLUDE_SEGMENTS,
  DEFAULT_PRESERVE_PATTERNS,
  type PreserveResult,
} from './types.js';
import { readWorktreeInclude } from './worktree-include.js';

const execFileAsync = promisify(execFile);

export type PreserveSource = 'worktreeinclude' | 'symphony.json' | 'defaults';

export interface ResolvedPreservePatterns {
  readonly patterns: readonly string[];
  readonly source: PreserveSource;
}

function hasPositives(patterns: readonly string[] | null | undefined): boolean {
  if (!patterns) return false;
  return patterns.some((p) => !p.startsWith('!'));
}

function negationsOf(patterns: readonly string[] | null | undefined): string[] {
  if (!patterns) return [];
  return patterns.filter((p) => p.startsWith('!'));
}

/**
 * Resolve preserve patterns via precedence:
 *
 *   1. `<projectPath>/.worktreeinclude`  (Claude Code Desktop convention;
 *      CLI parity is the whole reason this reader exists)
 *   2. `<projectPath>/.symphony.json` `preservePatterns`
 *   3. Built-in defaults (`.env`, `.envrc`, etc.)
 *
 * A layer that contains ONLY negations does not win — gitignore-style,
 * negations need a positive set to subtract from. Negations from skipped
 * layers ARE collected and appended to the chosen layer's positives so
 * `.worktreeinclude` of `!.env.example` correctly strips `.env.example`
 * from the defaults instead of silently preserving nothing.
 */
export function resolvePreservePatterns(projectPath: string): ResolvedPreservePatterns {
  const fromInclude = readWorktreeInclude(projectPath);
  const cfg = readSymphonyConfig(projectPath);
  const cfgPatterns = cfg?.preservePatterns;

  if (hasPositives(fromInclude)) {
    return { patterns: fromInclude!, source: 'worktreeinclude' };
  }
  if (hasPositives(cfgPatterns)) {
    const merged = [...cfgPatterns!, ...negationsOf(fromInclude)];
    return { patterns: merged, source: 'symphony.json' };
  }
  const merged = [
    ...DEFAULT_PRESERVE_PATTERNS,
    ...negationsOf(fromInclude),
    ...negationsOf(cfgPatterns),
  ];
  return { patterns: merged, source: 'defaults' };
}

/**
 * Build the pathspec list for `git ls-files -- <pathspec...>` from preserve
 * patterns. Adds a `**\/<pattern>` variant for every non-glob pattern so
 * nested files match the same way they do in `.gitignore`.
 *
 * Negation patterns (`!foo`) are kept verbatim for the later minimatch
 * filter; `git ls-files` would choke on them as pathspecs, so we strip
 * them here.
 */
export function buildPathspecs(patterns: readonly string[]): string[] {
  const set = new Set<string>();
  for (const raw of patterns) {
    if (raw.startsWith('!')) continue;
    const cleaned = raw.trim().replace(/\\/g, '/').replace(/^\.\//, '');
    if (cleaned.length === 0) continue;
    set.add(cleaned);
    if (!cleaned.startsWith('**/')) {
      set.add(`**/${cleaned}`);
    }
  }
  return [...set];
}

export function matchesPreservePattern(filePath: string, patterns: readonly string[]): boolean {
  const basename = path.basename(filePath);
  let matched = false;
  for (const raw of patterns) {
    if (raw.startsWith('!')) {
      const pat = raw.slice(1);
      if (
        minimatch(filePath, pat, { dot: true }) ||
        minimatch(basename, pat, { dot: true }) ||
        minimatch(filePath, `**/${pat}`, { dot: true })
      ) {
        matched = false;
      }
      continue;
    }
    if (
      minimatch(basename, raw, { dot: true }) ||
      minimatch(filePath, raw, { dot: true }) ||
      minimatch(filePath, `**/${raw}`, { dot: true })
    ) {
      matched = true;
    }
  }
  return matched;
}

export function isExcludedPath(
  filePath: string,
  excludeSegments: readonly string[] = DEFAULT_EXCLUDE_SEGMENTS,
): boolean {
  if (excludeSegments.length === 0) return false;
  const parts = filePath.split('/');
  for (const p of parts) {
    if (excludeSegments.includes(p)) return true;
  }
  return false;
}

async function gitListFiles(cwd: string, args: readonly string[]): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync('git', [...args], {
      cwd,
      maxBuffer: 10 * 1024 * 1024,
    });
    return stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
  } catch {
    return [];
  }
}

/**
 * List candidate files in `dir` that match any preserve pattern. Queries
 * both gitignored (`--ignored`) and untracked (non-ignored) files in
 * parallel and dedupes via a Set — the former catches `.env`, the latter
 * catches `.envrc`-style files that are neither tracked nor gitignored.
 */
export async function getPreserveCandidateFiles(
  dir: string,
  patterns: readonly string[],
): Promise<string[]> {
  const pathspecs = buildPathspecs(patterns);
  if (pathspecs.length === 0) return [];
  const [ignored, untracked] = await Promise.all([
    gitListFiles(dir, [
      'ls-files',
      '--others',
      '--ignored',
      '--exclude-standard',
      '--',
      ...pathspecs,
    ]),
    gitListFiles(dir, ['ls-files', '--others', '--exclude-standard', '--', ...pathspecs]),
  ]);
  return [...new Set([...ignored, ...untracked])];
}

async function copyFileExclusive(
  sourcePath: string,
  destPath: string,
): Promise<'copied' | 'skipped' | 'error'> {
  try {
    if (fs.existsSync(destPath)) return 'skipped';
    const destDir = path.dirname(destPath);
    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true });
    }
    const content = fs.readFileSync(sourcePath);
    const stat = fs.statSync(sourcePath);
    fs.writeFileSync(destPath, content, { mode: stat.mode });
    return 'copied';
  } catch {
    return 'error';
  }
}

export interface PreserveOptions {
  readonly excludeSegments?: readonly string[];
}

/**
 * Copy files from `sourceDir` into `destDir` whose relative paths match
 * any `patterns` entry and do not sit under an excluded segment. Skips
 * files that already exist at the destination (never overwrites).
 */
export async function preserveFilesToWorktree(
  sourceDir: string,
  destDir: string,
  patterns: readonly string[],
  options: PreserveOptions = {},
): Promise<PreserveResult> {
  const copied: string[] = [];
  const skipped: string[] = [];
  if (patterns.length === 0) return { copied, skipped };

  const excludeSegments = options.excludeSegments ?? DEFAULT_EXCLUDE_SEGMENTS;
  const candidates = await getPreserveCandidateFiles(sourceDir, patterns);
  if (candidates.length === 0) return { copied, skipped };

  const toCopy: string[] = [];
  for (const rel of candidates) {
    if (isExcludedPath(rel, excludeSegments)) continue;
    if (matchesPreservePattern(rel, patterns)) toCopy.push(rel);
  }

  for (const rel of toCopy) {
    const src = path.join(sourceDir, rel);
    const dest = path.join(destDir, rel);
    if (!fs.existsSync(src)) continue;
    const result = await copyFileExclusive(src, dest);
    if (result === 'copied') copied.push(rel);
    else if (result === 'skipped') skipped.push(rel);
  }
  return { copied, skipped };
}
