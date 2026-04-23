import { describe, expect, it } from 'vitest';
import {
  deriveFeatureIntent,
  matchesFeatureIntent,
} from '../../src/orchestrator/feature-intent.js';

describe('deriveFeatureIntent', () => {
  it('lowercases, slugifies, trims', () => {
    expect(deriveFeatureIntent('  Refactor the Auth Module  ')).toBe(
      'refactor-the-auth-module',
    );
  });

  it('collapses non-alphanumerics into single dashes', () => {
    expect(deriveFeatureIntent('fix: play_bar [overflow]!!')).toBe(
      'fix-play-bar-overflow',
    );
  });

  it('caps at 60 chars without trailing dash', () => {
    const long = 'a'.repeat(80);
    const slug = deriveFeatureIntent(long);
    expect(slug.length).toBeLessThanOrEqual(60);
    expect(slug.endsWith('-')).toBe(false);
  });

  it('returns untitled when input collapses to empty', () => {
    expect(deriveFeatureIntent('')).toBe('untitled');
    expect(deriveFeatureIntent('   ')).toBe('untitled');
    expect(deriveFeatureIntent('!!!')).toBe('untitled');
  });

  it('handles unicode via NFKD decomposition', () => {
    expect(deriveFeatureIntent('café — liquid glass')).toBe('cafe-liquid-glass');
  });

  it('is deterministic — same input yields same slug', () => {
    const a = deriveFeatureIntent('some task');
    const b = deriveFeatureIntent('some task');
    expect(a).toBe(b);
  });

  it('trims a dash that would be left by the 60-char cap', () => {
    const input = `${'word '.repeat(20)}end`;
    const slug = deriveFeatureIntent(input);
    expect(slug.endsWith('-')).toBe(false);
  });
});

describe('matchesFeatureIntent', () => {
  it('hits on full substring', () => {
    expect(matchesFeatureIntent('refactor-auth-module', 'auth')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(matchesFeatureIntent('refactor-auth-module', 'Auth')).toBe(true);
    expect(matchesFeatureIntent('REFACTOR-auth', 'refactor')).toBe(true);
  });

  it('matches on multi-token when every 3+ char token hits', () => {
    expect(matchesFeatureIntent('liquid-glass-frontend', 'liquid glass')).toBe(true);
  });

  it('requires all tokens to hit (not just one)', () => {
    expect(matchesFeatureIntent('liquid-glass', 'liquid unicorn')).toBe(false);
  });

  it('ignores short 1-2 char tokens in the query', () => {
    expect(matchesFeatureIntent('play-bar-fix', 'a fix')).toBe(true);
  });

  it('empty query returns false', () => {
    expect(matchesFeatureIntent('anything', '')).toBe(false);
  });
});
