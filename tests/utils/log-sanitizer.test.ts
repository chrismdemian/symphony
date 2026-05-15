import { describe, it, expect } from 'vitest';
import { sanitize, sanitizePii } from '../../src/utils/log-sanitizer.js';

describe('sanitize() — token masking', () => {
  it('returns "None" for null and undefined', () => {
    expect(sanitize(null)).toBe('None');
    expect(sanitize(undefined)).toBe('None');
  });

  it('coerces non-string values via String()', () => {
    expect(sanitize(42)).toBe('42');
    expect(sanitize(true)).toBe('true');
  });

  it('preserves pure-alpha words (no digits, no base64 specials)', () => {
    expect(sanitize('access_token exchange')).toBe('access_token exchange');
    expect(sanitize('this is plain English text')).toBe('this is plain English text');
  });

  it('masks 8-12 char tokens with digits: first 3 + *** + last 3', () => {
    expect(sanitize('abcd1234')).toBe('abc***234');
    expect(sanitize('A1B2C3D4E5F6')).toBe('A1B***5F6');
  });

  it('masks 13+ char tokens with digits: first 4 + *** + last 4', () => {
    expect(sanitize('abcdefgh12345678')).toBe('abcd***5678');
    expect(sanitize('sk_test_a1b2c3d4e5f6g7h8i9j0')).toBe('sk_t***i9j0');
  });

  it('skips runs shorter than 8 chars even with digits', () => {
    expect(sanitize('a1b2')).toBe('a1b2');
    expect(sanitize('foo 123 bar')).toBe('foo 123 bar');
  });

  it('masks base64-special tokens (+/) of 8+ chars', () => {
    expect(sanitize('abcdef+/xyz')).toBe('abc***xyz');
  });

  it('masks emails: local part → first + *** + last @ domain', () => {
    expect(sanitize('john.doe@example.com')).toBe('j***e@example.com');
    expect(sanitize('a@example.com')).toBe('***@example.com');
    expect(sanitize('ab@example.com')).toBe('***@example.com');
  });

  it('masks email before token pass (no double-mask)', () => {
    const result = sanitize('reach me at chrisdemian1234@gmail.com today');
    expect(result).toContain('@gmail.com');
    expect(result).not.toContain('chrisdemian1234');
  });

  it('truncates inputs over 2000 chars with marker', () => {
    const big = 'x'.repeat(2500);
    const out = sanitize(big);
    expect(out.length).toBeLessThan(2500);
    expect(out.endsWith('...[truncated]')).toBe(true);
  });

  it('handles empty string', () => {
    expect(sanitize('')).toBe('');
  });

  it('masks multiple tokens in one string', () => {
    expect(sanitize('first abc12345 second def67890')).toBe(
      'first abc***345 second def***890',
    );
  });
});

describe('sanitizePii() — always-mask words', () => {
  it('returns "None" for null and undefined', () => {
    expect(sanitizePii(null)).toBe('None');
    expect(sanitizePii(undefined)).toBe('None');
  });

  it('masks short words (≤4 chars) as ***', () => {
    expect(sanitizePii('John')).toBe('***');
    expect(sanitizePii('Hi')).toBe('***');
  });

  it('masks medium words (5-8 chars) as first + *** + last', () => {
    expect(sanitizePii('Smith')).toBe('S***h');
    expect(sanitizePii('Johnny')).toBe('J***y');
  });

  it('masks long words (9+ chars) as first 2 + *** + last 2', () => {
    expect(sanitizePii('Christopher')).toBe('Ch***er');
    expect(sanitizePii('Demonstration')).toBe('De***on');
  });

  it('masks each word independently', () => {
    expect(sanitizePii('John Smith Doe')).toBe('*** S***h ***');
  });

  it('preserves email domains', () => {
    expect(sanitizePii('contact john.doe@example.com please')).toBe(
      'c***t j***e@example.com p***e',
    );
  });

  it('truncates at 200 chars with trailing ...', () => {
    const big = 'word '.repeat(80); // 400+ chars
    const out = sanitizePii(big);
    expect(out.endsWith('...')).toBe(true);
  });

  it('handles empty string', () => {
    expect(sanitizePii('')).toBe('');
  });
});
