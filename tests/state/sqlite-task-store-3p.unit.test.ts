import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SymphonyDatabase } from '../../src/state/db.js';
import { SqliteProjectStore } from '../../src/state/sqlite-project-store.js';
import { SqliteTaskStore } from '../../src/state/sqlite-task-store.js';

/**
 * Phase 3P — SQLite-backed parity with the in-memory `TaskRegistry`:
 *   - `list({readyOnly: true})` filter (single-project + cross-project)
 *   - `onTaskStatusChange` fires on real transitions only
 *
 * Identical scenario coverage to `task-registry-3p.unit.test.ts` so we
 * can detect any drift between the two impls (mirrors 2B.1 m4 pattern).
 */

describe('SqliteTaskStore — readyOnly filter', () => {
  let svc: ReturnType<typeof SymphonyDatabase.open>;
  let projects: SqliteProjectStore;
  let store: SqliteTaskStore;

  beforeEach(() => {
    svc = SymphonyDatabase.open({ filePath: ':memory:' });
    projects = new SqliteProjectStore(svc.db);
    projects.register({ id: 'p1', name: 'p1', path: '/tmp/p1', createdAt: '' });
    projects.register({ id: 'p2', name: 'p2', path: '/tmp/p2', createdAt: '' });
    store = new SqliteTaskStore(svc.db);
  });

  afterEach(() => {
    svc.close();
  });

  it('returns pending tasks with no deps', () => {
    const a = store.create({ projectId: 'p1', description: 'A' });
    expect(store.list({ readyOnly: true }).map((t) => t.id)).toEqual([a.id]);
  });

  it('excludes pending tasks whose deps are not all completed', () => {
    const a = store.create({ projectId: 'p1', description: 'A' });
    const b = store.create({ projectId: 'p1', description: 'B', dependsOn: [a.id] });
    expect(store.list({ readyOnly: true }).map((t) => t.id)).toEqual([a.id]);
    expect(store.list({ readyOnly: true }).map((t) => t.id)).not.toContain(b.id);
  });

  it('includes pending tasks once all deps are completed', () => {
    const a = store.create({ projectId: 'p1', description: 'A' });
    const b = store.create({ projectId: 'p1', description: 'B', dependsOn: [a.id] });
    store.update(a.id, { status: 'in_progress' });
    store.update(a.id, { status: 'completed' });
    expect(store.list({ readyOnly: true }).map((t) => t.id)).toEqual([b.id]);
  });

  it('cross-project readiness: project filter does not blind the gate', () => {
    const a = store.create({ projectId: 'p1', description: 'A' });
    const b = store.create({ projectId: 'p2', description: 'B', dependsOn: [a.id] });
    store.update(a.id, { status: 'in_progress' });
    store.update(a.id, { status: 'completed' });
    expect(store.list({ projectId: 'p2', readyOnly: true }).map((t) => t.id)).toEqual([b.id]);
  });

  it('stacks with status filter — readyOnly never returns non-pending', () => {
    const a = store.create({ projectId: 'p1', description: 'A' });
    store.update(a.id, { status: 'in_progress' });
    expect(
      store.list({ status: 'in_progress', readyOnly: true }).map((t) => t.id),
    ).toEqual([]);
  });

  it('excludes tasks whose dep id is unknown (orphan dep)', () => {
    // Hand-crafted scenario: create A, then manually mutate the DB to set
    // a dep on a ghost id. The SqliteTaskStore.create path validates
    // `depends_on` is well-formed JSON but doesn't check id existence
    // (matches the in-memory TaskRegistry — Phase 2A.3 left dep id
    // existence to the tool wrapper). The filter must still gate.
    const a = store.create({ projectId: 'p1', description: 'A' });
    svc.db.prepare(`UPDATE tasks SET depends_on = '["MISSING"]' WHERE id = ?`).run(a.id);
    expect(store.list({ readyOnly: true })).toEqual([]);
  });
});

