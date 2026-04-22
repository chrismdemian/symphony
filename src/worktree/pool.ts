import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import { excludeFromGit } from './exclude.js';
import { ProjectLockRegistry } from './locks.js';
import { isBranchCollisionError, slugify } from './manager.js';
import { preserveFilesToWorktree, resolvePreservePatterns } from './preserve.js';
import { ensureProjectPrepared } from './project-prep.js';
import { assertWorktreeRemovable, WorktreeSafetyError } from './safety.js';
import type {
  ClaimReserveOptions,
  ReserveInfo,
  WorktreeInfo,
  WorktreePoolEvents,
  WorktreePoolHandle,
  WorktreePoolOptions,
} from './types.js';

const execFileAsync = promisify(execFile);

const RESERVE_DIR_PREFIX = '_reserve';
const RESERVE_BRANCH_PREFIX = '_reserve';
const DEFAULT_MAX_RESERVE_AGE_MS = 30 * 60 * 1000;
const DEFAULT_FRESHNESS_POLL_INTERVAL_MS = 60_000;
const FETCH_TIMEOUT_MS = 15_000;
const LS_REMOTE_TIMEOUT_MS = 10_000;

/**
 * Strip a leading `origin/` from a remote-tracking ref. Exported for tests.
 */
export function stripOriginPrefix(ref: string): string {
  return ref.startsWith('origin/') ? ref.slice('origin/'.length) : ref;
}

/**
 * Canonicalize a baseRef for pool keying:
 *   - empty/undefined → 'HEAD'
 *   - 'origin/main'   → 'main'
 *   - bare branch     → kept as-is
 * Called with no fs/git access so it is cheap + pure.
 */
export function canonicalizeBaseRef(baseRef: string | undefined): string {
  const trimmed = (baseRef ?? '').trim();
  if (trimmed.length === 0) return 'HEAD';
  return stripOriginPrefix(trimmed);
}

/**
 * Pool key: `${resolvedProjectPath}::${canonicalBaseRef}`.
 * Using `path.resolve` ensures `/foo/bar/` and `/foo/bar` hash to the same
 * bucket, and different projects cannot collide on baseRef alone.
 */
export function reserveKey(projectPath: string, baseRef?: string): string {
  return `${path.resolve(projectPath)}::${canonicalizeBaseRef(baseRef)}`;
}

export interface ReserveDirParts {
  readonly directory: string;
  readonly hash: string;
}

/**
 * Parse a reserve directory name back to its hash component.
 * Format: `_reserve-<hash>`. Returns null on non-match.
 */
export function parseReserveDirName(name: string): ReserveDirParts | null {
  const m = /^_reserve-([^/\\]+)$/.exec(name);
  if (!m || !m[1]) return null;
  return { directory: name, hash: m[1] };
}

function generateReserveHash(): string {
  return randomBytes(4).toString('hex');
}

function stableReserveId(reservePath: string): string {
  return `wt-${createHash('sha1').update(path.resolve(reservePath)).digest('hex').slice(0, 12)}`;
}

async function runGit(cwd: string, args: readonly string[], timeoutMs?: number): Promise<string> {
  const { stdout } = await execFileAsync('git', [...args], {
    cwd,
    ...(timeoutMs ? { timeout: timeoutMs } : {}),
  });
  return stdout;
}

async function safeRunGit(cwd: string, args: readonly string[]): Promise<string | null> {
  try {
    return await runGit(cwd, args);
  } catch {
    return null;
  }
}

/**
 * WorktreePool maintains one pre-warmed reserve worktree per
 * (projectPath, baseRef) so that `claimReserve` returns a ready-to-use
 * worktree in ~50ms instead of the 3-7s `git fetch + git worktree add`
 * cost. See PLAN.md §Phase 1D for the full motivation.
 *
 * Reserves live under `<projectPath>/.symphony/worktrees/_reserve-<hash>`
 * (in-tree, matching Symphony's managed-worktree convention — unlike
 * emdash's sibling layout). All mutating git operations on a project hold
 * the shared `ProjectLockRegistry` so the pool never races with the
 * non-pool `WorktreeManager.create/remove` paths.
 *
 * Port of emdash `src/main/services/WorktreePoolService.ts`; file-level
 * deviations:
 *   - in-tree reserve path vs emdash's sibling path
 *   - shared ProjectLockRegistry (Multica parity) instead of per-op ad-hoc
 *     flags
 *   - key derived from resolved projectPath (Symphony has no projectId in
 *     Phase 1)
 *   - orphan scan is deterministic (project roots) — no home-dir heuristics
 */
