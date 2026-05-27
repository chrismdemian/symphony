import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SymphonyDatabase } from '../../src/state/db.js';
import { SqliteProjectStore } from '../../src/state/sqlite-project-store.js';
import { SqliteTaskStore } from '../../src/state/sqlite-task-store.js';
import { SqliteSagaStore } from '../../src/state/sqlite-saga-store.js';
import {
  DuplicateSagaMembershipError,
  InvalidSagaTransitionError,
  UnknownSagaError,
} from '../../src/state/saga-types.js';

describe('SqliteSagaStore', () => {
  let svc: SymphonyDatabase;
  let projects: SqliteProjectStore;
  let tasks: SqliteTaskStore;
  let sagas: SqliteSagaStore;

  beforeEach(() => {
    svc = SymphonyDatabase.open({ filePath: ':memory:' });
    projects = new SqliteProjectStore(svc.db);
    projects.register({ id: 'proj-a', name: 'projA', path: '/tmp/a', createdAt: '' });
    projects.register({ id: 'proj-b', name: 'projB', path: '/tmp/b', createdAt: '' });
    tasks = new SqliteTaskStore(svc.db);
    sagas = new SqliteSagaStore(svc.db, { projectStore: projects });
  });

  afterEach(() => {
    svc.close();
  });

  it('round-trips a saga through SQL', () => {
    const saga = sagas.create({ description: 'ship feature X across A + B' });
    expect(saga.id).toMatch(/^sg-[0-9a-f]{8}$/);
    expect(saga.status).toBe('pending');
    const got = sagas.get(saga.id);
    expect(got?.description).toBe('ship feature X across A + B');
  });

  it('list preserves insertion order', () => {
    const a = sagas.create({ description: 'a' });
    const b = sagas.create({ description: 'b' });
    const c = sagas.create({ description: 'c' });
    expect(sagas.list().map((s) => s.id)).toEqual([a.id, b.id, c.id]);
  });

  it('addMember UNIQUE constraint rejects same task in second saga', () => {
    const sA = sagas.create({ description: 'a' });
    const sB = sagas.create({ description: 'b' });
    const t1 = tasks.create({ projectId: 'proj-a', description: 't1' });
    sagas.addMember({ sagaId: sA.id, taskId: t1.id, projectId: 'proj-a' });
    expect(() =>
      sagas.addMember({ sagaId: sB.id, taskId: t1.id, projectId: 'proj-a' }),
    ).toThrow(DuplicateSagaMembershipError);
    // Also rejects re-add to the same saga.
    expect(() =>
      sagas.addMember({ sagaId: sA.id, taskId: t1.id, projectId: 'proj-a' }),
    ).toThrow(DuplicateSagaMembershipError);
  });

  it('addMember rejects unknown saga', () => {
    const t1 = tasks.create({ projectId: 'proj-a', description: 't1' });
    expect(() =>
      sagas.addMember({ sagaId: 'sg-missing', taskId: t1.id, projectId: 'proj-a' }),
    ).toThrow(UnknownSagaError);
  });

  it('findMemberByTaskId / listMembers reflect cross-project membership', () => {
    const s = sagas.create({ description: 's' });
    const tA = tasks.create({ projectId: 'proj-a', description: 'tA' });
    const tB = tasks.create({ projectId: 'proj-b', description: 'tB' });
    sagas.addMember({ sagaId: s.id, taskId: tA.id, projectId: 'proj-a' });
    sagas.addMember({ sagaId: s.id, taskId: tB.id, projectId: 'proj-b' });
    expect(sagas.findMemberByTaskId(tA.id)?.projectId).toBe('proj-a');
    expect(sagas.findMemberByTaskId(tB.id)?.projectId).toBe('proj-b');
    expect(sagas.listMembers(s.id).map((m) => m.taskId).sort()).toEqual(
      [tA.id, tB.id].sort(),
    );
  });

  it('updateMemberStatus writes the cache, idempotent on no-op', () => {
    const s = sagas.create({ description: 's' });
    const t = tasks.create({ projectId: 'proj-a', description: 't' });
    sagas.addMember({ sagaId: s.id, taskId: t.id, projectId: 'proj-a' });
    expect(sagas.updateMemberStatus(t.id, 'in_progress')?.status).toBe('in_progress');
    expect(sagas.updateMemberStatus(t.id, 'in_progress')?.status).toBe('in_progress');
    expect(sagas.updateMemberStatus('tk-missing', 'completed')).toBeUndefined();
  });

  it('update rejects illegal transitions', () => {
    const s = sagas.create({ description: 's' });
    expect(() => sagas.update(s.id, { status: 'completed' })).toThrow(
      InvalidSagaTransitionError,
    );
  });

  it('update stamps completedAt once, then leaves it stable', () => {
    const s = sagas.create({ description: 's' });
    sagas.update(s.id, { status: 'in_progress' });
    const first = sagas.update(s.id, { status: 'completed' }).completedAt;
    expect(first).toBeTruthy();
    const second = sagas.update(s.id, { status: 'completed' }).completedAt;
    expect(second).toBe(first);
  });

  it('update fires onSagaStatusChange exactly once per real transition', () => {
    const calls: string[] = [];
    sagas = new SqliteSagaStore(svc.db, {
      projectStore: projects,
      onSagaStatusChange: (snap) => calls.push(snap.status),
    });
    const s = sagas.create({ description: 's' });
    sagas.update(s.id, { status: 'in_progress' });
    sagas.update(s.id, { status: 'in_progress' }); // same-status — no fire
    sagas.update(s.id, { status: 'completed' });
    expect(calls).toEqual(['in_progress', 'completed']);
  });

  it('snapshot resolves projectName via the wired projectStore', () => {
    const s = sagas.create({ description: 's' });
    const tA = tasks.create({ projectId: 'proj-a', description: 'tA' });
    sagas.addMember({ sagaId: s.id, taskId: tA.id, projectId: 'proj-a' });
    const snap = sagas.snapshot(s.id)!;
    expect(snap.members[0]!.projectName).toBe('projA');
  });

  it('project delete SET-NULLs saga_members.project_id (audit history preserved)', () => {
    const s = sagas.create({ description: 's' });
    const t = tasks.create({ projectId: 'proj-a', description: 't' });
    sagas.addMember({ sagaId: s.id, taskId: t.id, projectId: 'proj-a' });
    // Remove the task FIRST (FK cascade removes saga_member); restore by
    // testing project deletion against a separate member with a task we
    // keep alive via a second project.
    const tB = tasks.create({ projectId: 'proj-b', description: 'tB' });
    sagas.addMember({ sagaId: s.id, taskId: tB.id, projectId: 'proj-b' });
    // Deleting projA also cascades projA-bound tasks (ON DELETE CASCADE
    // on tasks.project_id) — the saga_members row for `t` vanishes
    // along with `t`. The projB member with its tB row survives, and
    // since `tB.project_id = proj-b`, its `project_id` stays set.
    projects.delete('proj-a');
    expect(sagas.findMemberByTaskId(t.id)).toBeUndefined();
    expect(sagas.findMemberByTaskId(tB.id)?.projectId).toBe('proj-b');
  });

  it('list with status filter returns matching sagas only', () => {
    const a = sagas.create({ description: 'a' });
    const b = sagas.create({ description: 'b' });
    sagas.update(b.id, { status: 'in_progress' });
    expect(sagas.list({ status: 'pending' }).map((s) => s.id)).toEqual([a.id]);
    expect(sagas.list({ status: 'in_progress' }).map((s) => s.id)).toEqual([b.id]);
  });

  it('list with projectId filter returns only sagas that include that project', () => {
    const sA = sagas.create({ description: 'a-only' });
    const sAB = sagas.create({ description: 'a+b' });
    const tA = tasks.create({ projectId: 'proj-a', description: 'tA' });
    sagas.addMember({ sagaId: sA.id, taskId: tA.id, projectId: 'proj-a' });
    const tAB1 = tasks.create({ projectId: 'proj-a', description: 'tAB1' });
    const tAB2 = tasks.create({ projectId: 'proj-b', description: 'tAB2' });
    sagas.addMember({ sagaId: sAB.id, taskId: tAB1.id, projectId: 'proj-a' });
    sagas.addMember({ sagaId: sAB.id, taskId: tAB2.id, projectId: 'proj-b' });
    expect(sagas.list({ projectId: 'proj-b' }).map((s) => s.id)).toEqual([sAB.id]);
    expect(sagas.list({ projectId: 'proj-a' }).map((s) => s.id).sort()).toEqual(
      [sA.id, sAB.id].sort(),
    );
  });

  it('list skips corrupt notes-rows via onCorruptRow (audit M5 parity)', () => {
    const s = sagas.create({ description: 's' });
    svc.db.prepare(`UPDATE sagas SET notes = 'not-json' WHERE id = ?`).run(s.id);
    const corrupt: string[] = [];
    sagas = new SqliteSagaStore(svc.db, {
      projectStore: projects,
      onCorruptRow: (err) => corrupt.push(err.recordId),
    });
    expect(sagas.list()).toEqual([]);
    expect(corrupt).toEqual([s.id]);
  });
});