describe('SqliteTaskStore — onTaskStatusChange', () => {
  let svc: ReturnType<typeof SymphonyDatabase.open>;
  let projects: SqliteProjectStore;

  beforeEach(() => {
    svc = SymphonyDatabase.open({ filePath: ':memory:' });
    projects = new SqliteProjectStore(svc.db);
    projects.register({ id: 'p1', name: 'p1', path: '/tmp/p1', createdAt: '' });
  });

  afterEach(() => {
    svc.close();
  });

  it('fires on a real status transition', () => {
    const cb = vi.fn();
    const store = new SqliteTaskStore(svc.db, { onTaskStatusChange: cb });
    const a = store.create({ projectId: 'p1', description: 'A' });
    store.update(a.id, { status: 'in_progress' });
    expect(cb).toHaveBeenCalledOnce();
    expect(cb.mock.calls[0]?.[0]).toMatchObject({ id: a.id, status: 'in_progress' });
  });

  it('does NOT fire on same-status idempotent updates', () => {
    const cb = vi.fn();
    const store = new SqliteTaskStore(svc.db, { onTaskStatusChange: cb });
    const a = store.create({ projectId: 'p1', description: 'A' });
    store.update(a.id, { status: 'pending' });
    expect(cb).not.toHaveBeenCalled();
  });

  it('does NOT fire on notes/workerId/result patches', () => {
    const cb = vi.fn();
    const store = new SqliteTaskStore(svc.db, { onTaskStatusChange: cb });
    const a = store.create({ projectId: 'p1', description: 'A' });
    store.update(a.id, { notes: 'a comment' });
    store.update(a.id, { workerId: 'wk-abc' });
    store.update(a.id, { result: 'done' });
    expect(cb).not.toHaveBeenCalled();
  });

  it('fires for each distinct status transition in a chain', () => {
    const cb = vi.fn();
    const store = new SqliteTaskStore(svc.db, { onTaskStatusChange: cb });
    const a = store.create({ projectId: 'p1', description: 'A' });
    store.update(a.id, { status: 'in_progress' });
    store.update(a.id, { status: 'completed' });
    expect(cb).toHaveBeenCalledTimes(2);
    expect(cb.mock.calls[0]?.[0]).toMatchObject({ status: 'in_progress' });
    expect(cb.mock.calls[1]?.[0]).toMatchObject({ status: 'completed' });
  });

  it('swallows callback errors and still updates SQL', () => {
    const cb = vi.fn(() => {
      throw new Error('boom');
    });
    const store = new SqliteTaskStore(svc.db, { onTaskStatusChange: cb });
    const a = store.create({ projectId: 'p1', description: 'A' });
    expect(() => store.update(a.id, { status: 'in_progress' })).not.toThrow();
    expect(store.get(a.id)?.status).toBe('in_progress');
  });

  it('does not fire when the state-machine transition throws', () => {
    const cb = vi.fn();
    const store = new SqliteTaskStore(svc.db, { onTaskStatusChange: cb });
    const a = store.create({ projectId: 'p1', description: 'A' });
    store.update(a.id, { status: 'in_progress' });
    store.update(a.id, { status: 'completed' });
    cb.mockReset();
    expect(() => store.update(a.id, { status: 'pending' })).toThrow();
    expect(cb).not.toHaveBeenCalled();
  });
});

describe('SqliteTaskStore — claim (3P audit M1)', () => {
  let svc: ReturnType<typeof SymphonyDatabase.open>;
  let projects: SqliteProjectStore;

  beforeEach(() => {
    svc = SymphonyDatabase.open({ filePath: ':memory:' });
    projects = new SqliteProjectStore(svc.db);
    projects.register({ id: 'p1', name: 'p1', path: '/tmp/p1', createdAt: '' });
  });

  afterEach(() => {
    svc.close();
  });

  it('claims a pending task atomically (SQL UPDATE WHERE status=pending)', () => {
    const store = new SqliteTaskStore(svc.db);
    const a = store.create({ projectId: 'p1', description: 'A' });
    const claimed = store.claim(a.id, 'wk-1');
    expect(claimed).not.toBeNull();
    expect(claimed?.status).toBe('in_progress');
    expect(claimed?.workerId).toBe('wk-1');
    // SQL reflects the claim.
    expect(store.get(a.id)?.status).toBe('in_progress');
    expect(store.get(a.id)?.workerId).toBe('wk-1');
  });

  it('returns null on second claim of an already-claimed task', () => {
    const store = new SqliteTaskStore(svc.db);
    const a = store.create({ projectId: 'p1', description: 'A' });
    expect(store.claim(a.id, 'wk-1')).not.toBeNull();
    expect(store.claim(a.id, 'wk-2')).toBeNull();
    expect(store.get(a.id)?.workerId).toBe('wk-1');
  });

  it('returns null for unknown id', () => {
    const store = new SqliteTaskStore(svc.db);
    expect(store.claim('tk-ghost', 'wk-1')).toBeNull();
  });

  it('returns null for non-pending status', () => {
    const store = new SqliteTaskStore(svc.db);
    const a = store.create({ projectId: 'p1', description: 'A' });
    store.update(a.id, { status: 'cancelled' });
    expect(store.claim(a.id, 'wk-1')).toBeNull();
  });

  it('fires onTaskStatusChange once on successful claim, zero on rejected', () => {
    const cb = vi.fn();
    const store = new SqliteTaskStore(svc.db, { onTaskStatusChange: cb });
    const a = store.create({ projectId: 'p1', description: 'A' });
    store.claim(a.id, 'wk-1');
    expect(cb).toHaveBeenCalledOnce();
    cb.mockReset();
    store.claim(a.id, 'wk-2'); // rejected
    expect(cb).not.toHaveBeenCalled();
  });
});
