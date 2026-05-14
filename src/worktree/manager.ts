import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

function randomSuffix(): string {
  return randomBytes(3).toString('hex');
}

import { excludeFromGit } from './exclude.js';
import { ProjectLockRegistry } from './locks.js';
import { preserveFilesToWorktree, resolvePreservePatterns } from './preserve.js';
import { ensureProjectPrepared } from './project-prep.js';
import {
  assertWorktreeRemovable,
  parseWorktreePorcelain,
  WorktreeSafetyError,
} from './safety.js';
import { readSymphonyConfig } from './symphony-config.js';
import {
  DEFAULT_GIT_EXCLUDE_PATTERNS,
  type CreateWorktreeOptions,
  type RemoveWorktreeOptions,
  type WorktreeInfo,
  type WorktreeManagerConfig,
  type WorktreePoolHandle,
  type WorktreeStatus,
} from './types.js';

const execFileAsync = promisify(execFile);

const DEFAULT_BRANCH_PREFIX = 'symphony';

/**
 * Phase 3Q — outcome of `WorktreeManager.removeAllForProject`. `removed`
 * lists worktrees that `git worktree remove` succeeded on; `skipped`
 * carries per-tree errors (e.g. a worker still locking the directory on
 * Win32) so the caller can surface them to the user without aborting
 * the whole sweep.
 */
export interface RemoveAllForProjectResult {
  readonly removed: readonly string[];
  readonly skipped: ReadonlyArray<{ readonly path: string; readonly reason: string }>;
}

export interface WorktreeManagerEvents {
  /** Fired inside the project lock at the start of `createUnlocked`. */
  onCreateStart?: (info: { workerId: string; projectPath: string }) => void;
  /** Fired inside the project lock once `createUnlocked` has fully resolved. */
  onCreateEnd?: (info: { workerId: string; projectPath: string }) => void;
  /** Fired after preserve-copy. Useful for tests + observability. */
  onPreserveResult?: (info: { worktreePath: string; copied: readonly string[]; skipped: readonly string[] }) => void;
  /** Fired after project-prep dispatch (whether or not it actually spawned). */
  onProjectPrep?: (info: { worktreePath: string; detected: string | null; spawned: boolean }) => void;
  /** Fired after a successful pool claim (before returning from create). */
  onPoolClaim?: (info: { worktreePath: string; workerId: string; projectPath: string }) => void;
  /** Fired when the pool was asked but returned null and we fell back to sync creation. */
  onPoolFallback?: (info: {
    workerId: string;
    projectPath: string;
    reason: 'disabled' | 'missing-pool' | 'claim-miss';
  }) => void;
}

export class WorktreeManager {
  private readonly locks: ProjectLockRegistry;
  private readonly branchPrefix: string;
  private readonly runProjectPrep: boolean;
  private readonly excludePatterns: readonly string[];
  private readonly events: WorktreeManagerEvents;
  private readonly pool: WorktreePoolHandle | undefined;

  constructor(config: WorktreeManagerConfig & { events?: WorktreeManagerEvents; locks?: ProjectLockRegistry } = {}) {
    this.branchPrefix = config.branchPrefix ?? DEFAULT_BRANCH_PREFIX;
    this.runProjectPrep = config.runProjectPrep ?? true;
    this.excludePatterns = config.excludePatterns ?? DEFAULT_GIT_EXCLUDE_PATTERNS;
    this.events = config.events ?? {};
    this.pool = config.pool;
    this.locks = config.locks ?? new ProjectLockRegistry();
  }

  async create(opts: CreateWorktreeOptions): Promise<WorktreeInfo> {
    const { workerId } = opts;
    if (!workerId.trim()) {
      throw new Error('WorktreeManager.create: workerId is required');
    }

    // Phase 2A.3 audit M2: entrance check lets callers fast-fail without
    // touching disk. A post-create check below cleans up if the signal
    // fires while `git worktree add` is running.
    if (opts.signal?.aborted) {
      throw new Error(
        `WorktreeManager.create aborted before disk IO (workerId=${workerId})`,
      );
    }

    const info = await this.createInternal(opts);

    if (opts.signal?.aborted) {
      // Best-effort cleanup. If removal fails, surface the abort error — the
      // orphan will be swept by `cleanupOrphanedReserves` on next startup.
      try {
        await this.remove(info.path);
      } catch {
        /* best effort */
      }
      throw new Error(
        `WorktreeManager.create aborted after worktree materialized at ${info.path}; cleanup attempted`,
      );
    }

    return info;
  }

