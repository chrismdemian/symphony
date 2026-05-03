import { describe, it, expect } from 'vitest';
import {
  RESULT_CHAR_BUDGET,
  RESULT_LINE_BUDGET,
  extractToolSummary,
  formatToolResult,
} from '../../../../src/ui/panels/chat/extractSummary.js';

describe('extractToolSummary', () => {
  it('returns the file_path field when present', () => {
    expect(extractToolSummary({ file_path: '/tmp/foo.txt' })).toBe('/tmp/foo.txt');
  });

  it('falls back to path when file_path is absent', () => {
    expect(extractToolSummary({ path: '/etc/hosts' })).toBe('/etc/hosts');
  });

  it('uses command for Bash-style invocations', () => {
    expect(extractToolSummary({ command: 'ls -la' })).toBe('ls -la');
  });

  it('uses pattern (Grep) before query (Tasks)', () => {
    expect(extractToolSummary({ pattern: 'TODO\\b', query: 'unused' })).toBe('TODO\\b');
  });

  it('uses query when pattern absent', () => {
    expect(extractToolSummary({ query: 'find me workers' })).toBe('find me workers');
  });

  it('uses prompt when nothing else matches', () => {
    expect(extractToolSummary({ prompt: 'classify this' })).toBe('classify this');
  });

  it('flattens interior newlines so the summary stays one line', () => {
    expect(extractToolSummary({ command: 'git\nstatus\n' })).toBe('git status');
  });

  it('respects priority: file_path > path > command > pattern > query > prompt', () => {
    expect(
      extractToolSummary({
        file_path: '/a',
        path: '/b',
        command: 'c',
        pattern: 'd',
        query: 'e',
        prompt: 'f',
      }),
    ).toBe('/a');
  });

  it('truncates long values at the 60-char budget with an ellipsis', () => {
    const long = 'x'.repeat(80);
    const result = extractToolSummary({ file_path: long });
    expect(result.length).toBe(60);
    expect(result.endsWith('…')).toBe(true);
  });

  it('falls back to compact JSON for unknown shapes', () => {
    const result = extractToolSummary({ foo: 'bar', n: 1 });
    expect(result).toContain('"foo"');
    expect(result).toContain('"bar"');
  });

  it('returns empty string for an empty input object', () => {
    expect(extractToolSummary({})).toBe('');
  });

  it('returns empty string when ALL canonical fields are null (audit M2)', () => {
    // Mid-flight or malformed tool inputs may have `null` values. Bare
    // tool-name header is a better UX than a JSON-noise summary.
    expect(extractToolSummary({ file_path: null })).toBe('');
    expect(extractToolSummary({ command: null, query: null })).toBe('');
  });

  it('returns empty string when ALL canonical fields are undefined', () => {
    expect(extractToolSummary({ file_path: undefined, path: undefined })).toBe('');
  });

  it('skips non-string canonical fields (e.g. file_path: 123) and falls through to JSON', () => {
    // Numeric file_path is unexpected but defensive: don't crash, fall
    // back to JSON.stringify since the field is non-null.
    const result = extractToolSummary({ file_path: 123 });
    expect(result).toContain('123');
  });

  it('skips empty-string canonical fields and falls through', () => {
    expect(extractToolSummary({ file_path: '', command: 'mkdir x' })).toBe('mkdir x');
  });
});

describe('formatToolResult', () => {
  it('returns content as-is when small and clean', () => {
    expect(formatToolResult('hello\nworld')).toBe('hello\nworld');
  });

  it('strips ANSI escape sequences', () => {
    expect(formatToolResult('\x1b[31mred\x1b[0m text')).toBe('red text');
  });

  it('strips multiple ANSI codes including 256-color and truecolor', () => {
    const ansi = '\x1b[38;2;124;111;235mviolet\x1b[0m';
    expect(formatToolResult(ansi)).toBe('violet');
  });

  it('normalizes CRLF to LF', () => {
    expect(formatToolResult('a\r\nb\r\nc')).toBe('a\nb\nc');
  });

  it('returns empty string for empty input after stripping', () => {
    expect(formatToolResult('')).toBe('');
    expect(formatToolResult('\x1b[0m')).toBe('');
  });

  it('truncates content over the 1500-char budget with an ellipsis', () => {
    const big = 'x'.repeat(RESULT_CHAR_BUDGET + 100);
    const result = formatToolResult(big);
    expect(result.length).toBe(RESULT_CHAR_BUDGET);
    expect(result.endsWith('…')).toBe(true);
  });

  it('does NOT truncate exactly-at-budget content', () => {
    const exact = 'x'.repeat(RESULT_CHAR_BUDGET);
    expect(formatToolResult(exact)).toBe(exact);
  });

  it('caps line count at RESULT_LINE_BUDGET with a "more lines" suffix (audit M4)', () => {
    const lines = Array.from({ length: RESULT_LINE_BUDGET + 5 }, (_, i) => `line ${i}`);
    const out = formatToolResult(lines.join('\n'));
    const outLines = out.split('\n');
    expect(outLines).toHaveLength(RESULT_LINE_BUDGET + 1);
    expect(outLines[RESULT_LINE_BUDGET]).toBe('… 5 more lines');
  });

  it('uses singular "line" suffix when only ONE line is hidden', () => {
    const lines = Array.from({ length: RESULT_LINE_BUDGET + 1 }, (_, i) => `line ${i}`);
    const out = formatToolResult(lines.join('\n'));
    const outLines = out.split('\n');
    expect(outLines[RESULT_LINE_BUDGET]).toBe('… 1 more line');
  });

  it('does NOT add the more-lines suffix when content fits exactly', () => {
    const lines = Array.from({ length: RESULT_LINE_BUDGET }, (_, i) => `line ${i}`);
    const out = formatToolResult(lines.join('\n'));
    expect(out.split('\n')).toHaveLength(RESULT_LINE_BUDGET);
    expect(out).not.toContain('more line');
  });
});
