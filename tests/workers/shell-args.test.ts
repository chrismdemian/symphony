import { describe, it, expect } from 'vitest';
import { parseShellArgs } from '../../src/workers/shell-args.js';

describe('parseShellArgs — POSIX', () => {
  it('splits simple whitespace-separated args', () => {
    expect(parseShellArgs('--flag1 --flag2', { platform: 'linux' })).toEqual([
      '--flag1',
      '--flag2',
    ]);
  });

  it('preserves double-quoted strings with spaces', () => {
    expect(parseShellArgs('--message "hello world"', { platform: 'linux' })).toEqual([
      '--message',
      'hello world',
    ]);
  });

  it('preserves single-quoted strings verbatim', () => {
    expect(parseShellArgs("--path '/my dir/file'", { platform: 'linux' })).toEqual([
      '--path',
      '/my dir/file',
    ]);
  });

  it('respects backslash escape of double-quote inside double quotes', () => {
    expect(parseShellArgs('--arg "say \\"hi\\""', { platform: 'linux' })).toEqual([
      '--arg',
      'say "hi"',
    ]);
  });

  it('backslash does NOT escape inside single quotes on POSIX', () => {
    expect(parseShellArgs("'\\n'", { platform: 'linux' })).toEqual(['\\n']);
  });

  it('collapses multiple spaces between args but keeps tabs as part of tokens', () => {
    // Matches emdash ptyManager.ts:732 behaviour: only ' ' is a separator.
    expect(parseShellArgs('a    b\t c', { platform: 'linux' })).toEqual(['a', 'b\t', 'c']);
  });

  it('returns empty array for empty string', () => {
    expect(parseShellArgs('', { platform: 'linux' })).toEqual([]);
  });
});

describe('parseShellArgs — Windows', () => {
  it('preserves backslashes in Windows paths', () => {
    expect(parseShellArgs('C:\\Users\\chris\\bin\\tool.exe', { platform: 'win32' })).toEqual([
      'C:\\Users\\chris\\bin\\tool.exe',
    ]);
  });

  it('supports quoted absolute Windows paths with spaces', () => {
    expect(
      parseShellArgs('"C:\\Program Files\\tool\\tool.exe"', { platform: 'win32' }),
    ).toEqual(['C:\\Program Files\\tool\\tool.exe']);
  });

  it('allows \\" to escape a double-quote inside double quotes', () => {
    expect(parseShellArgs('"say \\"hi\\""', { platform: 'win32' })).toEqual(['say "hi"']);
  });
});

describe('parseShellArgs — warnings', () => {
  it('warns on unclosed double quote but still returns collected content', () => {
    const warnings: string[] = [];
    const result = parseShellArgs('foo "bar', {
      platform: 'linux',
      onWarning: (m) => warnings.push(m),
    });
    expect(result).toEqual(['foo', 'bar']);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toMatch(/unclosed quote/);
  });

  it('warns on unclosed single quote', () => {
    const warnings: string[] = [];
    parseShellArgs("foo 'bar", {
      platform: 'linux',
      onWarning: (m) => warnings.push(m),
    });
    expect(warnings.length).toBe(1);
  });

  it('does not warn on balanced input', () => {
    const warnings: string[] = [];
    parseShellArgs('"x" \'y\'', {
      platform: 'linux',
      onWarning: (m) => warnings.push(m),
    });
    expect(warnings.length).toBe(0);
  });

  it('handles trailing backslash literally at end of input', () => {
    expect(parseShellArgs('foo\\', { platform: 'linux' })).toEqual(['foo\\']);
  });
});
