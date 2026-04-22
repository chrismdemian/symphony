import { describe, expect, it } from 'vitest';
import {
  assertWorktreeRemovable,
  looksLikeManagedWorktree,
  parseWorktreePorcelain,
  pathResolvesEqual,
  WorktreeSafetyError,
} from '../../src/worktree/safety.js';

describe('pathResolvesEqual', () => {
  it('treats trailing slashes as equal', () => {
    expect(pathResolvesEqual('/a/b', '/a/b/')).toBe(true);
  });
  it('returns false for different paths', () => {
    expect(pathResolvesEqual('/a/b', '/a/c')).toBe(false);
  });
});

describe('looksLikeManagedWorktree', () => {
  it('matches POSIX .symphony/worktrees/ paths', () => {
    expect(looksLikeManagedWorktree('/repo/.symphony/worktrees/w1')).toBe(true);
  });
  it('matches Windows .symphony\\worktrees\\ paths', () => {
    // path.resolve normalizes to the host platform, but a Windows-style
    // input passed on POSIX still keeps backslashes; we accept either.
    if (process.platform === 'win32') {
      expect(looksLikeManagedWorktree('C:\\repo\\.symphony\\worktrees\\w1')).toBe(true);
    } else {
      expect(looksLikeManagedWorktree('/repo/.symphony/worktrees/w1')).toBe(true);
    }
  });
  it('matches plain worktrees/ segment too', () => {
    expect(looksLikeManagedWorktree('/repo/worktrees/w1')).toBe(true);
  });
  it('rejects unrelated paths', () => {
    expect(looksLikeManagedWorktree('/repo/src')).toBe(false);
  });
});

describe('parseWorktreePorcelain', () => {
  it('flags the first block as main', () => {
    const stdout =
      'worktree /repo\nHEAD abc\nbranch refs/heads/master\n\n' +
      'worktree /repo/.symphony/worktrees/w1\nHEAD def\nbranch refs/heads/symphony/w1\n';
    const parsed = parseWorktreePorcelain(stdout);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toMatchObject({ worktreePath: '/repo', isMain: true, isBare: false });
    expect(parsed[1]).toMatchObject({
      worktreePath: '/repo/.symphony/worktrees/w1',
      isMain: false,
      isBare: false,
    });
  });
  it('flags bare blocks', () => {
    const stdout = 'worktree /bare\nbare\n';
    const parsed = parseWorktreePorcelain(stdout);
    expect(parsed[0]?.isBare).toBe(true);
  });
});

describe('assertWorktreeRemovable', () => {
  const fakeRunGit = (out: string) => async () => out;

  it('rejects when worktree path equals project path', async () => {
    await expect(
      assertWorktreeRemovable(
        { worktreePath: '/repo', projectPath: '/repo' },
        { runGit: fakeRunGit('') },
      ),
    ).rejects.toBeInstanceOf(WorktreeSafetyError);
  });

  it('rejects when path is not in a managed worktree segment', async () => {
    await expect(
      assertWorktreeRemovable(
        { worktreePath: '/repo/random', projectPath: '/repo' },
        { runGit: fakeRunGit('worktree /repo\n\nworktree /repo/random\n') },
      ),
    ).rejects.toThrow(/does not look like a managed worktree/);
  });

  it('rejects when porcelain says main worktree', async () => {
    await expect(
      assertWorktreeRemovable(
        { worktreePath: '/repo/.symphony/worktrees/w1', projectPath: '/repo' },
        { runGit: fakeRunGit('worktree /repo/.symphony/worktrees/w1\n') },
      ),
    ).rejects.toThrow(/main worktree/);
  });

  it('rejects when porcelain has no matching entry', async () => {
    await expect(
      assertWorktreeRemovable(
        { worktreePath: '/repo/.symphony/worktrees/w1', projectPath: '/repo' },
        { runGit: fakeRunGit('worktree /repo\n\nworktree /repo/.symphony/worktrees/other\n') },
      ),
    ).rejects.toThrow(/not a linked worktree/);
  });

  it('accepts a valid managed worktree', async () => {
    await expect(
      assertWorktreeRemovable(
        { worktreePath: '/repo/.symphony/worktrees/w1', projectPath: '/repo' },
        {
          runGit: fakeRunGit(
            'worktree /repo\n\nworktree /repo/.symphony/worktrees/w1\nbranch refs/heads/symphony/w1\n',
          ),
        },
      ),
    ).resolves.toBeUndefined();
  });
});
