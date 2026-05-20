/**
 * Phase 4G.2 — ProjectRecord.previewCommand + previewTimeoutMs
 * persistence + overlay merge.
 *
 * Covers:
 *   - Migration 0008 applies (columns present).
 *   - SqliteProjectStore round-trips both fields.
 *   - projectRegistryFromMap overlay merges them.
 *   - toProjectSnapshot surfaces them.
 *   - Schema contract validator now lists the columns.
 */

import { describe, expect, it } from 'vitest';
import { SymphonyDatabase } from '../../src/state/db.js';
import { SqliteProjectStore } from '../../src/state/sqlite-project-store.js';
import {
  projectRegistryFromMap,
  toProjectSnapshot,
} from '../../src/projects/registry.js';
import type { ProjectRecord } from '../../src/projects/types.js';

function makeDb(): SymphonyDatabase {
  return SymphonyDatabase.open({ filePath: ':memory:' });
}

function makeRecord(overrides: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    id: overrides.id ?? 'p1',
    name: overrides.name ?? 'demo',
    path: overrides.path ?? '/tmp/demo',
    createdAt: overrides.createdAt ?? '2026-05-20T00:00:00.000Z',
    ...overrides,
  };
}

describe('Phase 4G.2 — previewCommand + previewTimeoutMs persistence', () => {
  it('round-trips both fields through SqliteProjectStore', () => {
    const db = makeDb();
    try {
      const store = new SqliteProjectStore(db.db);
      store.register(
        makeRecord({
          id: 'p1',
          name: 'demo',
          path: '/tmp/demo',
          previewCommand: 'pnpm dev',
          previewTimeoutMs: 45_000,
        }),
      );
      const fetched = store.get('p1');
      expect(fetched?.previewCommand).toBe('pnpm dev');
      expect(fetched?.previewTimeoutMs).toBe(45_000);
    } finally {
      db.close();
    }
  });

  it('absent fields stay undefined after a round trip (no coercion)', () => {
    const db = makeDb();
    try {
      const store = new SqliteProjectStore(db.db);
      store.register(makeRecord({ id: 'p2', name: 'bare', path: '/tmp/bare' }));
      const fetched = store.get('p2');
      expect(fetched?.previewCommand).toBeUndefined();
      expect(fetched?.previewTimeoutMs).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it('projectRegistryFromMap overlay merges previewCommand', () => {
    const registry = projectRegistryFromMap(
      { demo: '/tmp/demo' },
      {
        configs: {
          demo: {
            previewCommand: 'vite',
            previewTimeoutMs: 20_000,
          },
        },
      },
    );
    const rec = registry.get('demo');
    expect(rec?.previewCommand).toBe('vite');
    expect(rec?.previewTimeoutMs).toBe(20_000);
  });

  it('toProjectSnapshot carries both fields when set', () => {
    const snap = toProjectSnapshot(
      makeRecord({
        previewCommand: 'pnpm preview',
        previewTimeoutMs: 60_000,
      }),
    );
    expect(snap.previewCommand).toBe('pnpm preview');
    expect(snap.previewTimeoutMs).toBe(60_000);
  });

  it('toProjectSnapshot omits both fields when absent (no `undefined` keys)', () => {
    const snap = toProjectSnapshot(makeRecord());
    expect('previewCommand' in snap).toBe(false);
    expect('previewTimeoutMs' in snap).toBe(false);
  });

  it('migration 0008 + schema contract validator passes after open()', () => {
    // SymphonyDatabase.open() applies migrations + runs the schema
    // contract validator. Closing+reopening would re-run; just verify
    // the in-memory db has the columns.
    const db = makeDb();
    try {
      const info = db.db
        .prepare(`PRAGMA table_info(projects)`)
        .all() as { name: string }[];
      const names = info.map((c) => c.name);
      expect(names).toContain('preview_command');
      expect(names).toContain('preview_timeout_ms');
    } finally {
      db.close();
    }
  });
});
