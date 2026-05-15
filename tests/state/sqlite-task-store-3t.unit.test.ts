import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SymphonyDatabase } from '../../src/state/db.js';
import { SqliteProjectStore } from '../../src/state/sqlite-project-store.js';
import { SqliteTaskStore } from '../../src/state/sqlite-task-store.js';
import type { TaskSnapshot } from '../../src/state/types.js';

/**
 * Phase 3T — `SqliteTaskStore.cancelAllPending(projectId?)`. SQL parity
 * with the in-memory `TaskRegistry.cancelAllPending`. Uses a single
 * transaction for the SELECT-pending-ids → UPDATE-cancel cycle so it's
 * atomic with respect to concurrent `claim()` callers.
 */
describe('SqliteTaskStore.cancelAllPending (3T)', () => {
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

  it('returns empty when no pending tasks exist', () => {
    expect(store.cancelAllPending().cancelledIds).toEqual([]);
  });

  it('cancels every pending task globally and fires onTaskStatusChange per task', () => {
    const events: TaskSnapshot[] = [];
    const storeWithHook = new SqliteTaskStore(svc.db, {
      onTaskStatusChange: (snap) => events.push(snap),
    });
    const a = storeWithHook.create({ projectId: 'p1', description: 'A' });
    const b = storeWithHook.create({ projectId: 'p1', description: 'B' });
    const c = storeWithHook.create({ projectId: 'p2', description: 'C' });

    const result = storeWithHook.cancelAllPending();
    expect([...result.cancelledIds].sort()).toEqual([a.id, b.id, c.id].sort());

    expect(events.length).toBe(3);
    expect(new Set(events.map((e) => e.status))).toEqual(new Set(['cancelled']));

    for (const id of [a.id, b.id, c.id]) {
      const rec = storeWithHook.get(id);
      expect(rec?.status).toBe('cancelled');
      expect(rec?.completedAt).toBeDefined();
    }
  });

  it('skips in_progress / completed tasks (only pending → cancelled)', () => {
    const pending = store.create({ projectId: 'p1', description: 'P' });
    const inProgress = store.create({ projectId: 'p1', description: 'IP' });
    store.update(inProgress.id, { status: 'in_progress' });
    const completed = store.create({ projectId: 'p1', description: 'C' });
    store.update(completed.id, { status: 'in_progress' });
    store.update(completed.id, { status: 'completed' });

    const result = store.cancelAllPending();
    expect(result.cancelledIds).toEqual([pending.id]);
    expect(store.get(inProgress.id)?.status).toBe('in_progress');
    expect(store.get(completed.id)?.status).toBe('completed');
  });

  it('projectId arg scopes the cancellation', () => {
    const a = store.create({ projectId: 'p1', description: 'A' });
    const b = store.create({ projectId: 'p2', description: 'B' });
    const c = store.create({ projectId: 'p2', description: 'C' });

    const result = store.cancelAllPending('p2');
    expect([...result.cancelledIds].sort()).toEqual([b.id, c.id].sort());
    expect(store.get(a.id)?.status).toBe('pending');
    expect(store.get(b.id)?.status).toBe('cancelled');
    expect(store.get(c.id)?.status).toBe('cancelled');
  });

  it('is idempotent — a second call returns an empty list', () => {
    const onChange = vi.fn();
    const storeWithHook = new SqliteTaskStore(svc.db, {
      onTaskStatusChange: onChange,
    });
    storeWithHook.create({ projectId: 'p1', description: 'A' });
    storeWithHook.create({ projectId: 'p1', description: 'B' });

    const first = storeWithHook.cancelAllPending();
    expect(first.cancelledIds).toHaveLength(2);
    expect(onChange).toHaveBeenCalledTimes(2);

    onChange.mockClear();
    const second = storeWithHook.cancelAllPending();
    expect(second.cancelledIds).toEqual([]);
    expect(onChange).not.toHaveBeenCalled();
  });
});
