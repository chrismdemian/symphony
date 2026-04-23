import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_DIFF_SIZE_CAP_BYTES,
  NothingToCommitError,
  PushRejectedError,
  commitAll,
  currentBranch,
  diffWorktree,
  mergeBranch,
  push,
} from '../../src/orchestrator/git-ops.js';

const execFileAsync = promisify(execFile);

async function initRepo(dir: string): Promise<void> {
  await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  await execFileAsync('git', ['config', 'user.email', 't@t'], { cwd: dir });
  await execFileAsync('git', ['config', 'user.name', 't'], { cwd: dir });
  await execFileAsync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
  await fs.writeFile(path.join(dir, 'README.md'), '# base\n', 'utf8');
  await execFileAsync('git', ['add', '.'], { cwd: dir });
  await execFileAsync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
}

describe('diffWorktree (real git)', () => {
  let dir = '';

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sym-gitops-'));
    await initRepo(dir);
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('returns no diff and no files for a clean worktree', async () => {
    const r = await diffWorktree({ worktreePath: dir });
    expect(r.diff).toBe('');
    expect(r.bytes).toBe(0);
    expect(r.truncated).toBe(false);
    expect(r.files).toEqual([]);
    expect(r.baseRef).toBe('HEAD');
  });

  it('captures an unstaged modification', async () => {
    await fs.writeFile(path.join(dir, 'README.md'), '# changed\n', 'utf8');
    const r = await diffWorktree({ worktreePath: dir });
    expect(r.diff).toContain('README.md');
    expect(r.diff).toContain('-# base');
    expect(r.diff).toContain('+# changed');
    expect(r.files.length).toBe(1);
    expect(r.files[0]).toEqual({ path: 'README.md', status: 'M' });
  });

  it('captures a staged addition', async () => {
    await fs.writeFile(path.join(dir, 'NEW.md'), 'hello\n', 'utf8');
    await execFileAsync('git', ['add', 'NEW.md'], { cwd: dir });
    const r = await diffWorktree({ worktreePath: dir });
    expect(r.diff).toContain('NEW.md');
    expect(r.files.some((f) => f.path === 'NEW.md' && f.status === 'A')).toBe(true);
  });

  it('reports untracked files separately with ?? status', async () => {
    await fs.writeFile(path.join(dir, 'UNTRACKED.txt'), 'x', 'utf8');
    const r = await diffWorktree({ worktreePath: dir });
    expect(r.diff).toContain('untracked files');
    expect(r.files.some((f) => f.path === 'UNTRACKED.txt' && f.status === '??')).toBe(true);
  });

  it('truncates above capBytes with a marker', async () => {
    // Write a file larger than the cap. Diff will be ~2× the file size.
    const big = 'x'.repeat(60_000) + '\n';
    await fs.writeFile(path.join(dir, 'BIG.txt'), big, 'utf8');
    await execFileAsync('git', ['add', 'BIG.txt'], { cwd: dir });
    const r = await diffWorktree({ worktreePath: dir, capBytes: 1024 });
    expect(r.truncated).toBe(true);
    expect(r.bytes).toBeGreaterThan(1024);
    expect(r.diff).toContain('diff truncated');
    expect(r.files.some((f) => f.path === 'BIG.txt')).toBe(true);
  });

  it('honors non-default baseRef', async () => {
    // new commit so HEAD differs from main
    await fs.writeFile(path.join(dir, 'README.md'), '# v2\n', 'utf8');
    await execFileAsync('git', ['commit', '-aq', '-m', 'v2'], { cwd: dir });
    await fs.writeFile(path.join(dir, 'README.md'), '# v3\n', 'utf8');
    const rHead = await diffWorktree({ worktreePath: dir });
    const rMain = await diffWorktree({ worktreePath: dir, baseRef: 'main' });
    // HEAD is at v2 now, so diff to HEAD sees v2→v3.
    // main is at v1, so diff to main sees v1→v3 (more lines).
    expect(rMain.diff.length).toBeGreaterThanOrEqual(rHead.diff.length);
    expect(rMain.baseRef).toBe('main');
  });

  it('default cap is DEFAULT_DIFF_SIZE_CAP_BYTES', async () => {
    const r = await diffWorktree({ worktreePath: dir });
    expect(DEFAULT_DIFF_SIZE_CAP_BYTES).toBe(50_000);
    expect(r.truncated).toBe(false);
  });

  it('preserves spaces in tracked file paths (audit M1)', async () => {
    await fs.writeFile(path.join(dir, 'file with spaces.txt'), 'v1\n', 'utf8');
    await execFileAsync('git', ['add', '.'], { cwd: dir });
    await execFileAsync('git', ['commit', '-q', '-m', 'add space file'], { cwd: dir });
    await fs.writeFile(path.join(dir, 'file with spaces.txt'), 'v2\n', 'utf8');
    const r = await diffWorktree({ worktreePath: dir });
    expect(r.files.some((f) => f.path === 'file with spaces.txt' && f.status === 'M')).toBe(true);
  });

  it('preserves the post-rename path even when both ends contain spaces (audit M1)', async () => {
    await fs.writeFile(path.join(dir, 'old path.txt'), 'hi\n', 'utf8');
    await execFileAsync('git', ['add', '.'], { cwd: dir });
    await execFileAsync('git', ['commit', '-q', '-m', 'seed rename'], { cwd: dir });
    await execFileAsync('git', ['mv', 'old path.txt', 'new path.txt'], { cwd: dir });
    const r = await diffWorktree({ worktreePath: dir });
    // Renames collapse to single-letter status per audit m1.
    expect(r.files.some((f) => f.path === 'new path.txt' && f.status === 'R')).toBe(true);
    // Old path should NOT appear as a separate entry.
    expect(r.files.some((f) => f.path === 'old path.txt')).toBe(false);
  });
});

