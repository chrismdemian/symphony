import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  DROID_FENCE_ENV,
  DROID_FENCE_MARKER,
  DROID_WORKTREE_ENV,
  buildDroidFenceEnv,
  buildDroidFenceHookCommand,
  droidIsFenced,
  resolveFenceHookScript,
} from '../../src/droids/hook-command.js';
import type { DroidDefinition } from '../../src/droids/types.js';

const def = (over: Partial<DroidDefinition> = {}): DroidDefinition => ({
  name: 'x',
  body: 'b',
  source: '<bundled:x>',
  ...over,
});

describe('resolveFenceHookScript', () => {
  it('honors the override seam', () => {
    expect(resolveFenceHookScript({ overrideScript: '/abs/fence-hook.js' })).toBe(
      '/abs/fence-hook.js',
    );
  });

  it('resolves a real on-disk script (src in dev, dist after build)', () => {
    const p = resolveFenceHookScript();
    expect(p).toMatch(/fence-hook\.(ts|js)$/);
    expect(existsSync(p)).toBe(true);
  });
});

describe('buildDroidFenceHookCommand', () => {
  it('bundled .js → static `node "<path>" --marker`', () => {
    const cmd = buildDroidFenceHookCommand({
      overrideScript: 'C:\\sym\\dist\\droids\\fence-hook.js',
    });
    expect(cmd).toBe(
      `node "C:\\sym\\dist\\droids\\fence-hook.js" ${DROID_FENCE_MARKER}`,
    );
    // NEVER `|| true` — exit 2 is the block.
    expect(cmd).not.toMatch(/\|\|\s*true/);
  });

  it('dev .ts → prepends a tsx loader and quotes the script', () => {
    const cmd = buildDroidFenceHookCommand({
      overrideScript: '/sym/src/droids/fence-hook.ts',
    });
    expect(cmd.startsWith('node ')).toBe(true);
    expect(cmd).toContain('--import');
    expect(cmd).toContain('"/sym/src/droids/fence-hook.ts"');
    expect(cmd.endsWith(DROID_FENCE_MARKER)).toBe(true);
  });
});

describe('buildDroidFenceEnv', () => {
  it('serializes the canonical policy + worktree root; exempts SYMPHONY_* keys', () => {
    const { env, allowKeys } = buildDroidFenceEnv(
      def({
        toolsAllowed: ['read', 'write'],
        toolsDenied: ['bash', 'edit'],
        writePaths: ['DESIGN.md'],
      }),
      '/wt/w1',
    );
    expect(JSON.parse(env[DROID_FENCE_ENV]!)).toEqual({
      allowed: ['Read', 'Write'],
      denied: ['Bash', 'Edit', 'MultiEdit', 'NotebookEdit'],
      writePaths: ['DESIGN.md'],
    });
    expect(env[DROID_WORKTREE_ENV]).toBe('/wt/w1');
    expect(allowKeys).toEqual([DROID_FENCE_ENV, DROID_WORKTREE_ENV]);
  });
});

describe('droidIsFenced', () => {
  it('true when any tool/write policy is declared', () => {
    expect(droidIsFenced(def({ toolsDenied: ['bash'] }))).toBe(true);
    expect(droidIsFenced(def({ writePaths: ['DESIGN.md'] }))).toBe(true);
  });
  it('false when no policy at all (guard for the no-op case)', () => {
    expect(droidIsFenced(def())).toBe(false);
  });
});