export class WorktreePool implements WorktreePoolHandle {
  private readonly reserves = new Map<string, ReserveInfo>();
  private readonly creationPromises = new Map<string, Promise<void>>();
  private readonly preflightPromises = new Map<string, Promise<void>>();
  private readonly locks: ProjectLockRegistry;
  private readonly maxReserveAgeMs: number;
  private readonly pollIntervalMs: number;
  private readonly runPoll: boolean;
  private readonly now: () => number;
  private readonly events: WorktreePoolEvents;
  private pollTimer: NodeJS.Timeout | undefined;
  private polling = false;
  private disposed = false;

  constructor(options: WorktreePoolOptions = {}) {
    this.locks = options.locks ?? new ProjectLockRegistry();
    this.maxReserveAgeMs = options.maxReserveAgeMs ?? DEFAULT_MAX_RESERVE_AGE_MS;
    this.pollIntervalMs = options.freshnessPollIntervalMs ?? DEFAULT_FRESHNESS_POLL_INTERVAL_MS;
    this.runPoll = options.runPoll ?? true;
    this.now = options.now ?? (() => Date.now());
    this.events = options.events ?? {};
  }

  /**
   * Snapshot of the current reserves. Intended for tests + observability.
   */
  listReserves(): readonly ReserveInfo[] {
    return Array.from(this.reserves.values());
  }

  /**
   * True if a non-stale reserve exists for the given project+baseRef.
   */
  hasFreshReserve(projectPath: string, baseRef?: string): boolean {
    const reserve = this.reserves.get(reserveKey(projectPath, baseRef));
    return !!reserve && !this.isReserveStale(reserve);
  }

  isReserveStale(reserve: ReserveInfo): boolean {
    const age = this.now() - Date.parse(reserve.createdAt);
    return Number.isFinite(age) && age > this.maxReserveAgeMs;
  }

  /**
   * Create a reserve in the background if one does not already exist.
   * Concurrent callers share a single in-flight promise.
   */
  async ensureReserve(projectPath: string, baseRef?: string): Promise<void> {
    if (this.disposed) return;
    const key = reserveKey(projectPath, baseRef);

    const inflight = this.creationPromises.get(key);
    if (inflight) return inflight;

    const existing = this.reserves.get(key);
    if (existing && !this.isReserveStale(existing)) return;

    // Stale-cleanup + create must happen in strict order. An explicit
    // await chain documents the ordering instead of relying on
    // withLock's chained-promise semantics via fire-and-forget void.
    // (Gate 5 M4: explicit > implicit.)
    const hasStale = !!existing && this.isReserveStale(existing);
    const promise = (async () => {
      if (hasStale && existing) {
        await this.locks.withLock(projectPath, async () => {
          if (this.reserves.get(key) === existing) this.reserves.delete(key);
        });
        await this.discardReserve(existing).catch(() => undefined);
      }
      await this.createReserveInLock(projectPath, baseRef);
    })().finally(() => {
      this.creationPromises.delete(key);
    });
    this.creationPromises.set(key, promise);
    return promise;
  }

  private async createReserveInLock(projectPath: string, baseRef?: string): Promise<void> {
    let orphanToDiscard: ReserveInfo | null = null;
    await this.locks.withLock(projectPath, async () => {
      if (this.disposed) return;
      const key = reserveKey(projectPath, baseRef);
      const existing = this.reserves.get(key);
      if (existing && !this.isReserveStale(existing)) return;

      const reserve = await this.createReserve(projectPath, baseRef);
      if (!reserve) return;

      // Disposal can race with a long-running `git worktree add`. If the
      // pool was disposed while we were creating, capture the reserve
      // here and discard it AFTER we release the lock (calling
      // `discardReserve` re-enters withLock — deadlock). (Gate 5 M1.)
      if (this.disposed) {
        orphanToDiscard = reserve;
        return;
      }

      this.reserves.set(key, reserve);
      this.events.onReserveCreated?.(reserve);
      this.startFreshnessPoll();
    });
    if (orphanToDiscard) {
      await this.discardReserve(orphanToDiscard).catch(() => undefined);
    }
  }

