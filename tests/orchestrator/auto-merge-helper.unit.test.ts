import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  parseYesNo,
  performMergeAndCleanup,
  resolveDefaultMergeTo,
  type AutoMergeGitOps,
  type WorktreeRemover,
} from '../../src/orchestrator/auto-merge-helper.js';
import {
  GitOpsError,
  MergeConflictError,
} from '../../src/orchestrator/git-ops.js';

/**
 * Phase 3O.1 — auto-merge-helper unit tests.
 *
 * `performMergeAndCleanup` uses dependency injection (AutoMergeGitOps +
 * WorktreeRemover) so we exercise the composition without real git.
 * `resolveDefaultMergeTo` runs against a real tmp git repo since it's a
 * thin wrapper over `git symbolic-ref` / `git rev-parse`.
 */

const execFileAsync = promisify(execFile);

describe('parseYesNo (3O.1)', () => {
  it.each([
    ['y', 'yes'],
    ['Y', 'yes'],
    ['yes', 'yes'],
    ['Yes', 'yes'],
    ['YES', 'yes'],
    ['  y  ', 'yes'],
    ['  yes\n', 'yes'],
    ['n', 'no'],
    ['N', 'no'],
    ['no', 'no'],
    ['NO', 'no'],
    [' no ', 'no'],
  ] as const)('parses %j as %s', (input, expected) => {
    expect(parseYesNo(input)).toBe(expected);
  });

  it.each([
    '',
    '   ',
    'maybe',
    'nope',
    'yeahh',
    'y!',
    '1',
    '0',
    'true',
    'merge',
    'ok',
  ])('returns null for %j (fail-safe)', (input) => {
    expect(parseYesNo(input)).toBeNull();
  });
});

describe('resolveDefaultMergeTo (3O.1)', () => {
  let dir = '';

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sym-resolve-default-'));
    await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
    await execFileAsync('git', ['config', 'user.email', 't@t'], { cwd: dir });
    await execFileAsync('git', ['config', 'user.name', 't'], { cwd: dir });
    await execFileAsync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
    await fs.writeFile(path.join(dir, 'seed.md'), 'seed\n', 'utf8');
    await execFileAsync('git', ['add', '.'], { cwd: dir });
    await execFileAsync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it('returns local main when no origin/HEAD set', async () => {
    expect(await resolveDefaultMergeTo(dir)).toBe('main');
  });

  it('returns master when neither main nor origin exists', async () => {
    // Rename main → master, then check.
    await execFileAsync('git', ['branch', '-m', 'main', 'master'], { cwd: dir });
    expect(await resolveDefaultMergeTo(dir)).toBe('master');
  });

  it('returns master fallback when no branches exist (impossible in practice; defensive)', async () => {
    // Empty (no commits, no branches). Init a bare repo so refs/heads is empty.
    const bare = await fs.mkdtemp(path.join(os.tmpdir(), 'sym-bare-'));
    await execFileAsync('git', ['init', '-q', '--bare'], { cwd: bare });
    expect(await resolveDefaultMergeTo(bare)).toBe('master');
    await fs.rm(bare, { recursive: true, force: true }).catch(() => {});
  });
});

function makeFakeGitOps(merge: AutoMergeGitOps['mergeBranch']): AutoMergeGitOps {
  return { mergeBranch: merge };
}

function makeFakeWorktree(
  remove: WorktreeRemover['remove'] = vi.fn(async () => {}),
): WorktreeRemover {
  return { remove } as WorktreeRemover;
}

