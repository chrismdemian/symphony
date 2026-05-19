import { describe, expect, it } from 'vitest';

import {
  assertSafeDroidName,
  DROID_TOOL_ALIASES,
  DroidNameError,
  resolveDroidToolPolicy,
  type DroidDefinition,
} from '../../src/droids/types.js';

const base: DroidDefinition = {
  name: 'x',
  body: 'b',
  source: '<bundled:x>',
};

// Built programmatically so the source stays pure ASCII (no literal
// control byte, no ESLint no-control-characters / irregular-whitespace).
const NUL = String.fromCharCode(0);

describe('assertSafeDroidName', () => {
  it('accepts clean role-token names', () => {
    for (const n of ['dhh-reviewer', 'design-researcher', 'a', 'A1', 'x_y-9']) {
      expect(assertSafeDroidName(n)).toBe(n);
    }
  });

  it('trims surrounding whitespace', () => {
    expect(assertSafeDroidName('  dhh-reviewer  ')).toBe('dhh-reviewer');
  });

  it.each([
    ['empty', ''],
    ['blank', '   '],
    ['leading dot', '.hidden'],
    ['bare dot', '.'],
    ['dotdot', '..'],
    ['forward slash', 'a/b'],
    ['back slash', 'a\\b'],
    ['leading dash', '-x'],
    ['leading underscore', '_x'],
    ['inner space', 'a b'],
    ['nul byte', `a${NUL}b`],
    ['non-ascii', 'resumé'],
    ['too long', 'a'.repeat(65)],
  ])('rejects %s', (_label, value) => {
    expect(() => assertSafeDroidName(value)).toThrow(DroidNameError);
  });
});

describe('resolveDroidToolPolicy', () => {
  it('expands lowercase tokens to canonical Claude Code tool names', () => {
    const p = resolveDroidToolPolicy({
      ...base,
      toolsAllowed: ['read', 'grep', 'glob', 'write'],
      toolsDenied: ['bash', 'edit'],
      writePaths: ['DESIGN.md'],
    });
    expect(p.allowed).toEqual(['Read', 'Grep', 'Glob', 'Write']);
    // `edit` fans out to every file-mutation tool — a droid that denies
    // `edit` must not slip through MultiEdit/NotebookEdit.
    expect(p.denied).toEqual(['Bash', 'Edit', 'MultiEdit', 'NotebookEdit']);
    expect(p.writePaths).toEqual(['DESIGN.md']);
  });

  it('de-duplicates overlapping expansions, preserves first-seen order', () => {
    const p = resolveDroidToolPolicy({
      ...base,
      toolsAllowed: ['edit', 'write', 'edit'],
    });
    expect(p.allowed).toEqual(['Edit', 'MultiEdit', 'NotebookEdit', 'Write']);
  });

  it('absent lists yield empty arrays (no allowlist / no denylist)', () => {
    const p = resolveDroidToolPolicy(base);
    expect(p.allowed).toEqual([]);
    expect(p.denied).toEqual([]);
    expect(p.writePaths).toEqual([]);
  });

  it('every alias maps to at least one PascalCase canonical tool', () => {
    for (const [token, canon] of Object.entries(DROID_TOOL_ALIASES)) {
      expect(canon.length).toBeGreaterThan(0);
      for (const c of canon) expect(c).toMatch(/^[A-Z][A-Za-z]+$/);
      expect(token).toBe(token.toLowerCase());
    }
  });
});
