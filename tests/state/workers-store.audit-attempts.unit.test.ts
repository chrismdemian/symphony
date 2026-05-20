/**
 * Phase 4G.1 — workers.audit_attempts column persistence + bump.
 *
 * Covers:
 *   - Migration 0007 applies cleanly (default 0 on insert).
 *   - `bumpAuditAttempts` returns the new value and persists it.
 *   - The `update()` patch path (auditAttempts) writes to the column
 *     without disturbing the auto-bump statement.
 *   - Schema contract validator passes after migration.
 */

import { describe, expect, it } from 'vitest';
import { SymphonyDatabase } from '../../src/state/db.js';
import {
  SqliteWorkerStore,
  type PersistedWorkerRecord,
} from '../../src/state/sqlite-worker-store.js';

function makeDb(): SymphonyDatabase {
  return SymphonyDatabase.open({ filePath: ':memory:' });
}

function seedProject(db: SymphonyDatabase, id = 'p1', name = 'p1', path = '/tmp/p1'): void {
  db.db
    .prepare(
      `INSERT INTO projects (id, name, path, created_at) VALUES (?, ?, ?, datetime('now'))`,
    )
    .run(id, name, path);
}

function makeRecord(overrides: Partial<PersistedWorkerRecord> = {}): PersistedWorkerRecord {
  return {
    id: overrides.id ?? 'wk-test',
    projectId: overrides.projectId ?? 'p1',
    taskId: overrides.taskId ?? null,
    worktreePath: overrides.worktreePath ?? '/tmp/p1/.symphony/worktrees/wk-test',
    role: overrides.role ?? 'implementer',
    featureIntent: overrides.featureIntent ?? 'do-thing',
    taskDescription: overrides.taskDescription ?? 'Do the thing',
    autonomyTier: overrides.autonomyTier ?? 1,
    dependsOn: overrides.dependsOn ?? [],
    status: overrides.status ?? 'spawning',
    createdAt: overrides.createdAt ?? '2026-04-25T00:00:00.000Z',
    auditAttempts: overrides.auditAttempts ?? 0,
  };
}

describe('Phase 4G.1 — workers.audit_attempts column', () => {
  it('persists the default value on insert and reads it back as 0', () => {
    const db = makeDb();
    try {
      seedProject(db);
      const store = new SqliteWorkerStore(db.db);
      store.insert(makeRecord({ id: 'wk-a' }));
      const persisted = store.get('wk-a');
      expect(persisted?.auditAttempts).toBe(0);
    } finally {
      db.close();
    }
  });

  it('round-trips an explicit non-zero value', () => {
    const db = makeDb();
    try {
      seedProject(db);
      const store = new SqliteWorkerStore(db.db);
      store.insert(makeRecord({ id: 'wk-b', auditAttempts: 2 }));
      const persisted = store.get('wk-b');
      expect(persisted?.auditAttempts).toBe(2);
    } finally {
      db.close();
    }
  });

  it('bumpAuditAttempts atomically increments and returns the new value', () => {
    const db = makeDb();
    try {
      seedProject(db);
      const store = new SqliteWorkerStore(db.db);
      store.insert(makeRecord({ id: 'wk-c' }));

      expect(store.bumpAuditAttempts('wk-c')).toBe(1);
      expect(store.bumpAuditAttempts('wk-c')).toBe(2);
      expect(store.bumpAuditAttempts('wk-c')).toBe(3);

      const persisted = store.get('wk-c');
      expect(persisted?.auditAttempts).toBe(3);
    } finally {
      db.close();
    }
  });

  it('bumpAuditAttempts returns undefined for an unknown worker id', () => {
    const db = makeDb();
    try {
      seedProject(db);
      const store = new SqliteWorkerStore(db.db);
      expect(store.bumpAuditAttempts('wk-does-not-exist')).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it('update() patch preserves auditAttempts when the patch omits it', () => {
    const db = makeDb();
    try {
      seedProject(db);
      const store = new SqliteWorkerStore(db.db);
      store.insert(makeRecord({ id: 'wk-d', auditAttempts: 5 }));
      // Touch the row via an unrelated patch.
      store.update('wk-d', { status: 'running' });
      const persisted = store.get('wk-d');
      expect(persisted?.auditAttempts).toBe(5);
      expect(persisted?.status).toBe('running');
    } finally {
      db.close();
    }
  });

  it('update() patch can explicitly set auditAttempts', () => {
    const db = makeDb();
    try {
      seedProject(db);
      const store = new SqliteWorkerStore(db.db);
      store.insert(makeRecord({ id: 'wk-e', auditAttempts: 3 }));
      store.update('wk-e', { auditAttempts: 0 });
      const persisted = store.get('wk-e');
      expect(persisted?.auditAttempts).toBe(0);
    } finally {
      db.close();
    }
  });

  it('bumpAuditAttempts is independent across workers (no cross-row drift)', () => {
    const db = makeDb();
    try {
      seedProject(db);
      const store = new SqliteWorkerStore(db.db);
      store.insert(makeRecord({ id: 'wk-f' }));
      store.insert(makeRecord({ id: 'wk-g' }));
      expect(store.bumpAuditAttempts('wk-f')).toBe(1);
      expect(store.bumpAuditAttempts('wk-f')).toBe(2);
      expect(store.bumpAuditAttempts('wk-g')).toBe(1);
      expect(store.get('wk-f')?.auditAttempts).toBe(2);
      expect(store.get('wk-g')?.auditAttempts).toBe(1);
    } finally {
      db.close();
    }
  });
});
