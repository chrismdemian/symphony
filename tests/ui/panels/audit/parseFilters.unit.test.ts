import { describe, it, expect } from 'vitest';
import { parseLogFilter } from '../../../../src/ui/panels/audit/parseFilters.js';

const NOW = 1_700_000_000_000;

describe('parseLogFilter', () => {
  it('empty input → empty filter, no errors', () => {
    const f = parseLogFilter('', NOW);
    expect(f.errors).toEqual([]);
    expect(f.projectName).toBeUndefined();
    expect(f.kinds).toBeUndefined();
  });

  it('--project captures the name verbatim', () => {
    const f = parseLogFilter('--project MathScrabble', NOW);
    expect(f.projectName).toBe('MathScrabble');
  });

  it('--project accepts multi-word names', () => {
    const f = parseLogFilter('--project My Cool Project --severity error', NOW);
    expect(f.projectName).toBe('My Cool Project');
    expect(f.severity).toBe('error');
  });

  it('--last resolves to a sinceTs relative to nowMs', () => {
    const f = parseLogFilter('--last 1h', NOW);
    expect(f.sinceTs).toBe(new Date(NOW - 3_600_000).toISOString());
  });

  it('--last accepts compound durations', () => {
    const f = parseLogFilter('--last 2h30m', NOW);
    expect(f.sinceTs).toBe(
      new Date(NOW - (2 * 3_600_000 + 30 * 60_000)).toISOString(),
    );
  });

  it('invalid --last surfaces an error and no sinceTs', () => {
    const f = parseLogFilter('--last bogus', NOW);
    expect(f.sinceTs).toBeUndefined();
    expect(f.errors.some((e) => e.includes('invalid --last'))).toBe(true);
  });

  it('--type accepts exact kind names', () => {
    const f = parseLogFilter('--type merge_performed,worker_failed', NOW);
    expect(f.kinds).toEqual(['merge_performed', 'worker_failed']);
  });

  it('--type expands category aliases', () => {
    const f = parseLogFilter('--type tool', NOW);
    expect(f.kinds).toEqual(['tool_called', 'tool_denied', 'tool_error']);
  });

  it('--type merges aliases + exact kinds, dedupes', () => {
    const f = parseLogFilter('--type tool,tool_called', NOW);
    expect(f.kinds).toEqual(['tool_called', 'tool_denied', 'tool_error']);
  });

  it('--type with spaces after commas still parses', () => {
    const f = parseLogFilter('--type merge, question', NOW);
    expect(f.kinds).toContain('merge_performed');
    expect(f.kinds).toContain('question_asked');
  });

  it('unknown --type token surfaces an error but keeps valid ones', () => {
    const f = parseLogFilter('--type merge,frobnicate', NOW);
    expect(f.kinds).toContain('merge_performed');
    expect(f.errors.some((e) => e.includes('unknown --type'))).toBe(true);
  });

  it('--severity validates the enum', () => {
    expect(parseLogFilter('--severity warn', NOW).severity).toBe('warn');
    expect(parseLogFilter('--severity ERROR', NOW).severity).toBe('error');
    const bad = parseLogFilter('--severity loud', NOW);
    expect(bad.severity).toBeUndefined();
    expect(bad.errors.some((e) => e.includes('invalid --severity'))).toBe(true);
  });

  it('--worker captures the id', () => {
    expect(parseLogFilter('--worker w-abc123', NOW).workerId).toBe('w-abc123');
  });

  it('--limit parses a positive int; rejects junk', () => {
    expect(parseLogFilter('--limit 50', NOW).limit).toBe(50);
    // Zero is captured as a value then rejected as invalid.
    const zero = parseLogFilter('--limit 0', NOW);
    expect(zero.limit).toBeUndefined();
    expect(zero.errors.some((e) => e.includes('invalid --limit'))).toBe(true);
    // A leading-dash value (`-3`) reads as a flag, so --limit gets no
    // value — still an error, just a different one. Either way: no limit.
    const neg = parseLogFilter('--limit -3', NOW);
    expect(neg.limit).toBeUndefined();
    expect(neg.errors.length).toBeGreaterThan(0);
  });

  it('short flags work (-p -l -t -s -w -n)', () => {
    const f = parseLogFilter('-p Foo -l 1h -t merge -s warn -w w1 -n 10', NOW);
    expect(f.projectName).toBe('Foo');
    expect(f.sinceTs).toBe(new Date(NOW - 3_600_000).toISOString());
    expect(f.kinds).toContain('merge_performed');
    expect(f.severity).toBe('warn');
    expect(f.workerId).toBe('w1');
    expect(f.limit).toBe(10);
  });

  it('unknown flag surfaces an error and skips its value', () => {
    const f = parseLogFilter('--frobnicate foo --severity warn', NOW);
    expect(f.errors.some((e) => e.includes('unknown flag'))).toBe(true);
    expect(f.severity).toBe('warn');
  });

  it('flag with missing value surfaces an error', () => {
    const f = parseLogFilter('--project', NOW);
    expect(f.errors.some((e) => e.includes('expects a value'))).toBe(true);
  });

  it('full realistic filter string', () => {
    const f = parseLogFilter(
      '--project MathScrabble --last 7d --type worker,merge --severity error --limit 100',
      NOW,
    );
    expect(f.projectName).toBe('MathScrabble');
    expect(f.sinceTs).toBe(new Date(NOW - 7 * 86_400_000).toISOString());
    expect(f.kinds).toContain('worker_failed');
    expect(f.kinds).toContain('merge_performed');
    expect(f.severity).toBe('error');
    expect(f.limit).toBe(100);
    expect(f.errors).toEqual([]);
  });
});
