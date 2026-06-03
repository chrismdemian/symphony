/**
 * Phase 7B.3 — verify `onTaskCreated` fires for BOTH stores with the same
 * contract: a frozen post-create snapshot (status `'pending'`), once per
 * create, swallowing callback errors so a misbehaving consumer can't poison
 * the create path.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SymphonyDatabase } from '../../src/state/db.js';
import { SqliteTaskStore } from '../../src/state/sqlite-task-store.js';
import { TaskRegistry } from '../../src/state/task-registry.js';
import type { TaskSnapshot } from '../../src/state/types.js';

let tmpDir: string;
let db: SymphonyDatabase | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'sym-7b3-task-'));
});

afterEach(() => {
  db?.close();
  db = undefined;
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // best effort
  }
});

function openDb(): SymphonyDatabase {
  return SymphonyDatabase.open({ filePath: path.join(tmpDir, 'symphony.db') });
}

function insertProject(database: SymphonyDatabase): void {
  database.db
    .prepare(`INSERT INTO projects (id, name, path, created_at) VALUES (?, ?, ?, ?)`)
    .run('p1', 'p1', tmpDir.replace(/\\/g, '/'), new Date().toISOString());
}

describe('TaskRegistry — onTaskCreated', () => {
  it('fires once on create with a pending snapshot', () => {
    const calls: TaskSnapshot[] = [];
    const reg = new TaskRegistry({
      idGenerator: () => 'tk-aa11bb22',
      onTaskCreated: (snap) => calls.push(snap),
    });
    reg.create({ projectId: 'p1', description: 'do thing' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.id).toBe('tk-aa11bb22');
    expect(calls[0]!.projectId).toBe('p1');
    expect(calls[0]!.description).toBe('do thing');
    expect(calls[0]!.status).toBe('pending');
  });

  it('does NOT fire on update', () => {
    const calls: TaskSnapshot[] = [];
    const reg = new TaskRegistry({
      idGenerator: () => 'tk-update01',
      onTaskCreated: (snap) => calls.push(snap),
    });
    reg.create({ projectId: 'p1', description: 'x' });
    reg.update('tk-update01', { status: 'in_progress' });
    expect(calls).toHaveLength(1);
  });

  it('swallows callback errors (must not poison create)', () => {
    const reg = new TaskRegistry({
      idGenerator: () => 'tk-boom0001',
      onTaskCreated: () => {
        throw new Error('boom');
      },
    });
    expect(() => reg.create({ projectId: 'p1', description: 'x' })).not.toThrow();
    expect(reg.snapshot('tk-boom0001')).toBeDefined();
  });
});

describe('SqliteTaskStore — onTaskCreated', () => {
  it('fires once on create with a pending snapshot', () => {
    db = openDb();
    insertProject(db);
    const calls: TaskSnapshot[] = [];
    const store = new SqliteTaskStore(db.db, { onTaskCreated: (snap) => calls.push(snap) });
    const t = store.create({ projectId: 'p1', description: 'do thing' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.id).toBe(t.id);
    expect(calls[0]!.projectId).toBe('p1');
    expect(calls[0]!.description).toBe('do thing');
    expect(calls[0]!.status).toBe('pending');
  });

  it('does NOT fire on update', () => {
    db = openDb();
    insertProject(db);
    const calls: TaskSnapshot[] = [];
    const store = new SqliteTaskStore(db.db, { onTaskCreated: (snap) => calls.push(snap) });
    const t = store.create({ projectId: 'p1', description: 'x' });
    store.update(t.id, { status: 'in_progress' });
    expect(calls).toHaveLength(1);
  });

  it('swallows callback errors (must not poison create)', () => {
    db = openDb();
    insertProject(db);
    const store = new SqliteTaskStore(db.db, {
      onTaskCreated: () => {
        throw new Error('boom');
      },
    });
    let created: { id: string } | undefined;
    expect(() => {
      created = store.create({ projectId: 'p1', description: 'x' });
    }).not.toThrow();
    expect(store.snapshot(created!.id)).toBeDefined();
  });
});
