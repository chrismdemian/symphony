import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { evaluateFence, type FencePolicy } from '../../src/droids/fence.js';

const ROOT = path.resolve('/wt/worker-1');
const inWt = (...p: string[]) => path.join(ROOT, ...p);

const policy = (over: Partial<FencePolicy> = {}): FencePolicy => ({
  allowed: [],
  denied: [],
  writePaths: [],
  worktreeRoot: ROOT,
  ...over,
});

describe('evaluateFence — tool gate', () => {
  it('deny wins over allow (Claude Code precedence parity)', () => {
    const d = evaluateFence(
      { toolName: 'Bash' },
      policy({ allowed: ['Bash'], denied: ['Bash'] }),
    );
    expect(d.allow).toBe(false);
    expect(d.reason).toMatch(/denied/);
  });

  it('strict allowlist blocks a tool not in it', () => {
    const d = evaluateFence({ toolName: 'Bash' }, policy({ allowed: ['Read', 'Grep'] }));
    expect(d.allow).toBe(false);
    expect(d.reason).toMatch(/not in this droid's allowed set/);
  });

  it('empty allowed ⇒ no allowlist (only deny applies)', () => {
    expect(evaluateFence({ toolName: 'Bash' }, policy()).allow).toBe(true);
    expect(
      evaluateFence({ toolName: 'Bash' }, policy({ denied: ['Bash'] })).allow,
    ).toBe(false);
  });

  it('allows a tool that is in the allowlist and not denied', () => {
    expect(
      evaluateFence({ toolName: 'Read' }, policy({ allowed: ['Read', 'Grep'] }))
        .allow,
    ).toBe(true);
  });
});

describe('evaluateFence — write-path gate', () => {
  const writeAllowed = policy({ allowed: ['Write'] });

  it('allows an in-worktree write when no write_paths restriction', () => {
    const d = evaluateFence(
      { toolName: 'Write', filePath: inWt('src', 'a.ts') },
      writeAllowed,
    );
    expect(d.allow).toBe(true);
  });

  it('blocks a write outside the worktree', () => {
    const d = evaluateFence(
      { toolName: 'Write', filePath: path.resolve('/etc/passwd') },
      writeAllowed,
    );
    expect(d.allow).toBe(false);
    expect(d.reason).toMatch(/outside the worktree/);
  });

  it('blocks a parent-traversal escape', () => {
    const d = evaluateFence(
      { toolName: 'Write', filePath: inWt('..', 'sibling', 'x') },
      writeAllowed,
    );
    expect(d.allow).toBe(false);
    expect(d.reason).toMatch(/outside the worktree/);
  });

  it('enforces write_paths globs (DESIGN.md allowed, others denied)', () => {
    const p = policy({ allowed: ['Write'], writePaths: ['DESIGN.md'] });
    expect(
      evaluateFence({ toolName: 'Write', filePath: inWt('DESIGN.md') }, p).allow,
    ).toBe(true);
    const blocked = evaluateFence(
      { toolName: 'Write', filePath: inWt('src', 'index.ts') },
      p,
    );
    expect(blocked.allow).toBe(false);
    expect(blocked.reason).toMatch(/not in this droid's write_paths/);
  });

  it('supports glob write_paths (src/**)', () => {
    const p = policy({ allowed: ['Edit'], writePaths: ['src/**'] });
    expect(
      evaluateFence({ toolName: 'Edit', filePath: inWt('src', 'deep', 'x.ts') }, p)
        .allow,
    ).toBe(true);
    expect(
      evaluateFence({ toolName: 'Edit', filePath: inWt('README.md') }, p).allow,
    ).toBe(false);
  });

  it('blocks a write tool with no resolvable target (fail safe)', () => {
    const d = evaluateFence({ toolName: 'Write' }, writeAllowed);
    expect(d.allow).toBe(false);
    expect(d.reason).toMatch(/no resolvable target/);
  });

  it('non-write tools never trip the path gate', () => {
    expect(
      evaluateFence({ toolName: 'Grep' }, policy({ allowed: ['Grep'] })).allow,
    ).toBe(true);
  });

  it('NotebookEdit + MultiEdit are write-fenced too', () => {
    const p = policy({ allowed: ['NotebookEdit', 'MultiEdit'], writePaths: ['nb/**'] });
    expect(
      evaluateFence({ toolName: 'NotebookEdit', filePath: inWt('other.ipynb') }, p)
        .allow,
    ).toBe(false);
    expect(
      evaluateFence({ toolName: 'MultiEdit', filePath: inWt('nb', 'x.ipynb') }, p)
        .allow,
    ).toBe(true);
  });
});
