import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SymphonyDatabase } from '../../src/state/db.js';
import { SqliteProjectStore } from '../../src/state/sqlite-project-store.js';
import { SqliteTaskStore } from '../../src/state/sqlite-task-store.js';
import type { CorruptRecordError } from '../../src/state/errors.js';
import {
  InvalidTaskTransitionError,
  UnknownTaskError,
} from '../../src/state/types.js';

describe('SqliteTaskStore', () => {
  let svc: SymphonyDatabase;
  let projects: SqliteProjectStore;
  let store: SqliteTaskStore;

  beforeEach(() => {
    svc = SymphonyDatabase.open({ filePath: ':memory:' });
    projects = new SqliteProjectStore(svc.db);
    projects.register({ id: 'proj', name: 'proj', path: '/tmp/proj', createdAt: '' });
    store = new SqliteTaskStore(svc.db);
  });

  afterEach(() => {
    svc.close();
  });

  it('create inserts, get returns the record', () => {
    const task = store.create({ projectId: 'proj', description: 'do a thing' });
    expect(task.id).toMatch(/^tk-[0-9a-f]{8}$/);
    expect(task.status).toBe('pending');
    expect(task.priority).toBe(0);
    expect(task.dependsOn).toEqual([]);
    expect(task.notes).toEqual([]);
    const got = store.get(task.id);
    expect(got?.description).toBe('do a thing');
  });

  it('create rejects missing projectId or description', () => {
    expect(() => store.create({ projectId: '', description: 'x' })).toThrow(/projectId/);
    expect(() => store.create({ projectId: 'proj', description: '   ' })).toThrow(/description/);
  });

  it('create rejects non-integer priority (Phase 2A.3 audit M3)', () => {
    expect(() =>
      store.create({ projectId: 'proj', description: 'x', priority: 1.5 }),
    ).toThrow(/integer/);
  });

  it('create rejects when projectId FK has no matching project row', () => {
    expect(() => store.create({ projectId: 'nope', description: 'x' })).toThrow();
  });

  it('list preserves insertion order', () => {
    const a = store.create({ projectId: 'proj', description: 'a' });
    const b = store.create({ projectId: 'proj', description: 'b' });
    const c = store.create({ projectId: 'proj', description: 'c' });
    const listed = store.list().map((t) => t.id);
    expect(listed).toEqual([a.id, b.id, c.id]);
  });

  it('list filters by projectId, scalar status, and array status', () => {
    projects.register({ id: 'other', name: 'other', path: '/tmp/other', createdAt: '' });
    const a = store.create({ projectId: 'proj', description: 'a' });
    const b = store.create({ projectId: 'proj', description: 'b' });
    const c = store.create({ projectId: 'other', description: 'c' });
    store.update(a.id, { status: 'in_progress' });
    expect(store.list({ projectId: 'proj' }).map((t) => t.id).sort()).toEqual(
      [a.id, b.id].sort(),
    );
    expect(store.list({ status: 'pending' }).map((t) => t.id).sort()).toEqual(
      [b.id, c.id].sort(),
    );
    expect(
      store.list({ status: ['pending', 'in_progress'] }).map((t) => t.id).sort(),
    ).toEqual([a.id, b.id, c.id].sort());
  });

  it('update rejects unknown id', () => {
    expect(() => store.update('nope', { notes: 'x' })).toThrow(UnknownTaskError);
  });

  it('update rejects invalid transitions (pending → completed without in_progress)', () => {
    const task = store.create({ projectId: 'proj', description: 'a' });
    expect(() => store.update(task.id, { status: 'completed' })).toThrow(
      InvalidTaskTransitionError,
    );
  });

  it('update pending → in_progress → completed sets completedAt', () => {
    const task = store.create({ projectId: 'proj', description: 'a' });
    store.update(task.id, { status: 'in_progress' });
    const done = store.update(task.id, { status: 'completed' });
    expect(done.status).toBe('completed');
    expect(done.completedAt).toBeDefined();
  });

  it('update from terminal status rejects (completed is final)', () => {
    const task = store.create({ projectId: 'proj', description: 'a' });
    store.update(task.id, { status: 'in_progress' });
    store.update(task.id, { status: 'completed' });
    expect(() => store.update(task.id, { status: 'in_progress' })).toThrow(
      InvalidTaskTransitionError,
    );
  });

  it('update appends notes (append-only)', () => {
    const task = store.create({ projectId: 'proj', description: 'a' });
    store.update(task.id, { notes: 'first note' });
    store.update(task.id, { notes: 'second note' });
    const after = store.get(task.id)!;
    expect(after.notes.map((n) => n.text)).toEqual(['first note', 'second note']);
  });

  it('update ignores empty/whitespace notes', () => {
    const task = store.create({ projectId: 'proj', description: 'a' });
    store.update(task.id, { notes: '   ' });
    store.update(task.id, { notes: '' });
    expect(store.get(task.id)!.notes).toEqual([]);
  });

  it('update patches workerId and result', () => {
    const task = store.create({ projectId: 'proj', description: 'a' });
    store.update(task.id, { workerId: 'w1' });
    store.update(task.id, { result: 'done' });
    const after = store.get(task.id)!;
    expect(after.workerId).toBe('w1');
    expect(after.result).toBe('done');
  });

  it('snapshot returns read-only projection', () => {
    const task = store.create({ projectId: 'proj', description: 'a', priority: 5 });
    const snap = store.snapshot(task.id)!;
    expect(snap.priority).toBe(5);
    expect(snap.notes).toEqual([]);
  });

  it('persists dependsOn through JSON column', () => {
    const a = store.create({ projectId: 'proj', description: 'a' });
    const b = store.create({
      projectId: 'proj',
      description: 'b',
      dependsOn: [a.id],
    });
    expect(store.get(b.id)!.dependsOn).toEqual([a.id]);
  });

  it('update terminal → same terminal does not re-stamp completedAt (audit M4)', () => {
    const task = store.create({ projectId: 'proj', description: 'a' });
    store.update(task.id, { status: 'in_progress' });
    const done = store.update(task.id, { status: 'completed' });
    const firstCompletedAt = done.completedAt!;
    // Idempotent same-terminal update (allowed by canTransition(x, x)).
    const again = store.update(task.id, { status: 'completed' });
    expect(again.completedAt).toBe(firstCompletedAt);
  });

  it('list() skips rows with corrupt JSON columns and calls onCorruptRow (audit M5)', () => {
    const corruptObservations: string[] = [];
    const tolerantStore = new SqliteTaskStore(svc.db, {
      onCorruptRow: (err: CorruptRecordError) => corruptObservations.push(err.column),
    });
    const good = tolerantStore.create({ projectId: 'proj', description: 'good' });
    // Corrupt `depends_on` directly via SQL — simulating a bad row that
    // appeared from a partial write or hand-edit.
    const bad = tolerantStore.create({ projectId: 'proj', description: 'bad' });
    svc.db.prepare(`UPDATE tasks SET depends_on = 'not-json' WHERE id = ?`).run(bad.id);
    const listed = tolerantStore.list();
    expect(listed.map((t) => t.id)).toEqual([good.id]);
    expect(corruptObservations).toEqual(['depends_on']);
  });

  it('persistence across reopen', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const file = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-task-')),
      'symphony.db',
    );
    try {
      const first = SymphonyDatabase.open({ filePath: file });
      const projStore = new SqliteProjectStore(first.db);
      projStore.register({ id: 'p', name: 'p', path: '/tmp/p', createdAt: '' });
      const firstStore = new SqliteTaskStore(first.db);
      const t = firstStore.create({
        projectId: 'p',
        description: 'persist me',
        priority: 3,
      });
      firstStore.update(t.id, { status: 'in_progress', notes: 'kicked off' });
      first.close();

      const second = SymphonyDatabase.open({ filePath: file });
      try {
        const secondStore = new SqliteTaskStore(second.db);
        const after = secondStore.get(t.id)!;
        expect(after.status).toBe('in_progress');
        expect(after.priority).toBe(3);
        expect(after.notes).toHaveLength(1);
        expect(after.notes[0]!.text).toBe('kicked off');
      } finally {
        second.close();
      }
    } finally {
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
    }
  });
});
