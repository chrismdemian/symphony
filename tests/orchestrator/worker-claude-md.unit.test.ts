import { execFile } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  defaultInjectWorkerClaudeMd,
  WORKER_CLAUDE_MD_SENTINEL,
} from '../../src/orchestrator/worker-claude-md.js';
import { DEFAULT_GIT_EXCLUDE_PATTERNS } from '../../src/worktree/types.js';

const execFileAsync = promisify(execFile);
const git = (cwd: string, ...args: string[]) =>
  execFileAsync('git', args, { cwd });

const MANUAL = '## Your Role: Implementer\n\nbody.\n';

let dir: string;
beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'symphony-wcm-'));
  await git(dir, 'init', '--initial-branch=main');
  await git(dir, 'config', 'user.email', 't@e.com');
  await git(dir, 'config', 'user.name', 'T');
  await git(dir, 'config', 'commit.gpgsign', 'false');
  await fsp.writeFile(path.join(dir, 'README.md'), '# r\n');
  await git(dir, 'add', '.');
  await git(dir, 'commit', '-m', 'init');
});
afterEach(async () => {
  await fsp.rm(dir, { recursive: true, force: true });
});

describe('defaultInjectWorkerClaudeMd', () => {
  it('writes <worktree>/CLAUDE.md = sentinel + manual when untracked', async () => {
    const res = await defaultInjectWorkerClaudeMd(dir, MANUAL);
    expect(res).toEqual({ mode: 'claude-md', reused: false });
    const written = await fsp.readFile(path.join(dir, 'CLAUDE.md'), 'utf8');
    expect(written).toBe(`${WORKER_CLAUDE_MD_SENTINEL}${MANUAL}`);
  });

  it('detects reuse when the existing CLAUDE.md already has our sentinel', async () => {
    await defaultInjectWorkerClaudeMd(dir, MANUAL);
    const second = await defaultInjectWorkerClaudeMd(dir, '## Your Role: Reviewer\n');
    expect(second).toEqual({ mode: 'claude-md', reused: true });
    expect(await fsp.readFile(path.join(dir, 'CLAUDE.md'), 'utf8')).toBe(
      `${WORKER_CLAUDE_MD_SENTINEL}## Your Role: Reviewer\n`,
    );
  });

  it('never overwrites a git-TRACKED project CLAUDE.md (stdin fallback)', async () => {
    const projectClaudeMd = '# Project Conventions\n\nUse pnpm.\n';
    await fsp.writeFile(path.join(dir, 'CLAUDE.md'), projectClaudeMd);
    await git(dir, 'add', 'CLAUDE.md');
    await git(dir, 'commit', '-m', 'add project CLAUDE.md');

    const res = await defaultInjectWorkerClaudeMd(dir, MANUAL);
    expect(res).toEqual({
      mode: 'stdin-fallback',
      reason: 'project-tracks-claude-md',
    });
    // The user's tracked file is untouched.
    expect(await fsp.readFile(path.join(dir, 'CLAUDE.md'), 'utf8')).toBe(
      projectClaudeMd,
    );
  });

  it('falls back when the path is not a directory', async () => {
    const res = await defaultInjectWorkerClaudeMd(
      path.join(dir, 'does-not-exist'),
      MANUAL,
    );
    expect(res).toEqual({
      mode: 'stdin-fallback',
      reason: 'not-a-worktree-dir',
    });
  });

  it('leaves no tmp file behind after an atomic write', async () => {
    await defaultInjectWorkerClaudeMd(dir, MANUAL);
    const leftovers = (await fsp.readdir(dir)).filter((f) =>
      f.startsWith('CLAUDE.md.tmp-'),
    );
    expect(leftovers).toEqual([]);
  });
});

describe('4D.2 exclude coordination (PLAN bullet 3)', () => {
  it('CLAUDE.md is already in DEFAULT_GIT_EXCLUDE_PATTERNS (no code change needed)', () => {
    // worktreeManager.create() writes these to .git/info/exclude, so an
    // injected (untracked) CLAUDE.md never shows in git status / commits.
    expect(DEFAULT_GIT_EXCLUDE_PATTERNS).toContain('CLAUDE.md');
  });
});
