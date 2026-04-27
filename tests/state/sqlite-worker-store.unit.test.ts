import { describe, expect, it } from 'vitest';
import { SymphonyDatabase } from '../../src/state/db.js';
import {
  SqliteWorkerStore,
  type PersistedWorkerRecord,
} from '../../src/state/sqlite-worker-store.js';
import { CorruptRecordError } from '../../src/state/errors.js';

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
    projectId: overrides.projectId !== undefined ? overrides.projectId : 'p1',
    taskId: overrides.taskId !== undefined ? overrides.taskId : null,
    worktreePath: overrides.worktreePath ?? '/tmp/p1/.symphony/worktrees/wk-test',
    role: overrides.role ?? 'implementer',
    featureIntent: overrides.featureIntent ?? 'do-thing',
    taskDescription: overrides.taskDescription ?? 'Do the thing',
    autonomyTier: overrides.autonomyTier ?? 2,
    dependsOn: overrides.dependsOn ?? [],
    status: overrides.status ?? 'spawning',
    createdAt: overrides.createdAt ?? '2026-04-25T00:00:00.000Z',
    ...(overrides.model !== undefined ? { model: overrides.model } : {}),
    ...(overrides.sessionId !== undefined ? { sessionId: overrides.sessionId } : {}),
    ...(overrides.completedAt !== undefined ? { completedAt: overrides.completedAt } : {}),
    ...(overrides.lastEventAt !== undefined ? { lastEventAt: overrides.lastEventAt } : {}),
    ...(overrides.exitCode !== undefined ? { exitCode: overrides.exitCode } : {}),
    ...(overrides.exitSignal !== undefined ? { exitSignal: overrides.exitSignal } : {}),
    ...(overrides.costUsd !== undefined ? { costUsd: overrides.costUsd } : {}),
  };
}

