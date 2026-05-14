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