describe('currentBranch', () => {
  let dir = '';

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sym-gitops-'));
    await initRepo(dir);
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('reports the current branch', async () => {
    expect(await currentBranch(dir)).toBe('main');
  });

  it('returns null on detached HEAD', async () => {
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
      cwd: dir,
    });
    await execFileAsync('git', ['checkout', '-q', stdout.trim()], { cwd: dir });
    expect(await currentBranch(dir)).toBeNull();
  });
});

describe('commitAll (real git)', () => {
  let dir = '';

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sym-commit-'));
    await initRepo(dir);
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it('stages all changes and commits, returning the new SHA', async () => {
    await fs.writeFile(path.join(dir, 'NEW.md'), 'added\n', 'utf8');
    await fs.writeFile(path.join(dir, 'README.md'), '# changed\n', 'utf8');
    const r = await commitAll({
      worktreePath: dir,
      message: 'feat: add new and tweak readme',
    });
    expect(r.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(r.shortSha.length).toBe(7);
    expect(r.subject).toBe('feat: add new and tweak readme');
    expect(r.stagedFiles).toEqual(expect.arrayContaining(['NEW.md', 'README.md']));

    const { stdout } = await execFileAsync('git', ['log', '-1', '--pretty=%s'], {
      cwd: dir,
    });
    expect(stdout.trim()).toBe('feat: add new and tweak readme');
  });

  it('accepts multi-line messages via stdin without shell escaping issues', async () => {
    await fs.writeFile(path.join(dir, 'NEW.md'), 'hi\n', 'utf8');
    const message = 'feat: add\n\nDetails with "quotes" and $vars and \\backslashes.\n';
    const r = await commitAll({ worktreePath: dir, message });
    expect(r.subject).toBe('feat: add');
    const { stdout } = await execFileAsync('git', ['log', '-1', '--pretty=%B'], {
      cwd: dir,
    });
    expect(stdout).toContain('"quotes"');
    expect(stdout).toContain('$vars');
    expect(stdout).toContain('\\backslashes');
  });

  it('throws NothingToCommitError on a clean tree without allowEmpty', async () => {
    await expect(
      commitAll({ worktreePath: dir, message: 'empty' }),
    ).rejects.toBeInstanceOf(NothingToCommitError);
  });

  it('honors allowEmpty:true', async () => {
    const r = await commitAll({
      worktreePath: dir,
      message: 'empty: roll timestamp',
      allowEmpty: true,
    });
    expect(r.sha).toMatch(/^[0-9a-f]{40}$/);
  });

  it('throws when message is empty or whitespace', async () => {
    await fs.writeFile(path.join(dir, 'NEW.md'), 'hi\n', 'utf8');
    await expect(
      commitAll({ worktreePath: dir, message: '  \t\n' }),
    ).rejects.toThrow(/message must not be empty/);
  });
});

/** Create a bare remote + clone, return [bare, clone]. */
async function setupRemote(): Promise<{ bare: string; clone: string }> {
  const bare = await fs.mkdtemp(path.join(os.tmpdir(), 'sym-bare-'));
  await execFileAsync('git', ['init', '-q', '--bare', '-b', 'main'], { cwd: bare });
  const clone = await fs.mkdtemp(path.join(os.tmpdir(), 'sym-clone-'));
  await execFileAsync('git', ['clone', '-q', bare, '.'], { cwd: clone });
  await execFileAsync('git', ['config', 'user.email', 't@t'], { cwd: clone });
  await execFileAsync('git', ['config', 'user.name', 't'], { cwd: clone });
  await execFileAsync('git', ['config', 'commit.gpgsign', 'false'], { cwd: clone });
  await execFileAsync('git', ['checkout', '-q', '-b', 'main'], { cwd: clone });
  await fs.writeFile(path.join(clone, 'README.md'), '# seed\n', 'utf8');
  await execFileAsync('git', ['add', '.'], { cwd: clone });
  await execFileAsync('git', ['commit', '-q', '-m', 'seed'], { cwd: clone });
  await execFileAsync('git', ['push', '-q', '-u', 'origin', 'main'], { cwd: clone });
  return { bare, clone };
}

describe('push (real git)', () => {
  let bare = '';
  let clone = '';

  beforeEach(async () => {
    ({ bare, clone } = await setupRemote());
  });

  afterEach(async () => {
    await fs.rm(bare, { recursive: true, force: true }).catch(() => {});
    await fs.rm(clone, { recursive: true, force: true }).catch(() => {});
  });

  it('pushes a fresh branch with --set-upstream', async () => {
    await execFileAsync('git', ['checkout', '-q', '-b', 'feature/x'], { cwd: clone });
    await fs.writeFile(path.join(clone, 'A.md'), 'a\n', 'utf8');
    await execFileAsync('git', ['add', '.'], { cwd: clone });
    await execFileAsync('git', ['commit', '-q', '-m', 'add A'], { cwd: clone });

    const r = await push({ worktreePath: clone });
    expect(r.remote).toBe('origin');
    expect(r.branch).toBe('feature/x');
    expect(r.setUpstream).toBe(true);

    const { stdout } = await execFileAsync(
      'git',
      ['branch', '-a'],
      { cwd: clone },
    );
    expect(stdout).toContain('remotes/origin/feature/x');
  });

  it('throws PushRejectedError on non-fast-forward', async () => {
    // Create a parallel clone, push conflicting history to the bare.
    const rival = await fs.mkdtemp(path.join(os.tmpdir(), 'sym-rival-'));
    await execFileAsync('git', ['clone', '-q', bare, '.'], { cwd: rival });
    await execFileAsync('git', ['config', 'user.email', 't@t'], { cwd: rival });
    await execFileAsync('git', ['config', 'user.name', 't'], { cwd: rival });
    await execFileAsync('git', ['config', 'commit.gpgsign', 'false'], { cwd: rival });
    await fs.writeFile(path.join(rival, 'rival.md'), 'rival\n', 'utf8');
    await execFileAsync('git', ['add', '.'], { cwd: rival });
    await execFileAsync('git', ['commit', '-q', '-m', 'rival commit'], { cwd: rival });
    await execFileAsync('git', ['push', '-q', 'origin', 'main'], { cwd: rival });
    await fs.rm(rival, { recursive: true, force: true }).catch(() => {});

    // Now try to push our `main` back to origin — it's behind the bare.
    await fs.writeFile(path.join(clone, 'local.md'), 'local\n', 'utf8');
    await execFileAsync('git', ['add', '.'], { cwd: clone });
    await execFileAsync('git', ['commit', '-q', '-m', 'local commit'], { cwd: clone });

    await expect(
      push({ worktreePath: clone, branch: 'main' }),
    ).rejects.toBeInstanceOf(PushRejectedError);
  });
});

describe('mergeBranch (real git)', () => {
  let bare = '';
  let clone = '';

  beforeEach(async () => {
    ({ bare, clone } = await setupRemote());
    // Add a feature branch with a real commit + push.
    await execFileAsync('git', ['checkout', '-q', '-b', 'feature/y'], {
      cwd: clone,
    });
    await fs.writeFile(path.join(clone, 'feature.md'), 'feat\n', 'utf8');
    await execFileAsync('git', ['add', '.'], { cwd: clone });
    await execFileAsync('git', ['commit', '-q', '-m', 'feat commit'], {
      cwd: clone,
    });
    await execFileAsync('git', ['push', '-q', '-u', 'origin', 'feature/y'], {
      cwd: clone,
    });
    await execFileAsync('git', ['checkout', '-q', 'main'], { cwd: clone });
  });

  afterEach(async () => {
    await fs.rm(bare, { recursive: true, force: true }).catch(() => {});
    await fs.rm(clone, { recursive: true, force: true }).catch(() => {});
  });

  it('merges into target, pushes, and deletes remote branch by default', async () => {
    const r = await mergeBranch({
      repoPath: clone,
      targetBranch: 'main',
      sourceBranch: 'feature/y',
    });
    expect(r.mergeSha).toMatch(/^[0-9a-f]{40}$/);
    expect(r.targetBranch).toBe('main');
    expect(r.sourceBranch).toBe('feature/y');
    expect(r.deletedRemoteBranch).toBe(true);

    // The merge commit is visible on the remote.
    const { stdout } = await execFileAsync(
      'git',
      ['log', '-2', '--pretty=%s', 'origin/main'],
      { cwd: clone },
    );
    expect(stdout).toContain("Merge remote-tracking branch 'origin/feature/y'");

    // Remote branch is gone.
    await execFileAsync('git', ['fetch', '--prune'], { cwd: clone });
    const branches = await execFileAsync('git', ['branch', '-r'], { cwd: clone });
    expect(branches.stdout).not.toContain('origin/feature/y');
  });

  it('keeps remote branch when deleteRemoteBranch:false', async () => {
    const r = await mergeBranch({
      repoPath: clone,
      targetBranch: 'main',
      sourceBranch: 'feature/y',
      deleteRemoteBranch: false,
    });
    expect(r.deletedRemoteBranch).toBe(false);
    await execFileAsync('git', ['fetch'], { cwd: clone });
    const branches = await execFileAsync('git', ['branch', '-r'], { cwd: clone });
    expect(branches.stdout).toContain('origin/feature/y');
  });

  it('accepts a custom commit message', async () => {
    const r = await mergeBranch({
      repoPath: clone,
      targetBranch: 'main',
      sourceBranch: 'feature/y',
      commitMessage: 'merge(y): ship feature y',
      deleteRemoteBranch: false,
    });
    expect(r.mergeSha).toMatch(/^[0-9a-f]{40}$/);
    const { stdout } = await execFileAsync(
      'git',
      ['log', '-1', '--pretty=%s'],
      { cwd: clone },
    );
    expect(stdout.trim()).toBe('merge(y): ship feature y');
  });
});