describe('SqliteWorkerStore — basics', () => {
  it('insert + get round-trips a minimal record', () => {
    const db = makeDb();
    seedProject(db);
    try {
      const store = new SqliteWorkerStore(db.db);
      store.insert(makeRecord({ id: 'wk-1' }));
      const got = store.get('wk-1');
      expect(got).toMatchObject({
        id: 'wk-1',
        projectId: 'p1',
        taskId: null,
        status: 'spawning',
        role: 'implementer',
        featureIntent: 'do-thing',
        autonomyTier: 2,
        dependsOn: [],
      });
      expect(got?.sessionId).toBeUndefined();
      expect(got?.completedAt).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it('insert + get preserves optional fields when present', () => {
    const db = makeDb();
    seedProject(db);
    try {
      const store = new SqliteWorkerStore(db.db);
      store.insert(
        makeRecord({
          id: 'wk-1',
          model: 'claude-opus',
          sessionId: 'sess-abc',
          lastEventAt: '2026-04-25T00:01:00.000Z',
          status: 'running',
        }),
      );
      const got = store.get('wk-1')!;
      expect(got.model).toBe('claude-opus');
      expect(got.sessionId).toBe('sess-abc');
      expect(got.lastEventAt).toBe('2026-04-25T00:01:00.000Z');
      expect(got.status).toBe('running');
    } finally {
      db.close();
    }
  });

  it('persists projectId=null for unregistered absolute paths', () => {
    const db = makeDb();
    try {
      const store = new SqliteWorkerStore(db.db);
      store.insert(makeRecord({ id: 'wk-orphan', projectId: null }));
      const got = store.get('wk-orphan');
      expect(got?.projectId).toBeNull();
    } finally {
      db.close();
    }
  });

  it('list returns rows in insertion order', () => {
    const db = makeDb();
    seedProject(db);
    try {
      const store = new SqliteWorkerStore(db.db);
      store.insert(makeRecord({ id: 'wk-1', createdAt: '2026-04-25T00:00:00.000Z' }));
      store.insert(makeRecord({ id: 'wk-2', createdAt: '2026-04-25T00:00:01.000Z' }));
      store.insert(makeRecord({ id: 'wk-3', createdAt: '2026-04-25T00:00:02.000Z' }));
      const all = store.list();
      expect(all.map((r) => r.id)).toEqual(['wk-1', 'wk-2', 'wk-3']);
    } finally {
      db.close();
    }
  });

  it('list filters by status (single + array)', () => {
    const db = makeDb();
    seedProject(db);
    try {
      const store = new SqliteWorkerStore(db.db);
      store.insert(makeRecord({ id: 'a', status: 'running' }));
      store.insert(makeRecord({ id: 'b', status: 'completed' }));
      store.insert(makeRecord({ id: 'c', status: 'crashed' }));
      expect(store.list({ status: 'running' }).map((r) => r.id)).toEqual(['a']);
      expect(
        store.list({ status: ['completed', 'crashed'] })
          .map((r) => r.id)
          .sort(),
      ).toEqual(['b', 'c']);
    } finally {
      db.close();
    }
  });

  it('list filters by projectId, including null', () => {
    const db = makeDb();
    seedProject(db, 'p1', 'p1', '/tmp/p1');
    seedProject(db, 'p2', 'p2', '/tmp/p2');
    try {
      const store = new SqliteWorkerStore(db.db);
      store.insert(makeRecord({ id: 'a', projectId: 'p1' }));
      store.insert(makeRecord({ id: 'b', projectId: 'p2' }));
      store.insert(makeRecord({ id: 'c', projectId: null }));
      expect(store.list({ projectId: 'p1' }).map((r) => r.id)).toEqual(['a']);
      expect(store.list({ projectId: 'p2' }).map((r) => r.id)).toEqual(['b']);
      expect(store.list({ projectId: null }).map((r) => r.id)).toEqual(['c']);
    } finally {
      db.close();
    }
  });
});

describe('SqliteWorkerStore — update', () => {
  it('partial update preserves unset fields', () => {
    const db = makeDb();
    seedProject(db);
    try {
      const store = new SqliteWorkerStore(db.db);
      store.insert(
        makeRecord({
          id: 'wk-1',
          status: 'running',
          sessionId: 'sess-old',
          lastEventAt: '2026-04-25T00:00:00.000Z',
        }),
      );
      // Update only status — sessionId and lastEventAt must persist.
      store.update('wk-1', { status: 'completed', completedAt: '2026-04-25T00:05:00.000Z' });
      const got = store.get('wk-1')!;
      expect(got.status).toBe('completed');
      expect(got.completedAt).toBe('2026-04-25T00:05:00.000Z');
      expect(got.sessionId).toBe('sess-old');
      expect(got.lastEventAt).toBe('2026-04-25T00:00:00.000Z');
    } finally {
      db.close();
    }
  });

  it('update is a no-op on unknown id', () => {
    const db = makeDb();
    try {
      const store = new SqliteWorkerStore(db.db);
      expect(() => store.update('missing', { status: 'crashed' })).not.toThrow();
      expect(store.get('missing')).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it('update can stamp exitCode / exitSignal on terminal status', () => {
    const db = makeDb();
    seedProject(db);
    try {
      const store = new SqliteWorkerStore(db.db);
      store.insert(makeRecord({ id: 'wk-1', status: 'running' }));
      store.update('wk-1', {
        status: 'crashed',
        exitCode: null,
        exitSignal: 'SIGKILL',
        completedAt: '2026-04-25T00:10:00.000Z',
      });
      const got = store.get('wk-1')!;
      expect(got.status).toBe('crashed');
      expect(got.exitCode).toBeUndefined(); // null in DB → omitted in record
      expect(got.exitSignal).toBe('SIGKILL');
      expect(got.completedAt).toBe('2026-04-25T00:10:00.000Z');
    } finally {
      db.close();
    }
  });
});

describe('SqliteWorkerStore — delete', () => {
  it('deletes a row; subsequent get returns undefined', () => {
    const db = makeDb();
    seedProject(db);
    try {
      const store = new SqliteWorkerStore(db.db);
      store.insert(makeRecord({ id: 'wk-1' }));
      expect(store.get('wk-1')).toBeDefined();
      store.delete('wk-1');
      expect(store.get('wk-1')).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it('delete is a no-op on unknown id', () => {
    const db = makeDb();
    try {
      const store = new SqliteWorkerStore(db.db);
      expect(() => store.delete('missing')).not.toThrow();
    } finally {
      db.close();
    }
  });
});

describe('SqliteWorkerStore — persistence across reopen', () => {
  it('rows survive close + reopen of the same DB', async () => {
    const tmp = await import('node:os').then((m) => m.tmpdir());
    const path = await import('node:path').then((m) => m.join(tmp, `symphony-wstore-${process.pid}-${Date.now()}.db`));
    const fs = await import('node:fs/promises');
    try {
      const db1 = SymphonyDatabase.open({ filePath: path });
      seedProject(db1);
      const store1 = new SqliteWorkerStore(db1.db);
      store1.insert(makeRecord({ id: 'wk-1', status: 'running', sessionId: 'sess-x' }));
      db1.close();

      const db2 = SymphonyDatabase.open({ filePath: path });
      const store2 = new SqliteWorkerStore(db2.db);
      const got = store2.get('wk-1');
      expect(got?.id).toBe('wk-1');
      expect(got?.status).toBe('running');
      expect(got?.sessionId).toBe('sess-x');
      db2.close();
    } finally {
      await fs.rm(path, { force: true }).catch(() => {});
      await fs.rm(`${path}-wal`, { force: true }).catch(() => {});
      await fs.rm(`${path}-shm`, { force: true }).catch(() => {});
    }
  });
});

describe('SqliteWorkerStore — corrupt JSON tolerance (audit M5 parity)', () => {
  it('list() skips a row with bad depends_on JSON and reports via callback', () => {
    const db = makeDb();
    seedProject(db);
    try {
      const reports: CorruptRecordError[] = [];
      const store = new SqliteWorkerStore(db.db, {
        onCorruptRow: (err) => {
          reports.push(err);
        },
      });
      store.insert(makeRecord({ id: 'good' }));
      store.insert(makeRecord({ id: 'bad' }));
      // Inject corruption directly into the SQL row.
      db.db.prepare(`UPDATE workers SET depends_on = ? WHERE id = ?`).run('NOT-JSON', 'bad');
      const all = store.list();
      expect(all.map((r) => r.id)).toEqual(['good']);
      expect(reports.length).toBe(1);
      expect(reports[0]?.column).toBe('depends_on');
    } finally {
      db.close();
    }
  });

  it('get() throws on corrupt row (strict path)', () => {
    const db = makeDb();
    seedProject(db);
    try {
      const store = new SqliteWorkerStore(db.db);
      store.insert(makeRecord({ id: 'bad' }));
      db.db.prepare(`UPDATE workers SET depends_on = ? WHERE id = ?`).run('NOT-JSON', 'bad');
      expect(() => store.get('bad')).toThrow(CorruptRecordError);
    } finally {
      db.close();
    }
  });

  it('list onCorruptRow strict mode rethrows', () => {
    const db = makeDb();
    seedProject(db);
    try {
      const store = new SqliteWorkerStore(db.db, {
        onCorruptRow: (err) => {
          throw err;
        },
      });
      store.insert(makeRecord({ id: 'good' }));
      store.insert(makeRecord({ id: 'bad' }));
      db.db.prepare(`UPDATE workers SET depends_on = ? WHERE id = ?`).run('{"a":1}', 'bad');
      // Object-not-array → CorruptRecordError → rethrown
      expect(() => store.list()).toThrow(CorruptRecordError);
    } finally {
      db.close();
    }
  });
});

describe('SqliteWorkerStore — size + dependsOn round-trip', () => {
  it('size() returns the row count', () => {
    const db = makeDb();
    seedProject(db);
    try {
      const store = new SqliteWorkerStore(db.db);
      expect(store.size()).toBe(0);
      store.insert(makeRecord({ id: 'a' }));
      store.insert(makeRecord({ id: 'b' }));
      expect(store.size()).toBe(2);
      store.delete('a');
      expect(store.size()).toBe(1);
    } finally {
      db.close();
    }
  });

  it('dependsOn array round-trips through JSON', () => {
    const db = makeDb();
    seedProject(db);
    try {
      const store = new SqliteWorkerStore(db.db);
      store.insert(makeRecord({ id: 'wk-1', dependsOn: ['wk-x', 'wk-y'] }));
      const got = store.get('wk-1')!;
      expect(got.dependsOn).toEqual(['wk-x', 'wk-y']);
    } finally {
      db.close();
    }
  });
});
