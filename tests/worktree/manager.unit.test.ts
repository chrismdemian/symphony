import { describe, expect, it } from 'vitest';
import {
  inferProjectPath,
  isBranchCollisionError,
  slugify,
  WorktreeSafetyError,
} from '../../src/worktree/index.js';

describe('slugify', () => {
  it('lowercases and dashes word separators', () => {
    expect(slugify('Add Friend System')).toBe('add-friend-system');
  });
  it('collapses runs of dashes', () => {
    expect(slugify('--hello---world--')).toBe('hello-world');
  });
  it('strips leading and trailing dashes', () => {
    expect(slugify('  —Hi—  ')).toBe('hi');
  });
  it('truncates to 60 chars', () => {
    const long = 'x'.repeat(120);
    expect(slugify(long).length).toBe(60);
  });
  it('returns empty for non-alphanumeric input', () => {
    expect(slugify('!!!')).toBe('');
  });
});

describe('isBranchCollisionError', () => {
  it('matches the canonical git message', () => {
    expect(isBranchCollisionError("fatal: a branch named 'symphony/w1' already exists")).toBe(true);
  });
  it('matches "branch ... already exists" variants', () => {
    expect(isBranchCollisionError('branch already exists in worktree')).toBe(true);
  });
  it('rejects path collisions which are NOT branch collisions', () => {
    expect(isBranchCollisionError("fatal: '/some/path' already exists")).toBe(false);
  });
  it('returns false for unrelated errors', () => {
    expect(isBranchCollisionError('fatal: not a git repository')).toBe(false);
  });
});

describe('inferProjectPath', () => {
  it('strips the .symphony/worktrees/<id> suffix', () => {
    const p = inferProjectPath('/repo/.symphony/worktrees/w1');
    expect(p).toMatch(/repo$/);
  });
  it('throws on non-managed paths', () => {
    expect(() => inferProjectPath('/repo/foo/bar')).toThrow(WorktreeSafetyError);
  });
});
