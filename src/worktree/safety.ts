import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface WorktreeSafetyContext {
  readonly worktreePath: string;
  readonly projectPath: string;
}

export class WorktreeSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorktreeSafetyError';
  }
}

const WORKTREE_SEGMENT_PATTERNS: ReadonlyArray<RegExp> = [
  /[\\/]\.symphony[\\/]worktrees[\\/]/,
  /[\\/]worktrees[\\/]/,
];

export function pathResolvesEqual(a: string, b: string): boolean {
  return path.resolve(a) === path.resolve(b);
}

export function looksLikeManagedWorktree(worktreePath: string): boolean {
  const normalized = path.resolve(worktreePath);
  return WORKTREE_SEGMENT_PATTERNS.some((re) => re.test(normalized));
}

interface PorcelainWorktree {
  readonly worktreePath: string;
  readonly isMain: boolean;
  readonly isBare: boolean;
}

export function parseWorktreePorcelain(stdout: string): PorcelainWorktree[] {
  const result: PorcelainWorktree[] = [];
  const blocks = stdout.split(/\r?\n\r?\n/);
  let blockIndex = 0;
  for (const block of blocks) {
    const lines = block.split(/\r?\n/).filter((l) => l.length > 0);
    let worktreePath: string | undefined;
    let isBare = false;
    for (const line of lines) {
      if (line.startsWith('worktree ')) {
        worktreePath = line.substring('worktree '.length);
      } else if (line === 'bare') {
        isBare = true;
      }
    }
    if (worktreePath) {
      result.push({ worktreePath, isMain: blockIndex === 0, isBare });
      blockIndex += 1;
    }
  }
  return result;
}

export interface AssertRemovableOptions {
  readonly runGit?: (args: readonly string[], cwd: string) => Promise<string>;
}

async function defaultRunGit(args: readonly string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', [...args], { cwd });
  return stdout;
}

/**
 * Three-layer guard against catastrophic rm -rf of the main repo.
 *
 *   1. Path resolve equality check — reject the exact project path.
 *   2. Containment check — path must sit under a managed worktrees/ segment.
 *   3. Porcelain check — `git worktree list --porcelain` confirms it is a
 *      linked, non-main, non-bare worktree.
 *
 * Throws WorktreeSafetyError on any failed check.
 */
export async function assertWorktreeRemovable(
  ctx: WorktreeSafetyContext,
  options: AssertRemovableOptions = {},
): Promise<void> {
  const { worktreePath, projectPath } = ctx;

  if (pathResolvesEqual(worktreePath, projectPath)) {
    throw new WorktreeSafetyError(
      `Refusing to remove path equal to projectPath: ${worktreePath}`,
    );
  }

  if (!looksLikeManagedWorktree(worktreePath)) {
    throw new WorktreeSafetyError(
      `Refusing to remove path that does not look like a managed worktree: ${worktreePath}`,
    );
  }

  const runGit = options.runGit ?? defaultRunGit;
  let porcelain: string;
  try {
    porcelain = await runGit(['worktree', 'list', '--porcelain'], projectPath);
  } catch (err) {
    throw new WorktreeSafetyError(
      `Could not verify worktree via git porcelain: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const parsed = parseWorktreePorcelain(porcelain);
  const resolvedTarget = path.resolve(worktreePath);
  const match = parsed.find((w) => path.resolve(w.worktreePath) === resolvedTarget);
  if (!match) {
    throw new WorktreeSafetyError(
      `Path is not a linked worktree of ${projectPath}: ${worktreePath}`,
    );
  }
  if (match.isMain) {
    throw new WorktreeSafetyError(
      `Refusing to remove main worktree: ${worktreePath}`,
    );
  }
  if (match.isBare) {
    throw new WorktreeSafetyError(
      `Refusing to remove bare worktree: ${worktreePath}`,
    );
  }
}