  private async createInternal(opts: CreateWorktreeOptions): Promise<WorktreeInfo> {
    const { projectPath, workerId } = opts;

    const poolEnabled = isPoolEnabled(projectPath);
    if (this.pool && poolEnabled) {
      try {
        const claimed = await this.pool.claimReserve({
          projectPath,
          workerId,
          shortDescription: opts.shortDescription,
          baseRef: opts.baseRef,
          branchPrefix: this.branchPrefix,
          excludePatterns: this.excludePatterns,
          skipPreserve: opts.skipPreserve,
          skipProjectPrep: opts.skipProjectPrep,
          runProjectPrep: this.runProjectPrep,
          onPreserveResult: this.events.onPreserveResult,
          onProjectPrep: this.events.onProjectPrep,
        });
        if (claimed) {
          this.events.onPoolClaim?.({
            worktreePath: claimed.path,
            workerId,
            projectPath,
          });
          return claimed;
        }
        this.events.onPoolFallback?.({ workerId, projectPath, reason: 'claim-miss' });
      } catch (err) {
        console.warn(
          `[worktree] pool claim threw; falling back to sync create: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        this.events.onPoolFallback?.({ workerId, projectPath, reason: 'claim-miss' });
      }
    }

    return this.locks.withLock(projectPath, async () => {
      this.events.onCreateStart?.({ workerId, projectPath });
      try {
        return await this.createUnlocked(opts);
      } finally {
        this.events.onCreateEnd?.({ workerId, projectPath });
      }
    });
  }

  private async createUnlocked(opts: CreateWorktreeOptions): Promise<WorktreeInfo> {
    const { projectPath, workerId } = opts;
    const slug = slugify(opts.shortDescription ?? '');
    const baseBranch = slug
      ? `${this.branchPrefix}/${workerId}/${slug}`
      : `${this.branchPrefix}/${workerId}`;
    const worktreePath = path.join(projectPath, '.symphony', 'worktrees', workerId);

    if (fs.existsSync(worktreePath)) {
      throw new Error(`Worktree path already exists: ${worktreePath}`);
    }
    fs.mkdirSync(path.dirname(worktreePath), { recursive: true });

    const baseRefFull = await resolveBaseRef(projectPath, opts.baseRef);
    const finalBranch = await addWorktreeWithCollisionRetry({
      projectPath,
      worktreePath,
      branch: baseBranch,
      baseRef: baseRefFull,
    });

    try {
      await excludeFromGit(worktreePath, this.excludePatterns);
    } catch (err) {
      console.warn(
        `[worktree] failed to write .git/info/exclude for ${worktreePath}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    if (!opts.skipPreserve) {
      try {
        const resolved = resolvePreservePatterns(projectPath);
        const result = await preserveFilesToWorktree(
          projectPath,
          worktreePath,
          resolved.patterns,
        );
        this.events.onPreserveResult?.({
          worktreePath,
          copied: result.copied,
          skipped: result.skipped,
        });
      } catch (err) {
        console.warn(
          `[worktree] preserve step failed for ${worktreePath}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    if (this.runProjectPrep && !opts.skipProjectPrep) {
      const prep = ensureProjectPrepared(worktreePath);
      this.events.onProjectPrep?.({ worktreePath, ...prep });
    }

    return {
      id: workerId,
      path: worktreePath,
      branch: finalBranch,
      baseRef: baseRefFull,
      projectPath,
      createdAt: new Date().toISOString(),
    };
  }

  async list(projectPath: string): Promise<WorktreeInfo[]> {
    const { stdout } = await execFileAsync('git', ['worktree', 'list', '--porcelain'], {
      cwd: projectPath,
    });
    const parsed = parseWorktreePorcelain(stdout);
    const managedRoot = path.resolve(path.join(projectPath, '.symphony', 'worktrees'));
    const out: WorktreeInfo[] = [];
    const blocks = stdout.split(/\r?\n\r?\n/);
    let blockIndex = 0;
    for (const block of blocks) {
      const lines = block.split(/\r?\n/).filter((l) => l.length > 0);
      let wtPath: string | undefined;
      let branchRef: string | undefined;
      for (const line of lines) {
        if (line.startsWith('worktree ')) wtPath = line.substring('worktree '.length);
        else if (line.startsWith('branch ')) branchRef = line.substring('branch '.length);
      }
      if (!wtPath) continue;
      const resolved = path.resolve(wtPath);
      if (!resolved.startsWith(managedRoot + path.sep) && resolved !== managedRoot) {
        blockIndex += 1;
        continue;
      }
      const id = path.basename(resolved);
      out.push({
        id,
        path: resolved,
        branch: branchRef ? branchRef.replace(/^refs\/heads\//, '') : '',
        baseRef: '',
        projectPath,
        createdAt: parsed[blockIndex]?.worktreePath ? statTimeISO(resolved) : '',
      });
      blockIndex += 1;
    }
    return out;
  }

  async remove(worktreePath: string, options: RemoveWorktreeOptions = {}): Promise<void> {
    const projectPath = inferProjectPath(worktreePath);
    return this.locks.withLock(projectPath, () =>
      this.removeUnlocked(worktreePath, projectPath, options),
    );
  }

  private async removeUnlocked(
    worktreePath: string,
    projectPath: string,
    options: RemoveWorktreeOptions,
  ): Promise<void> {
    await assertWorktreeRemovable({ worktreePath, projectPath });

    const branch = await readWorktreeBranch(worktreePath).catch(() => null);

    try {
      await execFileAsync('git', ['worktree', 'remove', '--force', worktreePath], {
        cwd: projectPath,
      });
    } catch (err) {
      console.warn(
        `[worktree] git worktree remove failed (continuing with fs cleanup): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    try {
      await execFileAsync('git', ['worktree', 'prune', '--verbose'], { cwd: projectPath });
    } catch {
      /* best-effort */
    }

    if (fs.existsSync(worktreePath)) {
      await rmWithWindowsFallback(worktreePath);
    }

    if ((options.deleteBranch ?? true) && branch) {
      await deleteBranchWithPruneRetry(projectPath, branch);
    }
  }

  async removeIfClean(
    worktreePath: string,
    options: RemoveWorktreeOptions = {},
  ): Promise<boolean> {
    const projectPath = inferProjectPath(worktreePath);
    return this.locks.withLock(projectPath, async () => {
      const status = await this.status(worktreePath);
      if (status.hasChanges) return false;
      await this.removeUnlocked(worktreePath, projectPath, options);
      return true;
    });
  }

  /**
   * Phase 3Q — remove every Symphony-managed worktree under
   * `<projectPath>/.symphony/worktrees/`. Used by `symphony reset` to
   * wipe per-project state in one pass.
   *
   * Holds the per-project lock for the WHOLE pass (matches the
   * `removeIfClean` precedent) so a concurrent `create` can't materialize
   * a new worktree mid-sweep.
   *
   * Path safety mirrors 1C: the porcelain walk filters to paths under
   * `managedRoot` BEFORE calling `removeUnlocked`. `removeUnlocked` then
   * runs `assertWorktreeRemovable` as defense-in-depth (rejects anything
   * not classified as a linked worktree by `git worktree list --porcelain`).
   *
   * Per-tree errors are captured in `skipped[]`; the loop keeps going so
   * one bad worktree doesn't strand the rest. `removed[]` are the paths
   * that actually got `git worktree remove`d.
   */
  async removeAllForProject(
    projectPath: string,
    options: RemoveWorktreeOptions = {},
  ): Promise<RemoveAllForProjectResult> {
    return this.locks.withLock(projectPath, async () => {
      const { stdout } = await execFileAsync('git', ['worktree', 'list', '--porcelain'], {
        cwd: projectPath,
      });
      const managedRoot = path.resolve(path.join(projectPath, '.symphony', 'worktrees'));
      const targets: string[] = [];
      for (const block of stdout.split(/\r?\n\r?\n/)) {
        const lines = block.split(/\r?\n/).filter((l) => l.length > 0);
        let wtPath: string | undefined;
        for (const line of lines) {
          if (line.startsWith('worktree ')) {
            wtPath = line.substring('worktree '.length);
            break;
          }
        }
        if (wtPath === undefined) continue;
        const resolved = path.resolve(wtPath);
        // Only paths strictly UNDER managedRoot. The managedRoot itself
        // is not a worktree (it's just a directory), and the bare project
        // root would resolve outside this prefix.
        if (resolved.startsWith(managedRoot + path.sep)) {
          targets.push(resolved);
        }
      }
      const removed: string[] = [];
      const skipped: Array<{ path: string; reason: string }> = [];
      for (const target of targets) {
        try {
          await this.removeUnlocked(target, projectPath, options);
          removed.push(target);
        } catch (err) {
          skipped.push({
            path: target,
            reason: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // 3Q Opus audit Major 2 — after the worktree sweep, prune
      // orphaned Symphony branches whose worktrees were deleted
      // externally before reset ran. Without this, the user's
      // `git branch --list` accumulates `symphony/<old-id>/<slug>`
      // entries indefinitely.
      //
      // Best-effort: failures are swallowed (no entry in skipped[]) so
      // a broken `for-each-ref` invocation doesn't fail the whole
      // sweep. Honors `deleteBranch !== false` so callers that want
      // to keep branches around (test fixtures, debugging) still can.
      if ((options.deleteBranch ?? true) === true) {
        try {
          const { stdout: refs } = await execFileAsync(
            'git',
            [
              'for-each-ref',
              '--format=%(refname:short)',
              `refs/heads/${this.branchPrefix}/`,
            ],
            { cwd: projectPath },
          );
          const branchNames = refs.split(/\r?\n/).filter((s) => s.length > 0);
          for (const branch of branchNames) {
            await deleteBranchWithPruneRetry(projectPath, branch).catch(() => {
              // Best-effort. A branch that's still checked out
              // (e.g., the main branch coincidentally matched the
              // prefix) will fail; that's the desired behavior.
            });
          }
        } catch {
          // for-each-ref failed (no refs match, or git error). No-op.
        }
      }
      return { removed, skipped };
    });
  }

  async status(worktreePath: string): Promise<WorktreeStatus> {
    const { stdout } = await execFileAsync(
      'git',
      ['status', '--porcelain', '--untracked-files=all'],
      { cwd: worktreePath },
    );
    const staged: string[] = [];
    const unstaged: string[] = [];
    const untracked: string[] = [];
    for (const rawLine of stdout.split(/\r?\n/)) {
      if (rawLine.length === 0) continue;
      const xy = rawLine.substring(0, 2);
      const file = rawLine.substring(3);
      if (xy === '??') {
        untracked.push(file);
        continue;
      }
      const x = xy[0];
      const y = xy[1];
      if (x && x !== ' ' && x !== '?') staged.push(file);
      if (y && y !== ' ' && y !== '?') unstaged.push(file);
    }
    return {
      hasChanges: staged.length + unstaged.length + untracked.length > 0,
      staged,
      unstaged,
      untracked,
    };
  }
}

function statTimeISO(p: string): string {
  try {
    return fs.statSync(p).birthtime.toISOString();
  } catch {
    return '';
  }
}

export function slugify(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

interface AddWorktreeArgs {
  readonly projectPath: string;
  readonly worktreePath: string;
  readonly branch: string;
  readonly baseRef: string;
}

export function isBranchCollisionError(message: string): boolean {
  return (
    /a branch named/i.test(message) ||
    (/already exists/i.test(message) && /\bbranch\b/i.test(message))
  );
}

export async function addWorktreeWithCollisionRetry(args: AddWorktreeArgs): Promise<string> {
  const attempt = (branch: string) =>
    execFileAsync(
      'git',
      ['worktree', 'add', '--no-track', '-b', branch, args.worktreePath, args.baseRef],
      { cwd: args.projectPath },
    );

  try {
    await attempt(args.branch);
    return args.branch;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const stderr = (err as { stderr?: string | Buffer })?.stderr?.toString() ?? '';
    if (!isBranchCollisionError(message) && !isBranchCollisionError(stderr)) {
      throw err;
    }
    const retryBranch = `${args.branch}-${Date.now()}-${randomSuffix()}`;
    await attempt(retryBranch);
    return retryBranch;
  }
}

async function resolveBaseRef(projectPath: string, override?: string): Promise<string> {
  if (override) {
    const verified = await verifyRef(projectPath, override);
    if (verified) return verified;
    throw new Error(`Could not resolve baseRef '${override}' in ${projectPath}`);
  }

  const symref = await safeExec(projectPath, [
    'symbolic-ref',
    '--quiet',
    'refs/remotes/origin/HEAD',
  ]);
  if (symref) {
    const trimmed = symref.trim();
    if (trimmed && (await verifyRef(projectPath, trimmed))) return trimmed;
  }

  for (const candidate of [
    'refs/remotes/origin/main',
    'refs/remotes/origin/master',
    'refs/heads/main',
    'refs/heads/master',
  ]) {
    if (await verifyRef(projectPath, candidate)) return candidate;
  }

  const current = await safeExec(projectPath, ['branch', '--show-current']);
  if (current) {
    const trimmed = current.trim();
    if (trimmed && (await verifyRef(projectPath, `refs/heads/${trimmed}`))) {
      return `refs/heads/${trimmed}`;
    }
  }

  throw new Error(`Could not resolve any base ref in ${projectPath}`);
}

async function verifyRef(projectPath: string, ref: string): Promise<string | false> {
  try {
    await execFileAsync('git', ['rev-parse', '--verify', '--quiet', ref], {
      cwd: projectPath,
    });
    return ref;
  } catch {
    return false;
  }
}

async function safeExec(cwd: string, args: readonly string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', [...args], { cwd });
    return stdout;
  } catch {
    return null;
  }
}

async function readWorktreeBranch(worktreePath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['symbolic-ref', '--short', 'HEAD'], {
      cwd: worktreePath,
    });
    const branch = stdout.trim();
    return branch.length > 0 ? branch : null;
  } catch {
    return null;
  }
}

async function deleteBranchWithPruneRetry(projectPath: string, branch: string): Promise<void> {
  const attempt = () =>
    execFileAsync('git', ['branch', '-D', branch], { cwd: projectPath });
  try {
    await attempt();
    return;
  } catch (err) {
    const stderr = (err as { stderr?: string | Buffer })?.stderr?.toString() ?? '';
    const message = err instanceof Error ? err.message : String(err);
    if (!/checked out at/i.test(stderr) && !/checked out at/i.test(message)) {
      console.warn(`[worktree] branch -D ${branch} failed: ${message}`);
      return;
    }
    try {
      await execFileAsync('git', ['worktree', 'prune', '--verbose'], { cwd: projectPath });
      await attempt();
    } catch (retryErr) {
      console.warn(
        `[worktree] branch -D ${branch} retry after prune failed: ${
          retryErr instanceof Error ? retryErr.message : String(retryErr)
        }`,
      );
    }
  }
}

async function rmWithWindowsFallback(target: string): Promise<void> {
  try {
    await fs.promises.rm(target, { recursive: true, force: true });
    return;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (process.platform === 'win32' && (code === 'EPERM' || code === 'EACCES')) {
      try {
        await execFileAsync('cmd', ['/c', 'attrib', '-R', '/S', '/D', `${target}\\*`]);
        await fs.promises.rm(target, { recursive: true, force: true });
        return;
      } catch (retryErr) {
        console.warn(
          `[worktree] rm fallback failed for ${target}: ${
            retryErr instanceof Error ? retryErr.message : String(retryErr)
          }`,
        );
        return;
      }
    }
    console.warn(
      `[worktree] rm failed for ${target}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Infer projectPath from a worktreePath like
 * `<projectPath>/.symphony/worktrees/<workerId>` by stripping the trailing
 * `.symphony/worktrees/<id>` segment. Throws if the path doesn't fit
 * the convention — callers must pass a managed worktree path.
 */
/**
 * Is the worktree pool opt-in for this project? Consult `.symphony.json`.
 * Defaults to false in v1 per PLAN.md §1D — opt-in per project.
 */
export function isPoolEnabled(projectPath: string): boolean {
  const cfg = readSymphonyConfig(projectPath);
  return cfg?.worktreePool?.enabled === true;
}

export function inferProjectPath(worktreePath: string): string {
  const resolved = path.resolve(worktreePath);
  const parent = path.dirname(resolved);
  const grand = path.dirname(parent);
  const greatGrand = path.dirname(grand);
  if (path.basename(parent) !== 'worktrees' || path.basename(grand) !== '.symphony') {
    throw new WorktreeSafetyError(
      `Cannot infer projectPath from non-managed worktree path: ${worktreePath}`,
      'not-managed',
    );
  }
  return greatGrand;
}
