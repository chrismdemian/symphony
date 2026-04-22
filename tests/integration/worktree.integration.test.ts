import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { WorktreeManager } from '../../src/worktree/manager.js';
import { WorktreeSafetyError } from '../../src/worktree/safety.js';

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
  writeFileSync(path.join(repoPath, '.gitignore'), '.env\n.env.local\nnode_modules/\n');
  await git(repoPath, 'add', '.');
  await git(repoPath, 'commit', '-m', 'init');
}

let sandbox: string;
let repoPath: string;
let manager: WorktreeManager;

beforeEach(async () => {
  sandbox = mkdtempSync(path.join(tmpdir(), 'symphony-wt-int-'));
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

describe('WorktreeManager.create', () => {
  it('creates a worktree under .symphony/worktrees/<workerId>', async () => {
    const info = await manager.create({
      projectPath: repoPath,
      workerId: 'w-alpha',
      shortDescription: 'add friend system',
    });
    expect(info.path).toBe(path.join(repoPath, '.symphony', 'worktrees', 'w-alpha'));
    expect(existsSync(info.path)).toBe(true);
    expect(info.branch).toBe('symphony/w-alpha/add-friend-system');

    const list = await manager.list(repoPath);
    expect(list.some((w) => w.path === info.path)).toBe(true);
  });

  it('writes default exclude patterns to .git/info/exclude', async () => {
    const info = await manager.create({ projectPath: repoPath, workerId: 'w-exc' });
    const gitDirOut = await git(info.path, 'rev-parse', '--git-dir');
    const gitDir = gitDirOut.trim();
    const absGitDir = path.isAbsolute(gitDir) ? gitDir : path.join(info.path, gitDir);
    const excludeContent = readFileSync(path.join(absGitDir, 'info', 'exclude'), 'utf8');
    for (const pattern of ['.agent_context', 'CLAUDE.md', 'AGENTS.md', '.symphony/', '.claude/']) {
      expect(excludeContent).toContain(pattern);
    }
  });

  it('preserves .env from the project root into the worktree', async () => {
    writeFileSync(path.join(repoPath, '.env'), 'API_KEY=secret\n');
    const info = await manager.create({ projectPath: repoPath, workerId: 'w-env' });
    expect(readFileSync(path.join(info.path, '.env'), 'utf8')).toBe('API_KEY=secret\n');
  });

  it('respects .worktreeinclude precedence over .symphony.json', async () => {
    writeFileSync(path.join(repoPath, '.gitignore'), 'secrets.json\nignored-from-json.txt\nfrom-include.txt\n');
    await git(repoPath, 'add', '.gitignore');
    await git(repoPath, 'commit', '-m', 'gitignore tweak');

    writeFileSync(path.join(repoPath, '.symphony.json'), JSON.stringify({ preservePatterns: ['ignored-from-json.txt'] }));
    writeFileSync(path.join(repoPath, '.worktreeinclude'), '# header\nfrom-include.txt\n');
    writeFileSync(path.join(repoPath, 'from-include.txt'), 'I-was-included');
    writeFileSync(path.join(repoPath, 'ignored-from-json.txt'), 'I-was-NOT-included');

    const info = await manager.create({ projectPath: repoPath, workerId: 'w-prec' });
    expect(existsSync(path.join(info.path, 'from-include.txt'))).toBe(true);
    expect(existsSync(path.join(info.path, 'ignored-from-json.txt'))).toBe(false);
  });

  it('retries with timestamped branch name on branch collision', async () => {
    await git(repoPath, 'branch', 'symphony/w-collide/x');
    const info = await manager.create({
      projectPath: repoPath,
      workerId: 'w-collide',
      shortDescription: 'x',
    });
    expect(info.branch).toMatch(/^symphony\/w-collide\/x-\d+$/);
  });

  it('serializes concurrent create calls on the same project', async () => {
    const [a, b, c] = await Promise.all([
      manager.create({ projectPath: repoPath, workerId: 'w-c1' }),
      manager.create({ projectPath: repoPath, workerId: 'w-c2' }),
      manager.create({ projectPath: repoPath, workerId: 'w-c3' }),
    ]);
    expect(new Set([a.path, b.path, c.path]).size).toBe(3);
  });
});

describe('WorktreeManager.removeIfClean / remove', () => {
  it('removes a clean worktree and deletes the branch', async () => {
    const info = await manager.create({ projectPath: repoPath, workerId: 'w-clean' });
    expect(await manager.removeIfClean(info.path)).toBe(true);
    expect(existsSync(info.path)).toBe(false);
    const branches = await git(repoPath, 'branch', '--list', info.branch);
    expect(branches.trim()).toBe('');
  });

  it('refuses to remove if there are uncommitted changes', async () => {
    const info = await manager.create({ projectPath: repoPath, workerId: 'w-dirty' });
    writeFileSync(path.join(info.path, 'untracked.txt'), 'hello');
    expect(await manager.removeIfClean(info.path)).toBe(false);
    expect(existsSync(info.path)).toBe(true);
  });

  it('forces remove of a dirty worktree via remove()', async () => {
    const info = await manager.create({ projectPath: repoPath, workerId: 'w-force' });
    writeFileSync(path.join(info.path, 'dirty.txt'), 'changed');
    await manager.remove(info.path);
    expect(existsSync(info.path)).toBe(false);
  });

  it('refuses to remove the main repo path', async () => {
    await expect(manager.remove(repoPath)).rejects.toBeInstanceOf(WorktreeSafetyError);
  });
});

describe('WorktreeManager.status', () => {
  it('reports staged + unstaged + untracked', async () => {
    const info = await manager.create({ projectPath: repoPath, workerId: 'w-stat' });
    writeFileSync(path.join(info.path, 'README.md'), '# changed\n');
    writeFileSync(path.join(info.path, 'new.txt'), 'new');
    await git(info.path, 'add', 'README.md');
    const status = await manager.status(info.path);
    expect(status.hasChanges).toBe(true);
    expect(status.staged).toContain('README.md');
    expect(status.untracked).toContain('new.txt');
  });
});
