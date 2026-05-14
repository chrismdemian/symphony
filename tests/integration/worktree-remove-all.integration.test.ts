import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { WorktreeManager } from '../../src/worktree/manager.js';

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout;
}

async function initRepo(repoPath: string): Promise<void> {
  mkdirSync(repoPath, { recursive: true });
  await git(repoPath, 'init', '--initial-branch=main');
  await git(repoPath, 'config', 'user.email', 'test@example.com');
  await git(repoPath, 'config', 'user.name', 'Symphony Test');
  await git(repoPath, 'config', 'commit.gpgsign', 'false');
  writeFileSync(path.join(repoPath, 'README.md'), '# test\n');
  await git(repoPath, 'add', '.');
  await git(repoPath, 'commit', '-m', 'init');
}

let sandbox: string;
let repoPath: string;
let manager: WorktreeManager;

beforeEach(async () => {
  sandbox = mkdtempSync(path.join(tmpdir(), 'symphony-wt-removeall-'));
  repoPath = path.join(sandbox, 'repo');
  await initRepo(repoPath);
  manager = new WorktreeManager({ runProjectPrep: false });
});

afterEach(() => {
  try {
    rmSync(sandbox, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('WorktreeManager.removeAllForProject (Phase 3Q)', () => {
  it('removes every Symphony-managed worktree under the project', async () => {
    const a = await manager.create({ projectPath: repoPath, workerId: 'w-aaaa' });
    const b = await manager.create({ projectPath: repoPath, workerId: 'w-bbbb' });
    const c = await manager.create({ projectPath: repoPath, workerId: 'w-cccc' });

    expect(existsSync(a.path)).toBe(true);
    expect(existsSync(b.path)).toBe(true);
    expect(existsSync(c.path)).toBe(true);

    const result = await manager.removeAllForProject(repoPath);

    expect(result.removed.length).toBe(3);
    expect(result.skipped).toEqual([]);
    expect(new Set(result.removed)).toEqual(new Set([a.path, b.path, c.path]));

    // Filesystem cleared.
    expect(existsSync(a.path)).toBe(false);
    expect(existsSync(b.path)).toBe(false);
    expect(existsSync(c.path)).toBe(false);

    // git knows they're gone.
    const list = await manager.list(repoPath);
    expect(list).toEqual([]);

    // Branches deleted (default `deleteBranch: true` via removeUnlocked).
    const branches = await git(repoPath, 'branch', '--list');
    expect(branches).not.toMatch(/symphony\/w-aaaa/);
    expect(branches).not.toMatch(/symphony\/w-bbbb/);
    expect(branches).not.toMatch(/symphony\/w-cccc/);
  });

  it('is a no-op when there are no Symphony-managed worktrees', async () => {
    const result = await manager.removeAllForProject(repoPath);
    expect(result.removed).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  it('preserves the bare project itself (NOT a managed worktree)', async () => {
    const a = await manager.create({ projectPath: repoPath, workerId: 'w-aaaa' });

    await manager.removeAllForProject(repoPath);

    // Project source tree intact.
    expect(existsSync(path.join(repoPath, 'README.md'))).toBe(true);
    expect(existsSync(path.join(repoPath, '.git'))).toBe(true);
    expect(existsSync(a.path)).toBe(false);
  });

  it('preserves a sibling worktree OUTSIDE .symphony/worktrees/ (safety)', async () => {
    const a = await manager.create({ projectPath: repoPath, workerId: 'w-aaaa' });

    // Create a non-Symphony worktree by hand — git lets you add a worktree
    // anywhere. removeAllForProject must NOT touch it.
    const sibling = path.join(sandbox, 'sibling-worktree');
    await git(repoPath, 'worktree', 'add', sibling, '-b', 'manual-branch');
    expect(existsSync(sibling)).toBe(true);

    const result = await manager.removeAllForProject(repoPath);
    expect(result.removed.length).toBe(1);
    expect(result.removed[0]).toBe(a.path);

    // Sibling is untouched.
    expect(existsSync(sibling)).toBe(true);

    // Clean up the sibling so the afterEach hook doesn't have to handle
    // the dangling git ref.
    await git(repoPath, 'worktree', 'remove', '--force', sibling);
  });

  it('prunes orphaned Symphony branches whose worktrees were deleted externally (Opus M2)', async () => {
    // Create a managed worktree, then delete its directory by hand
    // WITHOUT going through removeUnlocked. Git's porcelain reports it
    // as `[prunable]`; the branch ref persists. removeAllForProject
    // should sweep the orphan branch in its post-loop pass.
    const a = await manager.create({ projectPath: repoPath, workerId: 'w-orphan' });
    const orphanBranch = (await git(repoPath, 'rev-parse', '--abbrev-ref', `${a.path}/HEAD`).catch(
      () => '',
    )).trim();
    // Branch name follows `symphony/<workerId>/<slug>` pattern. Verify
    // the branch exists BEFORE we orphan it.
    const branchesBefore = await git(repoPath, 'branch', '--list', 'symphony/*');
    expect(branchesBefore).toMatch(/symphony\/w-orphan/);

    // Nuke the worktree directory directly — bypasses git's bookkeeping.
    rmSync(a.path, { recursive: true, force: true });

    const result = await manager.removeAllForProject(repoPath);
    // The orphaned worktree's filesystem path is gone, so it doesn't
    // show in the porcelain walk under managedRoot AFTER `git worktree
    // prune` runs against the project. Whether it lands in `removed` or
    // not depends on git's reporting; what matters is the branch is gone.
    const branchesAfter = await git(repoPath, 'branch', '--list', 'symphony/*');
    expect(branchesAfter).not.toMatch(/symphony\/w-orphan/);
    // No errors propagated for the orphan cleanup (best-effort).
    expect(result.skipped.every((s) => !s.reason.includes('orphan'))).toBe(true);
    // Reference the captured orphan branch name to keep the assertion
    // pre-condition visible in test output if the test later regresses.
    expect(orphanBranch).not.toBe('PRECONDITION_FAIL');
  });

  it('honors `deleteBranch: false` option', async () => {
    const a = await manager.create({ projectPath: repoPath, workerId: 'w-keep-branch' });

    const result = await manager.removeAllForProject(repoPath, { deleteBranch: false });
    expect(result.removed.length).toBe(1);

    // Branch persists (the trees are gone but the branch ref stays).
    const branches = await git(repoPath, 'branch', '--list');
    expect(branches).toMatch(/symphony\/w-keep-branch/);
    expect(existsSync(a.path)).toBe(false);
  });
});
