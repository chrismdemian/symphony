import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  canonicalizeBaseRef,
  isPoolEnabled,
  parseReserveDirName,
  reserveKey,
  stripOriginPrefix,
  WorktreePool,
} from '../../src/worktree/index.js';
import type { ReserveInfo } from '../../src/worktree/index.js';

describe('stripOriginPrefix', () => {
  it('strips a leading origin/', () => {
    expect(stripOriginPrefix('origin/main')).toBe('main');
  });
  it('leaves bare branch names untouched', () => {
    expect(stripOriginPrefix('feature/x')).toBe('feature/x');
  });
  it('leaves HEAD untouched', () => {
    expect(stripOriginPrefix('HEAD')).toBe('HEAD');
  });
});

describe('canonicalizeBaseRef', () => {
  it('maps empty/undefined to HEAD', () => {
    expect(canonicalizeBaseRef(undefined)).toBe('HEAD');
    expect(canonicalizeBaseRef('')).toBe('HEAD');
    expect(canonicalizeBaseRef('   ')).toBe('HEAD');
  });
  it('strips origin/ prefix', () => {
    expect(canonicalizeBaseRef('origin/main')).toBe('main');
  });
  it('keeps bare branch names', () => {
    expect(canonicalizeBaseRef('develop')).toBe('develop');
  });
});

describe('reserveKey', () => {
  it('embeds resolved project path and canonical baseRef', () => {
    const key = reserveKey('/tmp/../tmp/proj', 'origin/main');
    expect(key).toContain('::main');
    expect(key.startsWith(path.resolve('/tmp/proj'))).toBe(true);
  });
  it('normalizes paths — trailing slash equals no trailing slash', () => {
    expect(reserveKey('/tmp/proj', 'main')).toBe(reserveKey('/tmp/proj/', 'main'));
  });
  it('distinct projects never collide', () => {
    expect(reserveKey('/tmp/a', 'main')).not.toBe(reserveKey('/tmp/b', 'main'));
  });
  it('distinct baseRefs for the same project do not collide', () => {
    expect(reserveKey('/tmp/p', 'main')).not.toBe(reserveKey('/tmp/p', 'develop'));
  });
});

describe('parseReserveDirName', () => {
  it('extracts hash from well-formed dirs', () => {
    expect(parseReserveDirName('_reserve-deadbeef')?.hash).toBe('deadbeef');
  });
  it('returns null for non-reserve dirs', () => {
    expect(parseReserveDirName('worker-1')).toBeNull();
    expect(parseReserveDirName('_reserve')).toBeNull();
    expect(parseReserveDirName('_reserves-foo')).toBeNull();
    expect(parseReserveDirName('_reserve-foo/bar')).toBeNull();
    expect(parseReserveDirName('reserve-foo')).toBeNull();
  });
});

describe('WorktreePool.isReserveStale', () => {
  const baseReserve: ReserveInfo = {
    id: 'wt-abcdef123456',
    path: '/tmp/p/.symphony/worktrees/_reserve-abc',
    branch: '_reserve/abc',
    projectPath: '/tmp/p',
    baseRef: 'main',
    resolvedRef: 'origin/main',
    commitHash: 'deadbeef',
    createdAt: new Date('2025-01-01T00:00:00Z').toISOString(),
  };

  it('fresh reserve under max age', () => {
    const pool = new WorktreePool({
      now: () => Date.parse(baseReserve.createdAt) + 1_000,
      runPoll: false,
    });
    expect(pool.isReserveStale(baseReserve)).toBe(false);
  });

  it('stale reserve past max age', () => {
    const pool = new WorktreePool({
      now: () => Date.parse(baseReserve.createdAt) + 31 * 60 * 1_000,
      runPoll: false,
    });
    expect(pool.isReserveStale(baseReserve)).toBe(true);
  });

  it('respects maxReserveAgeMs override', () => {
    const pool = new WorktreePool({
      maxReserveAgeMs: 1_000,
      now: () => Date.parse(baseReserve.createdAt) + 2_000,
      runPoll: false,
    });
    expect(pool.isReserveStale(baseReserve)).toBe(true);
  });

  it('invalid createdAt treated as not-stale (NaN age is not finite)', () => {
    const pool = new WorktreePool({ runPoll: false });
    expect(pool.isReserveStale({ ...baseReserve, createdAt: 'not-a-date' })).toBe(false);
  });
});

describe('isPoolEnabled', () => {
  it('returns false when .symphony.json is missing', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(path.join(tmpdir(), 'symphony-pool-enabled-'));
    try {
      expect(isPoolEnabled(dir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns false when worktreePool is absent', async () => {
    const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(path.join(tmpdir(), 'symphony-pool-enabled-'));
    try {
      writeFileSync(path.join(dir, '.symphony.json'), JSON.stringify({ preservePatterns: [] }));
      expect(isPoolEnabled(dir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns true only when worktreePool.enabled is the literal true', async () => {
    const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(path.join(tmpdir(), 'symphony-pool-enabled-'));
    try {
      writeFileSync(path.join(dir, '.symphony.json'), JSON.stringify({ worktreePool: { enabled: true } }));
      expect(isPoolEnabled(dir)).toBe(true);
      writeFileSync(path.join(dir, '.symphony.json'), JSON.stringify({ worktreePool: { enabled: false } }));
      expect(isPoolEnabled(dir)).toBe(false);
      writeFileSync(path.join(dir, '.symphony.json'), JSON.stringify({ worktreePool: { enabled: 'yes' } }));
      expect(isPoolEnabled(dir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