  private async createReserve(projectPath: string, baseRef?: string): Promise<ReserveInfo | null> {
    const hash = generateReserveHash();
    const reserveDir = path.join(projectPath, '.symphony', 'worktrees', `${RESERVE_DIR_PREFIX}-${hash}`);
    const reserveBranch = `${RESERVE_BRANCH_PREFIX}/${hash}`;
    fs.mkdirSync(path.dirname(reserveDir), { recursive: true });

    try {
      await runGit(projectPath, ['fetch', '--all', '--prune'], FETCH_TIMEOUT_MS);
    } catch {
      /* offline / no remote / timeout — fall through to local ref resolution */
    }
    const resolvedRef = await this.resolveToRemoteRef(projectPath, canonicalizeBaseRef(baseRef));

    try {
      await runGit(projectPath, [
        'worktree',
        'add',
        '--no-track',
        '-b',
        reserveBranch,
        reserveDir,
        resolvedRef,
      ]);
    } catch (err) {
      const stderr = (err as { stderr?: string | Buffer })?.stderr?.toString() ?? '';
      const msg = err instanceof Error ? err.message : String(err);
      if (isBranchCollisionError(stderr) || isBranchCollisionError(msg)) {
        const retry = `${reserveBranch}-${Date.now()}-${randomBytes(3).toString('hex')}`;
        await runGit(projectPath, ['worktree', 'add', '--no-track', '-b', retry, reserveDir, resolvedRef]);
        return this.finalizeReserve({
          projectPath,
          reserveDir,
          reserveBranch: retry,
          canonicalBase: canonicalizeBaseRef(baseRef),
          resolvedRef,
        });
      }
      throw err;
    }

    return this.finalizeReserve({
      projectPath,
      reserveDir,
      reserveBranch,
      canonicalBase: canonicalizeBaseRef(baseRef),
      resolvedRef,
    });
  }

  private async finalizeReserve(args: {
    projectPath: string;
    reserveDir: string;
    reserveBranch: string;
    canonicalBase: string;
    resolvedRef: string;
  }): Promise<ReserveInfo> {
    const { projectPath, reserveDir, reserveBranch, canonicalBase, resolvedRef } = args;
    const hashOut = await runGit(reserveDir, ['rev-parse', 'HEAD']);
    const commitHash = hashOut.trim();
    return {
      id: stableReserveId(reserveDir),
      path: reserveDir,
      branch: reserveBranch,
      projectPath: path.resolve(projectPath),
      baseRef: canonicalBase,
      resolvedRef,
      commitHash,
      createdAt: new Date(this.now()).toISOString(),
    };
  }

  private async resolveToRemoteRef(projectPath: string, canonical: string): Promise<string> {
    if (canonical === 'HEAD') {
      const head = await safeRunGit(projectPath, ['symbolic-ref', '--short', 'HEAD']);
      const branch = head?.trim();
      if (!branch) return 'HEAD';
      const remote = await safeRunGit(projectPath, [
        'rev-parse',
        '--verify',
        '--quiet',
        `refs/remotes/origin/${branch}`,
      ]);
      if (remote) return `origin/${branch}`;
      return branch;
    }
    const remote = await safeRunGit(projectPath, [
      'rev-parse',
      '--verify',
      '--quiet',
      `refs/remotes/origin/${canonical}`,
    ]);
    if (remote) return `origin/${canonical}`;
    return canonical;
  }

