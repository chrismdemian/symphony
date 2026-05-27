import { describe, expect, it } from 'vitest';

import { SagaRegistry } from '../../src/state/saga-registry.js';
import {
  DuplicateSagaMembershipError,
  InvalidSagaTransitionError,
  UnknownSagaError,
  canTransitionSaga,
  isTerminalSagaStatus,
  SAGA_TRANSITIONS,
  type SagaStatus,
} from '../../src/state/saga-types.js';

describe('SagaRegistry', () => {
  it('create assigns sg-<hex> ids, starts pending, no members', () => {
    const reg = new SagaRegistry();
    const saga = reg.create({ description: 'ship cross-project feature' });
    expect(saga.id).toMatch(/^sg-[0-9a-f]{8}$/);
    expect(saga.status).toBe<SagaStatus>('pending');
    expect(saga.description).toBe('ship cross-project feature');
    expect(saga.notes).toEqual([]);
    expect(reg.listMembers(saga.id)).toEqual([]);
  });

  it('create rejects blank description', () => {
    const reg = new SagaRegistry();
    expect(() => reg.create({ description: '   ' })).toThrow(/description/);
  });

  it('list preserves insertion order', () => {
    const reg = new SagaRegistry();
    const a = reg.create({ description: 'a' });
    const b = reg.create({ description: 'b' });
    const c = reg.create({ description: 'c' });
    expect(reg.list().map((s) => s.id)).toEqual([a.id, b.id, c.id]);
  });

  it('addMember rejects unknown saga', () => {
    const reg = new SagaRegistry();
    expect(() =>
      reg.addMember({ sagaId: 'sg-missing', taskId: 'tk-1', projectId: 'proj-a' }),
    ).toThrow(UnknownSagaError);
  });

  it('addMember enforces unique task_id across sagas', () => {
    const reg = new SagaRegistry();
    const a = reg.create({ description: 'a' });
    const b = reg.create({ description: 'b' });
    reg.addMember({ sagaId: a.id, taskId: 'tk-1', projectId: 'proj-a' });
    expect(() =>
      reg.addMember({ sagaId: b.id, taskId: 'tk-1', projectId: 'proj-b' }),
    ).toThrow(DuplicateSagaMembershipError);
    expect(() =>
      reg.addMember({ sagaId: a.id, taskId: 'tk-1', projectId: 'proj-a' }),
    ).toThrow(DuplicateSagaMembershipError);
  });

  it('findMemberByTaskId returns undefined for non-members, the row for members', () => {
    const reg = new SagaRegistry();
    const s = reg.create({ description: 's' });
    reg.addMember({ sagaId: s.id, taskId: 'tk-1', projectId: 'proj-a' });
    expect(reg.findMemberByTaskId('tk-orphan')).toBeUndefined();
    const m = reg.findMemberByTaskId('tk-1');
    expect(m?.sagaId).toBe(s.id);
    expect(m?.projectId).toBe('proj-a');
    expect(m?.status).toBe('pending');
  });

  it('listMembers returns insertion-ordered members', () => {
    const reg = new SagaRegistry();
    const s = reg.create({ description: 's' });
    reg.addMember({ sagaId: s.id, taskId: 'tk-1', projectId: 'proj-a' });
    reg.addMember({ sagaId: s.id, taskId: 'tk-2', projectId: 'proj-b' });
    expect(reg.listMembers(s.id).map((m) => m.taskId)).toEqual(['tk-1', 'tk-2']);
  });

  it('updateMemberStatus is idempotent and returns the updated row', () => {
    const reg = new SagaRegistry();
    const s = reg.create({ description: 's' });
    reg.addMember({ sagaId: s.id, taskId: 'tk-1', projectId: 'proj-a' });
    expect(reg.updateMemberStatus('tk-1', 'in_progress')?.status).toBe('in_progress');
    expect(reg.updateMemberStatus('tk-1', 'in_progress')?.status).toBe('in_progress');
    expect(reg.updateMemberStatus('tk-orphan', 'completed')).toBeUndefined();
  });

  it('update transitions pending → in_progress and fires onSagaStatusChange', () => {
    const fired: SagaStatus[] = [];
    const reg = new SagaRegistry({
      onSagaStatusChange: (snap) => fired.push(snap.status),
    });
    const s = reg.create({ description: 's' });
    reg.update(s.id, { status: 'in_progress' });
    expect(fired).toEqual(['in_progress']);
    const after = reg.get(s.id);
    expect(after?.status).toBe('in_progress');
  });

  it('update rejects illegal transitions', () => {
    const reg = new SagaRegistry();
    const s = reg.create({ description: 's' });
    expect(() => reg.update(s.id, { status: 'completed' })).toThrow(
      InvalidSagaTransitionError,
    );
  });

  it('update stamps completedAt only on first terminal entry', () => {
    const reg = new SagaRegistry();
    const s = reg.create({ description: 's' });
    reg.update(s.id, { status: 'in_progress' });
    const completedAt1 = reg.update(s.id, { status: 'completed' }).completedAt;
    expect(completedAt1).toBeTruthy();
    // Idempotent same-status update — completedAt MUST NOT re-stamp.
    const completedAt2 = reg.update(s.id, { status: 'completed' }).completedAt;
    expect(completedAt2).toBe(completedAt1);
  });

  it('update rejects unknown saga', () => {
    const reg = new SagaRegistry();
    expect(() => reg.update('sg-missing', { status: 'completed' })).toThrow(
      UnknownSagaError,
    );
  });

  it('update appends notes (trimmed) and ignores blank notes', () => {
    const reg = new SagaRegistry();
    const s = reg.create({ description: 's' });
    const after1 = reg.update(s.id, { notes: 'first note' });
    expect(after1.notes.length).toBe(1);
    expect(after1.notes[0]!.text).toBe('first note');
    const after2 = reg.update(s.id, { notes: '   ' });
    expect(after2.notes.length).toBe(1);
  });

  it('snapshot includes members with project name when projectStore is wired', () => {
    const projectStore = {
      list: () => [],
      snapshot: () => undefined,
      snapshots: () => [],
      register: () => {
        throw new Error('not used');
      },
      get: (id: string) =>
        id === 'proj-a'
          ? { id: 'proj-a', name: 'MathScrabble', path: '/p/a', createdAt: '' }
          : undefined,
      delete: () => false,
    };
    const reg = new SagaRegistry({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      projectStore: projectStore as any,
    });
    const s = reg.create({ description: 's' });
    reg.addMember({ sagaId: s.id, taskId: 'tk-1', projectId: 'proj-a' });
    reg.addMember({ sagaId: s.id, taskId: 'tk-2', projectId: 'proj-missing' });
    reg.addMember({ sagaId: s.id, taskId: 'tk-3', projectId: null });
    const snap = reg.snapshot(s.id)!;
    expect(snap.members.map((m) => m.projectName)).toEqual([
      'MathScrabble',
      '(unregistered)',
      '(unregistered)',
    ]);
  });

  it('list with projectId filter returns only sagas whose members include it', () => {
    const reg = new SagaRegistry();
    const sA = reg.create({ description: 'a-only' });
    const sB = reg.create({ description: 'b-only' });
    const sAB = reg.create({ description: 'a+b' });
    reg.addMember({ sagaId: sA.id, taskId: 'tk-a', projectId: 'proj-a' });
    reg.addMember({ sagaId: sB.id, taskId: 'tk-b', projectId: 'proj-b' });
    reg.addMember({ sagaId: sAB.id, taskId: 'tk-ab1', projectId: 'proj-a' });
    reg.addMember({ sagaId: sAB.id, taskId: 'tk-ab2', projectId: 'proj-b' });
    expect(reg.list({ projectId: 'proj-a' }).map((s) => s.id)).toEqual([sA.id, sAB.id]);
    expect(reg.list({ projectId: 'proj-b' }).map((s) => s.id)).toEqual([sB.id, sAB.id]);
  });

  it('list with status filter returns matches', () => {
    const reg = new SagaRegistry();
    const s1 = reg.create({ description: 'a' });
    const s2 = reg.create({ description: 'b' });
    reg.update(s2.id, { status: 'in_progress' });
    expect(reg.list({ status: 'in_progress' }).map((s) => s.id)).toEqual([s2.id]);
    expect(reg.list({ status: ['pending', 'in_progress'] }).map((s) => s.id)).toEqual([
      s1.id,
      s2.id,
    ]);
  });

  it('SAGA_TRANSITIONS matches the documented 5-state machine', () => {
    expect(canTransitionSaga('pending', 'in_progress')).toBe(true);
    expect(canTransitionSaga('pending', 'completed')).toBe(false);
    expect(canTransitionSaga('in_progress', 'completed')).toBe(true);
    expect(canTransitionSaga('completed', 'failed')).toBe(false);
    expect(canTransitionSaga('cancelled', 'pending')).toBe(false);
    // Idempotent same-status — allowed.
    expect(canTransitionSaga('in_progress', 'in_progress')).toBe(true);
    // Sanity: each status has a non-empty transition set unless terminal.
    for (const [from, to] of Object.entries(SAGA_TRANSITIONS)) {
      const isTerminal = isTerminalSagaStatus(from as SagaStatus);
      if (isTerminal) expect(to.size).toBe(0);
      else expect(to.size).toBeGreaterThan(0);
    }
  });
});
