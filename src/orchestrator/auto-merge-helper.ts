import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  mergeBranch,
  MergeBranchOptions,
  MergeResult,
} from './git-ops.js';
import type { WorktreeManager } from '../worktree/manager.js';

/**
 * Phase 3O.1 — pure helpers for the AutoMergeDispatcher.
 *
 * Three concerns:
 *   1. `parseYesNo` — strict y/yes vs n/no parsing, case-insensitive.
 *      Returns `null` for unclear answers so the dispatcher can fail-safe
 *      to "declined" with a `unclearAnswer` field in the emitted event.
 *
 *   2. `resolveDefaultMergeTo` — best-effort default-branch detection.
 *      Tries `git symbolic-ref --quiet refs/remotes/origin/HEAD` first
 *      (the canonical "origin's default branch" marker; set by `git
 *      clone` and `git remote set-head`). Falls back to local `main`,
 *      then `master`, then unconditionally `'master'`. Mirrors the
 *      pattern in `src/worktree/manager.ts:resolveBaseRef:400-435` —
 *      simplified because we only need a short branch name.
 *
 *   3. `performMergeAndCleanup` — composes `gitOps.mergeBranch` +
 *      `WorktreeManager.remove({deleteBranch:true})`. Merge failure
 *      leaves the worktree intact; cleanup failure AFTER successful
 *      merge is reported but does NOT mask the merge sha (irreversible
 *      operation already landed).
 */

const execFileAsync = promisify(execFile);

/**
 * Parse a free-text user answer as yes / no / unclear.
 * - 'y', 'yes' (any case + surrounding whitespace) → `'yes'`
 * - 'n', 'no'  (any case + surrounding whitespace) → `'no'`
 * - everything else → `null` (caller fail-safes to declined-with-warning)
 */
export function parseYesNo(raw: string): 'yes' | 'no' | null {
  const s = raw.trim().toLowerCase();
  if (s === 'y' || s === 'yes') return 'yes';
  if (s === 'n' || s === 'no') return 'no';
  return null;
}

/**
 * Resolve the default branch to merge INTO. Tries (in order):
 *   1. `git symbolic-ref --quiet refs/remotes/origin/HEAD` — strip
 *      `refs/remotes/origin/` prefix.
 *   2. Local `main` (via `git rev-parse --verify --quiet refs/heads/main`).
 *   3. Local `master`.
 *   4. Hard-coded `'master'` as ultimate fallback.
 *
 * The signal is threaded so a dispatcher shutdown mid-resolution
 * cancels cleanly. Each git call swallows its own errors and falls
 * through to the next candidate — never throws.
 */
export async function resolveDefaultMergeTo(
  repoPath: string,
  signal?: AbortSignal,
): Promise<string> {
  const execOpts = {
    cwd: repoPath,
    ...(signal !== undefined ? { signal } : {}),
  };

  try {
    const { stdout } = await execFileAsync(
      'git',
      ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'],
      execOpts,
    );
    const trimmed = stdout.trim();
    const prefix = 'refs/remotes/origin/';
    if (trimmed.startsWith(prefix) && trimmed.length > prefix.length) {
      return trimmed.slice(prefix.length);
    }
  } catch {
    // No origin/HEAD set — try local fallbacks.
  }

  for (const candidate of ['main', 'master']) {
    try {
      await execFileAsync(
        'git',
        ['rev-parse', '--verify', '--quiet', `refs/heads/${candidate}`],
        execOpts,
      );
      return candidate;
    } catch {
      // Not present — try next.
    }
  }

  return 'master';
}

/**
 * Subset of WorktreeManager we depend on. Test seam — fakes can
 * implement just the methods needed.
 */
export interface WorktreeRemover {
  remove: WorktreeManager['remove'];
}

/**
 * Subset of git-ops we depend on. Test seam.
 */
export interface AutoMergeGitOps {
  mergeBranch: typeof mergeBranch;
}

export interface PerformMergeInput {
  readonly worktreePath: string;
  readonly repoPath: string;
  readonly sourceBranch: string;
  readonly mergeTo: string;
  readonly sourceRemote?: string;
  readonly signal?: AbortSignal;
}

export interface PerformMergeSuccess {
  readonly ok: true;
  readonly mergeSha: string;
  readonly deletedRemoteBranch: boolean;
  /** Set when the merge succeeded but worktree cleanup threw. */
  readonly cleanupError?: Error;
}

export interface PerformMergeFailure {
  readonly ok: false;
  readonly error: Error;
}

export type PerformMergeResult = PerformMergeSuccess | PerformMergeFailure;

/**
 * Execute the merge step + worktree cleanup. Composition:
 *   1. `gitOps.mergeBranch(...)` — runs fetch / checkout target / pull
 *      --ff-only / merge --no-ff / push / delete remote branch in
 *      `repoPath`. Throws `MergeConflictError` or `GitOpsError` on
 *      failure; worktree left intact for inspection.
 *   2. On success, `worktreeManager.remove(worktreePath, {deleteBranch:
 *      true})` — handles `git worktree remove --force` + prune + fs-rm
 *      + local-branch delete. Held under the project lock.
 *   3. Cleanup failure DOES NOT mask merge success. The merge sha is in
 *      the return alongside an optional `cleanupError`. Caller emits a
 *      `merged` event with a `cleanupWarning` field.
 *
 * Pre-merge failures (conflict, push reject, fetch network error)
 * return `{ ok: false, error }` with the typed git-ops error preserved
 * for the caller to inspect (e.g., to phrase the system row).
 */
export async function performMergeAndCleanup(
  input: PerformMergeInput,
  gitOps: AutoMergeGitOps,
  worktreeManager: WorktreeRemover,
): Promise<PerformMergeResult> {
  const mergeOpts: MergeBranchOptions = {
    repoPath: input.repoPath,
    targetBranch: input.mergeTo,
    sourceBranch: input.sourceBranch,
    deleteRemoteBranch: true,
    ...(input.sourceRemote !== undefined ? { sourceRemote: input.sourceRemote } : {}),
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
  };

  let merge: MergeResult;
  try {
    merge = await gitOps.mergeBranch(mergeOpts);
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }

  // Merge succeeded — worktree cleanup is best-effort.
  let cleanupError: Error | undefined;
  try {
    await worktreeManager.remove(input.worktreePath, { deleteBranch: true });
  } catch (err) {
    cleanupError = err instanceof Error ? err : new Error(String(err));
  }

  return {
    ok: true,
    mergeSha: merge.mergeSha,
    deletedRemoteBranch: merge.deletedRemoteBranch,
    ...(cleanupError !== undefined ? { cleanupError } : {}),
  };
}