  /**
   * Claim a reserve and transform it into a final worktree. Runs inside
   * the project lock so it serializes with `ensureReserve` and with the
   * non-pool `WorktreeManager.create/remove` paths.
   *
   * Returns null (cache miss, stale reserve, or transform failure) to
   * signal the caller should fall back to synchronous creation.
   */
  async claimReserve(opts: ClaimReserveOptions): Promise<WorktreeInfo | null> {
    if (this.disposed) return null;
    return this.locks.withLock(opts.projectPath, async () => {
      const key = reserveKey(opts.projectPath, opts.baseRef);
      const reserve = this.reserves.get(key);
      if (!reserve) {
        void this.ensureReserve(opts.projectPath, opts.baseRef).catch(() => undefined);
        return null;
      }
      if (this.isReserveStale(reserve)) {
        this.reserves.delete(key);
        void this.discardReserve(reserve);
        void this.ensureReserve(opts.projectPath, opts.baseRef).catch(() => undefined);
        return null;
      }

      this.reserves.delete(key);

      try {
        const info = await this.transformReserve(reserve, opts);
        this.events.onReserveClaimed?.({ reserve, worktree: info });
        void this.ensureReserve(opts.projectPath, opts.baseRef).catch(() => undefined);
        return info;
      } catch (err) {
        console.warn(
          `[worktree-pool] claim transform failed; falling back to sync create: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        // transformReserve owns its own rollback — it knows whether the
        // worktree still lives at reserve.path or was moved to finalPath.
        // (Gate 5 C1: the outer catch must NOT double-discard with a
        // stale ReserveInfo; doing so leaks the moved worktree.)
        void this.ensureReserve(opts.projectPath, opts.baseRef).catch(() => undefined);
        return null;
      }
    });
  }

  private async transformReserve(
    reserve: ReserveInfo,
    opts: ClaimReserveOptions,
  ): Promise<WorktreeInfo> {
    const { projectPath, workerId, shortDescription, branchPrefix, excludePatterns } = opts;
    if (!workerId.trim()) {
      throw new Error('WorktreePool.claimReserve: workerId is required');
    }

    const slug = slugify(shortDescription ?? '');
    const finalBranch = slug ? `${branchPrefix}/${workerId}/${slug}` : `${branchPrefix}/${workerId}`;
    const finalPath = path.join(projectPath, '.symphony', 'worktrees', workerId);

    if (fs.existsSync(finalPath)) {
      throw new Error(`Worktree path already exists: ${finalPath}`);
    }

    // Phase 1: before `git worktree move`. Rollback target = reserve.path.
    // Phase 2: after the move. Rollback target = finalPath with reserve.branch.
    // (Gate 5 C1: keeping rollback-target bookkeeping explicit.)
    let rollbackTarget: ReserveInfo = reserve;
    try {
      await runGit(projectPath, ['worktree', 'move', reserve.path, finalPath]);
      rollbackTarget = { ...reserve, path: finalPath };

      let actualBranch = finalBranch;
      try {
        await runGit(finalPath, ['branch', '-m', reserve.branch, finalBranch]);
      } catch (err) {
        const stderr = (err as { stderr?: string | Buffer })?.stderr?.toString() ?? '';
        const msg = err instanceof Error ? err.message : String(err);
        if (isBranchCollisionError(stderr) || isBranchCollisionError(msg)) {
          actualBranch = `${finalBranch}-${Date.now()}-${randomBytes(3).toString('hex')}`;
          await runGit(finalPath, ['branch', '-m', reserve.branch, actualBranch]);
        } else {
          throw err;
        }
      }
      rollbackTarget = { ...rollbackTarget, branch: actualBranch };

      try {
        await excludeFromGit(finalPath, excludePatterns);
      } catch (err) {
        console.warn(
          `[worktree-pool] failed to write .git/info/exclude for ${finalPath}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }

      if (!opts.skipPreserve) {
        try {
          const resolved = resolvePreservePatterns(projectPath);
          const result = await preserveFilesToWorktree(projectPath, finalPath, resolved.patterns);
          opts.onPreserveResult?.({
            worktreePath: finalPath,
            copied: result.copied,
            skipped: result.skipped,
          });
        } catch (err) {
          console.warn(
            `[worktree-pool] preserve step failed for ${finalPath}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }

      if ((opts.runProjectPrep ?? true) && !opts.skipProjectPrep) {
        const prep = ensureProjectPrepared(finalPath);
        opts.onProjectPrep?.({ worktreePath: finalPath, ...prep });
      }

      return {
        id: workerId,
        path: finalPath,
        branch: actualBranch,
        baseRef: reserve.resolvedRef,
        projectPath: path.resolve(projectPath),
        createdAt: new Date(this.now()).toISOString(),
      };
    } catch (err) {
      // Best-effort rollback of whatever survived — the sync fallback in
      // WorktreeManager.create needs finalPath to be free. Use the raw
      // lock-free variant: claimReserve (our caller) still holds the
      // project lock, so re-entering withLock would deadlock.
      await this.discardReserveRaw(rollbackTarget).catch(() => undefined);
      throw err;
    }
  }

  /**
   * Preflight freshness check. Callers invoke this when they have a
   * good hint that a task is coming — e.g. user starts typing a prompt
   * — so the ls-remote staleness cost is paid before `claimReserve`.
   */
  async preflight(projectPath: string, baseRef?: string): Promise<void> {
    if (this.disposed) return;
    const key = reserveKey(projectPath, baseRef);
    const inflight = this.preflightPromises.get(key);
    if (inflight) return inflight;

    const promise = this.runPreflight(projectPath, baseRef).finally(() => {
      this.preflightPromises.delete(key);
    });
    this.preflightPromises.set(key, promise);
    return promise;
  }

  private async runPreflight(projectPath: string, baseRef?: string): Promise<void> {
    const key = reserveKey(projectPath, baseRef);
    const existing = this.reserves.get(key);
    if (!existing) {
      await this.ensureReserve(projectPath, baseRef);
      return;
    }
    await this.refreshReserveIfStale(key, existing);
    if (!this.reserves.get(key)) {
      await this.ensureReserve(projectPath, baseRef);
    }
  }

  /**
   * Background freshness loop. Idempotent — repeated calls are no-ops.
   * Skipped entirely when `runPoll === false` (tests).
   */
  startFreshnessPoll(): void {
    if (!this.runPoll || this.polling || this.disposed) return;
    this.polling = true;
    this.schedulePollTick();
  }

  stopFreshnessPoll(): void {
    this.polling = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  private schedulePollTick(): void {
    this.pollTimer = setTimeout(() => {
      this.pollTimer = undefined;
      void this.checkAllReserves().finally(() => {
        if (this.polling && this.reserves.size > 0) {
          this.schedulePollTick();
        } else {
          this.polling = false;
        }
      });
    }, this.pollIntervalMs);
    this.pollTimer.unref?.();
  }

  async checkAllReserves(): Promise<void> {
    const entries = Array.from(this.reserves.entries());
    this.events.onPollTick?.({ reserves: entries.length });
    await Promise.all(entries.map(([key, reserve]) => this.refreshReserveIfStale(key, reserve)));
  }

  /**
   * Compare a reserve's stored commit hash to the current tip of its
   * baseRef. Remote refs use `ls-remote` (no fetch). Local refs use
   * `rev-parse` (instant). On drift, discard + enqueue a fresh one.
   */
  async refreshReserveIfStale(key: string, reserve: ReserveInfo): Promise<void> {
    try {
      let currentHash: string | undefined;
      if (reserve.resolvedRef.startsWith('origin/')) {
        const branch = stripOriginPrefix(reserve.resolvedRef);
        const out = await runGit(reserve.projectPath, ['ls-remote', 'origin', branch], LS_REMOTE_TIMEOUT_MS);
        currentHash = out.split(/\s/)[0]?.trim();
      } else {
        const out = await safeRunGit(reserve.projectPath, ['rev-parse', '--verify', reserve.resolvedRef]);
        currentHash = out?.trim();
      }

      if (!currentHash || currentHash === reserve.commitHash) return;

      // Mutate the reserves map inside the project lock so claim/ensureReserve
      // cannot read a stale entry between delete and discard. (Gate 5 M2.)
      let removed = false;
      await this.locks.withLock(reserve.projectPath, async () => {
        if (this.reserves.get(key) === reserve) {
          this.reserves.delete(key);
          removed = true;
        }
      });
      if (!removed) return;

      this.events.onReserveStale?.({ reserve, currentHash });
      await this.discardReserve(reserve);
      await this.ensureReserve(reserve.projectPath, reserve.baseRef);
    } catch {
      /* failures are non-critical; skip */
    }
  }

  /**
   * Remove all reserves for a given project on app shutdown or explicit
   * project close. Orphan cleanup in a later session will catch anything
   * we miss (e.g. crash).
   */
  async cleanup(): Promise<void> {
    this.disposed = true;
    this.stopFreshnessPoll();

    // Drain in-flight creation + preflight promises before sweeping so
    // a creation that started before disposal can roll itself back via
    // the `disposed` recheck inside `createReserveInLock`. (Gate 5 M1.)
    const pending = [
      ...this.creationPromises.values(),
      ...this.preflightPromises.values(),
    ];
    if (pending.length > 0) {
      await Promise.allSettled(pending);
    }

    const entries = Array.from(this.reserves.values());
    this.reserves.clear();
    await Promise.allSettled(entries.map((r) => this.discardReserve(r)));
  }

  /**
   * At startup, scan each project's `.symphony/worktrees/` directory for
   * leftover `_reserve-*` entries. Remove each via `git worktree remove
   * --force` + `git branch -D`. Runs after a small delay so the CLI
   * start path isn't blocked.
   */
  async cleanupOrphanedReserves(projectPaths: readonly string[]): Promise<void> {
    if (projectPaths.length === 0) return;
    const orphans: Array<{ reservePath: string; projectPath: string }> = [];
    for (const projectPath of projectPaths) {
      const dir = path.join(projectPath, '.symphony', 'worktrees');
      if (!fs.existsSync(dir)) continue;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (!parseReserveDirName(entry.name)) continue;
        orphans.push({ reservePath: path.join(dir, entry.name), projectPath });
      }
    }

    if (orphans.length === 0) return;

    await Promise.all(
      orphans.map(async ({ reservePath, projectPath }) => {
        const ok = await this.removeOrphan(reservePath, projectPath);
        this.events.onOrphanCleanup?.({ path: reservePath, ok });
      }),
    );
  }

  private async removeOrphan(reservePath: string, projectPath: string): Promise<boolean> {
    try {
      await assertWorktreeRemovable({ worktreePath: reservePath, projectPath });
    } catch (err) {
      // Only fs-rm when git has no record of the path — the "on disk but
      // unregistered" orphan shape. Other safety codes (porcelain-failed,
      // is-main, is-bare, path-equals-project, not-managed) must REFUSE,
      // not proceed — degraded-git is not a license to delete. (Gate 5 M3.)
      if (err instanceof WorktreeSafetyError && err.code === 'not-linked') {
        try {
          fs.rmSync(reservePath, { recursive: true, force: true });
          return true;
        } catch {
          return false;
        }
      }
      console.warn(
        `[worktree-pool] refusing to remove orphan ${reservePath}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return false;
    }

    try {
      await this.locks.withLock(projectPath, async () => {
        await safeRunGit(projectPath, ['worktree', 'remove', '--force', reservePath]);
        await safeRunGit(projectPath, ['worktree', 'prune', '--verbose']);
        if (fs.existsSync(reservePath)) {
          fs.rmSync(reservePath, { recursive: true, force: true });
        }
        const branch = parseReserveDirName(path.basename(reservePath));
        if (branch) {
          await safeRunGit(projectPath, ['branch', '-D', `${RESERVE_BRANCH_PREFIX}/${branch.hash}`]);
        }
      });
      return true;
    } catch {
      return false;
    }
  }

  private async discardReserve(reserve: ReserveInfo): Promise<void> {
    try {
      await this.locks.withLock(reserve.projectPath, () => this.discardReserveRaw(reserve));
    } catch {
      /* best-effort */
    }
  }

  /**
   * Lock-free reserve discard. Callers that already hold the project
   * lock (e.g. `transformReserve`'s rollback, `createReserveInLock`'s
   * disposed-rollback) must use this to avoid re-entering the chained
   * `ProjectLockRegistry` (which would deadlock).
   */
  private async discardReserveRaw(reserve: ReserveInfo): Promise<void> {
    try {
      await safeRunGit(reserve.projectPath, ['worktree', 'remove', '--force', reserve.path]);
      await safeRunGit(reserve.projectPath, ['worktree', 'prune', '--verbose']);
      if (fs.existsSync(reserve.path)) {
        fs.rmSync(reserve.path, { recursive: true, force: true });
      }
      await safeRunGit(reserve.projectPath, ['branch', '-D', reserve.branch]);
    } catch {
      /* best-effort */
    }
  }
}

export const _internal = {
  RESERVE_DIR_PREFIX,
  RESERVE_BRANCH_PREFIX,
  DEFAULT_MAX_RESERVE_AGE_MS,
  DEFAULT_FRESHNESS_POLL_INTERVAL_MS,
  FETCH_TIMEOUT_MS,
};
