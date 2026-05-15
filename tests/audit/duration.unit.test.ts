import { describe, it, expect } from 'vitest';
import { parseDuration, sinceTimestamp } from '../../src/audit/duration.js';

describe('parseDuration', () => {
  it('parses single-unit durations', () => {
    expect(parseDuration('45s')).toBe(45_000);
    expect(parseDuration('30m')).toBe(30 * 60_000);
    expect(parseDuration('1h')).toBe(3_600_000);
    expect(parseDuration('7d')).toBe(7 * 86_400_000);
    expect(parseDuration('2w')).toBe(2 * 7 * 86_400_000);
  });

  it('parses compound durations', () => {
    expect(parseDuration('2h30m')).toBe(2 * 3_600_000 + 30 * 60_000);
    expect(parseDuration('1d12h')).toBe(86_400_000 + 12 * 3_600_000);
    expect(parseDuration('1w2d3h')).toBe(7 * 86_400_000 + 2 * 86_400_000 + 3 * 3_600_000);
  });

  it('is case-insensitive on unit letters', () => {
    expect(parseDuration('1H')).toBe(3_600_000);
    expect(parseDuration('2H30M')).toBe(parseDuration('2h30m'));
  });

  it('tolerates surrounding whitespace', () => {
    expect(parseDuration('  1h  ')).toBe(3_600_000);
  });

  it('rejects fractional values', () => {
    expect(parseDuration('1.5h')).toBeNull();
    expect(parseDuration('0.5d')).toBeNull();
  });

  it('rejects negative values', () => {
    expect(parseDuration('-1h')).toBeNull();
  });

  it('rejects empty input', () => {
    expect(parseDuration('')).toBeNull();
    expect(parseDuration('   ')).toBeNull();
  });

  it('rejects zero duration', () => {
    expect(parseDuration('0h')).toBeNull();
    expect(parseDuration('0m')).toBeNull();
    expect(parseDuration('0s0m0h')).toBeNull();
  });

  it('rejects unknown units', () => {
    expect(parseDuration('5y')).toBeNull();
    expect(parseDuration('1mo')).toBeNull();
    expect(parseDuration('1x')).toBeNull();
  });

  it('rejects garbage input', () => {
    expect(parseDuration('hello')).toBeNull();
    expect(parseDuration('h1')).toBeNull();
    expect(parseDuration('1 2 3')).toBeNull();
  });

  it('rejects non-string input', () => {
    // @ts-expect-error — runtime safety check
    expect(parseDuration(1234)).toBeNull();
    // @ts-expect-error — runtime safety check
    expect(parseDuration(null)).toBeNull();
    // @ts-expect-error — runtime safety check
    expect(parseDuration(undefined)).toBeNull();
  });
});

describe('sinceTimestamp', () => {
  it('subtracts duration from nowEpochMs and returns ISO', () => {
    const now = 1_700_000_000_000;
    const since = sinceTimestamp('1h', now);
    expect(since).toBe(new Date(now - 3_600_000).toISOString());
  });

  it('returns null on invalid duration', () => {
    expect(sinceTimestamp('garbage', 0)).toBeNull();
  });

  it('uses Date.now() default when nowEpochMs omitted', () => {
    const before = Date.now();
    const since = sinceTimestamp('1h');
    const after = Date.now();
    expect(since).not.toBeNull();
    const sinceMs = new Date(since!).getTime();
    expect(sinceMs).toBeGreaterThanOrEqual(before - 3_600_000);
    expect(sinceMs).toBeLessThanOrEqual(after - 3_600_000);
  });
});
