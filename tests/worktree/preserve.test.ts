import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildPathspecs,
  isExcludedPath,
  matchesPreservePattern,
  resolvePreservePatterns,
} from '../../src/worktree/preserve.js';
import { DEFAULT_PRESERVE_PATTERNS } from '../../src/worktree/types.js';

let sandbox: string;

beforeEach(() => {
  sandbox = mkdtempSync(path.join(tmpdir(), 'symphony-preserve-'));
});

afterEach(() => {
  try {
    rmSync(sandbox, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('buildPathspecs', () => {
  it('adds **/<pattern> variants and dedupes', () => {
    const out = buildPathspecs(['.env', '.env']);
    expect(out).toEqual(expect.arrayContaining(['.env', '**/.env']));
    expect(out).toHaveLength(2);
  });

  it('skips negation patterns', () => {
    const out = buildPathspecs(['.env', '!.env.example']);
    expect(out).not.toContain('!.env.example');
  });

  it('skips already-prefixed patterns', () => {
    const out = buildPathspecs(['**/secret.json']);
    expect(out).toEqual(['**/secret.json']);
  });

  it('strips backslashes and ./ prefixes', () => {
    const out = buildPathspecs(['./config\\local.json']);
    expect(out.some((p) => p.includes('\\'))).toBe(false);
  });
});

describe('matchesPreservePattern', () => {
  it('matches by basename', () => {
    expect(matchesPreservePattern('.env', ['.env'])).toBe(true);
    expect(matchesPreservePattern('apps/web/.env', ['.env'])).toBe(true);
  });

  it('respects negation', () => {
    expect(matchesPreservePattern('.env.example', ['.env*', '!.env.example'])).toBe(false);
    expect(matchesPreservePattern('.env.local', ['.env*', '!.env.example'])).toBe(true);
  });

  it('returns false when no positive match', () => {
    expect(matchesPreservePattern('README.md', ['.env'])).toBe(false);
  });
});

describe('isExcludedPath', () => {
  it('blocks node_modules path segment', () => {
    expect(isExcludedPath('apps/web/node_modules/foo/.env')).toBe(true);
  });
  it('lets clean paths through', () => {
    expect(isExcludedPath('apps/web/.env')).toBe(false);
  });
});

describe('resolvePreservePatterns', () => {
  it('falls back to defaults when neither file exists', () => {
    const r = resolvePreservePatterns(sandbox);
    expect(r.source).toBe('defaults');
    expect(r.patterns).toEqual(DEFAULT_PRESERVE_PATTERNS);
  });

  it('uses .symphony.json preservePatterns when present', () => {
    writeFileSync(path.join(sandbox, '.symphony.json'), JSON.stringify({ preservePatterns: ['secrets.json'] }));
    const r = resolvePreservePatterns(sandbox);
    expect(r.source).toBe('symphony.json');
    expect(r.patterns).toEqual(['secrets.json']);
  });

  it('prefers .worktreeinclude over .symphony.json', () => {
    writeFileSync(path.join(sandbox, '.symphony.json'), JSON.stringify({ preservePatterns: ['from-json'] }));
    writeFileSync(path.join(sandbox, '.worktreeinclude'), '# header\nfrom-include\n');
    const r = resolvePreservePatterns(sandbox);
    expect(r.source).toBe('worktreeinclude');
    expect(r.patterns).toEqual(['from-include']);
  });

  it('falls through to next layer when .worktreeinclude is empty after stripping', () => {
    mkdirSync(path.join(sandbox, '.git'), { recursive: true });
    writeFileSync(path.join(sandbox, '.symphony.json'), JSON.stringify({ preservePatterns: ['from-json'] }));
    writeFileSync(path.join(sandbox, '.worktreeinclude'), '# only comments\n\n');
    const r = resolvePreservePatterns(sandbox);
    expect(r.source).toBe('symphony.json');
    expect(r.patterns).toEqual(['from-json']);
  });

  it('ignores malformed .symphony.json', () => {
    writeFileSync(path.join(sandbox, '.symphony.json'), 'not-json');
    const r = resolvePreservePatterns(sandbox);
    expect(r.source).toBe('defaults');
  });
});