describe('performMergeAndCleanup (3O.1)', () => {
  it('returns ok=true + cleans up on happy path', async () => {
    const merge = vi.fn(async () => ({
      mergeSha: 'm'.repeat(40),
      targetBranch: 'main',
      sourceBranch: 'feature/x',
      deletedRemoteBranch: true,
    }));
    const remove = vi.fn(async () => undefined);
    const result = await performMergeAndCleanup(
      {
        worktreePath: '/tmp/wt',
        repoPath: '/tmp/repo',
        sourceBranch: 'feature/x',
        mergeTo: 'main',
      },
      makeFakeGitOps(merge),
      makeFakeWorktree(remove),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.mergeSha).toBe('m'.repeat(40));
      expect(result.deletedRemoteBranch).toBe(true);
      expect(result.cleanupError).toBeUndefined();
    }
    expect(merge).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith('/tmp/wt', { deleteBranch: true });
  });

  it('passes through sourceRemote when provided', async () => {
    let receivedRemote: string | undefined;
    const merge: AutoMergeGitOps['mergeBranch'] = async (opts) => {
      receivedRemote = opts.sourceRemote;
      return {
        mergeSha: 'a'.repeat(40),
        targetBranch: 'main',
        sourceBranch: 'feature/x',
        deletedRemoteBranch: true,
      };
    };
    await performMergeAndCleanup(
      {
        worktreePath: '/tmp/wt',
        repoPath: '/tmp/repo',
        sourceBranch: 'feature/x',
        mergeTo: 'main',
        sourceRemote: 'upstream',
      },
      makeFakeGitOps(merge),
      makeFakeWorktree(),
    );
    expect(receivedRemote).toBe('upstream');
  });

  it('returns ok=false on MergeConflictError; worktree NOT removed', async () => {
    const merge = vi.fn(async () => {
      throw new MergeConflictError('conflict', 'CONFLICT (content)', 1);
    });
    const remove = vi.fn(async () => undefined);
    const result = await performMergeAndCleanup(
      {
        worktreePath: '/tmp/wt',
        repoPath: '/tmp/repo',
        sourceBranch: 'feature/x',
        mergeTo: 'main',
      },
      makeFakeGitOps(merge),
      makeFakeWorktree(remove),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(MergeConflictError);
    }
    expect(remove).not.toHaveBeenCalled();
  });

  it('returns ok=false on GitOpsError (e.g., push reject); worktree NOT removed', async () => {
    const merge = vi.fn(async () => {
      throw new GitOpsError('git push rejected: non-fast-forward', {
        stderr: '! [rejected]',
        exitCode: 1,
      });
    });
    const remove = vi.fn(async () => undefined);
    const result = await performMergeAndCleanup(
      {
        worktreePath: '/tmp/wt',
        repoPath: '/tmp/repo',
        sourceBranch: 'feature/x',
        mergeTo: 'main',
      },
      makeFakeGitOps(merge),
      makeFakeWorktree(remove),
    );
    expect(result.ok).toBe(false);
    expect(remove).not.toHaveBeenCalled();
  });

  it('cleanup failure does NOT mask merge success', async () => {
    const merge = vi.fn(async () => ({
      mergeSha: 'b'.repeat(40),
      targetBranch: 'main',
      sourceBranch: 'feature/x',
      deletedRemoteBranch: true,
    }));
    const remove = vi.fn(async () => {
      throw new Error('worktree busy');
    });
    const result = await performMergeAndCleanup(
      {
        worktreePath: '/tmp/wt',
        repoPath: '/tmp/repo',
        sourceBranch: 'feature/x',
        mergeTo: 'main',
      },
      makeFakeGitOps(merge),
      makeFakeWorktree(remove),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.mergeSha).toBe('b'.repeat(40));
      expect(result.cleanupError?.message).toBe('worktree busy');
    }
  });

  it('coerces non-Error throws to Error', async () => {
    const merge = vi.fn(async () => {
      throw 'string thrown' as unknown as Error;
    });
    const result = await performMergeAndCleanup(
      {
        worktreePath: '/tmp/wt',
        repoPath: '/tmp/repo',
        sourceBranch: 'feature/x',
        mergeTo: 'main',
      },
      makeFakeGitOps(merge),
      makeFakeWorktree(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(Error);
      expect(result.error.message).toBe('string thrown');
    }
  });
});
