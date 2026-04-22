import { describe, expect, it } from 'vitest';
import { parseWorktreeIncludeContent } from '../../src/worktree/worktree-include.js';

describe('parseWorktreeIncludeContent', () => {
  it('strips comments and blank lines', () => {
    const out = parseWorktreeIncludeContent('# header\n\n.env\n.envrc\n# trailing comment\n');
    expect(out).toEqual(['.env', '.envrc']);
  });

  it('trims whitespace per line', () => {
    expect(parseWorktreeIncludeContent('   .env   \n\t.envrc\t\n')).toEqual(['.env', '.envrc']);
  });

  it('keeps negation patterns verbatim', () => {
    expect(parseWorktreeIncludeContent('.env\n!.env.example\n')).toEqual(['.env', '!.env.example']);
  });

  it('handles CRLF line endings', () => {
    expect(parseWorktreeIncludeContent('# c\r\n.env\r\n.envrc\r\n')).toEqual(['.env', '.envrc']);
  });

  it('returns an empty array for an empty file', () => {
    expect(parseWorktreeIncludeContent('')).toEqual([]);
  });
});
