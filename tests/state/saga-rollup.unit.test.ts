import { describe, expect, it, vi } from 'vitest';

import { computeRollup, createSagaRollupListener } from '../../src/state/saga-rollup.js';
import type { SagaMemberRecord, SagaStatus, SagaStore } from '../../src/state/saga-types.js';
import type { TaskStatus } from '../../src/state/types.js';

function member(taskId: string, status: TaskStatus): SagaMemberRecord {
  return {
    sagaId: 'sg-test',
    taskId,
    projectId: 'proj-a',
    status,
    addedAt: '2026-05-26T00:00:00.000Z',
  };
}

describe('computeRollup', () => {
  it('all members pending → pending', () => {
    expect(
      computeRollup([member('t1', 'pending'), member('t2', 'pending')], {
        taskId: 't1',
        status: 'pending',
      }),
    ).toBe<SagaStatus>('pending');
  });

  it('any member in_progress → in_progress', () => {
    expect(
      computeRollup([member('t1', 'in_progress'), member('t2', 'pending')], {
        taskId: 't1',
        status: 'in_progress',
      }),
    ).toBe<SagaStatus>('in_progress');
  });

  it('all members completed → completed', () => {
    expect(
      computeRollup([member('t1', 'completed'), member('t2', 'completed')], {
        taskId: 't2',
        status: 'completed',
      }),
    ).toBe<SagaStatus>('completed');
  });

  it('any failed member → failed', () => {
    expect(
      computeRollup(
        [member('t1', 'completed'), member('t2', 'failed'), member('t3', 'pending')],
        { taskId: 't2', status: 'failed' },
      ),
    ).toBe<SagaStatus>('failed');
  });

  it('any cancelled member → failed (cancellation rolls up as failure of intent)', () => {
    expect(
      computeRollup([member('t1', 'completed'), member('t2', 'cancelled')], {
        taskId: 't2',
        status: 'cancelled',
      }),
    ).toBe<SagaStatus>('failed');
  });

  it('justChanged overlays the cached members[] (cache may be stale)', () => {
    // Cache still says t1=pending, but the transition we are processing
    // says t1=completed. The rollup MUST use the overlay value.
    expect(
      computeRollup([member('t1', 'pending'), member('t2', 'completed')], {
        taskId: 't1',
        status: 'completed',
      }),
    ).toBe<SagaStatus>('completed');
  });

  it('empty members[] → pending (defensive — saga created without members)', () => {
    expect(
      computeRollup([], { taskId: 't1', status: 'pending' }),
    ).toBe<SagaStatus>('pending');
  });

  it('mixed in_progress + completed but no failure → in_progress', () => {
    expect(
      computeRollup([member('t1', 'completed'), member('t2', 'in_progress')], {
        taskId: 't2',
        status: 'in_progress',
      }),
    ).toBe<SagaStatus>('in_progress');
  });

  it('single member completed → completed', () => {
    expect(
      computeRollup([member('t1', 'completed')], { taskId: 't1', status: 'completed' }),
    ).toBe<SagaStatus>('completed');
  });

  it('single member failed → failed', () => {
    expect(
      computeRollup([member('t1', 'failed')], { taskId: 't1', status: 'failed' }),
    ).toBe<SagaStatus>('failed');
  });

  it('failure precedence — failure wins over in_progress', () => {
    expect(
      computeRollup([member('t1', 'in_progress'), member('t2', 'failed')], {
        taskId: 't2',
        status: 'failed',
      }),
    ).toBe<SagaStatus>('failed');
  });

  it('failure precedence — failure wins over completed', () => {
    expect(
      computeRollup([member('t1', 'completed'), member('t2', 'failed')], {
        taskId: 't2',
        status: 'failed',
      }),
    ).toBe<SagaStatus>('failed');
  });
});

/**
 * `createSagaRollupListener` integration with a fake SagaStore. The
 * real SagaRegistry / SqliteSagaStore are exercised by the saga-registry /
 * sqlite-saga-store unit tests below.
 */
describe('createSagaRollupListener', () => {
  function fakeStore(members: SagaMemberRecord[], sagaStatus: SagaStatus) {
    const updates: { id: string; status: SagaStatus }[] = [];
    const cacheWrites: { taskId: string; status: TaskStatus }[] = [];
    const store: SagaStore = {
      list: () => [],
      get: vi.fn(() => ({
        id: 'sg-test',
        description: 'd',
        status: sagaStatus,
        notes: [],
        createdAt: '',
        updatedAt: '',
      })),
      create: vi.fn(),
      update: vi.fn((id, patch) => {
        if (patch.status !== undefined) {
          updates.push({ id, status: patch.status });
          sagaStatus = patch.status;
        }
        return {
          id,
          description: 'd',
          status: sagaStatus,
          notes: [],
          createdAt: '',
          updatedAt: '',
        };
      }) as unknown as SagaStore['update'],
      snapshot: vi.fn(),
      snapshots: vi.fn(() => []),
      size: vi.fn(() => 1),
      addMember: vi.fn() as unknown as SagaStore['addMember'],
      findMemberByTaskId: (taskId) => members.find((m) => m.taskId === taskId),
      listMembers: () => members.slice(),
      updateMemberStatus: vi.fn((taskId, status) => {
        cacheWrites.push({ taskId, status });
        const m = members.find((mm) => mm.taskId === taskId);
        if (m === undefined) return undefined;
        m.status = status;
        return m;
      }) as unknown as SagaStore['updateMemberStatus'],
    };
    return { store, updates, cacheWrites };
  }

  it('no-op for tasks that are not saga members', () => {
    const { store, updates } = fakeStore([], 'pending');
    const listener = createSagaRollupListener({ sagaStore: store });
    listener({
      id: 'orphan',
      projectId: 'proj-a',
      description: 'x',
      status: 'completed',
      priority: 0,
      dependsOn: [],
      notes: [],
      createdAt: '',
      updatedAt: '',
    });
    expect(updates).toEqual([]);
  });

  it('writes the saga row when rollup changes', () => {
    const members: SagaMemberRecord[] = [
      member('t1', 'pending'),
      member('t2', 'pending'),
    ];
    const { store, updates } = fakeStore(members, 'pending');
    const listener = createSagaRollupListener({ sagaStore: store });
    listener({
      id: 't1',
      projectId: 'proj-a',
      description: '',
      status: 'in_progress',
      priority: 0,
      dependsOn: [],
      notes: [],
      createdAt: '',
      updatedAt: '',
    });
    expect(updates).toEqual([{ id: 'sg-test', status: 'in_progress' }]);
  });

  it('terminal saga is immutable (rollup writer does not poke a completed saga)', () => {
    const members: SagaMemberRecord[] = [member('t1', 'completed')];
    const { store, updates } = fakeStore(members, 'completed');
    const listener = createSagaRollupListener({ sagaStore: store });
    listener({
      id: 't1',
      projectId: 'proj-a',
      description: '',
      // Hypothetical re-transition (state machine rejects, but defensive).
      status: 'failed',
      priority: 0,
      dependsOn: [],
      notes: [],
      createdAt: '',
      updatedAt: '',
    });
    expect(updates).toEqual([]);
  });

  it('idempotent — same rollup target as current saga status writes nothing', () => {
    const members: SagaMemberRecord[] = [member('t1', 'in_progress')];
    const { store, updates } = fakeStore(members, 'in_progress');
    const listener = createSagaRollupListener({ sagaStore: store });
    listener({
      id: 't1',
      projectId: 'proj-a',
      description: '',
      status: 'in_progress',
      priority: 0,
      dependsOn: [],
      notes: [],
      createdAt: '',
      updatedAt: '',
    });
    expect(updates).toEqual([]);
  });

  it('updates the member status cache even when the rollup is a no-op', () => {
    const members: SagaMemberRecord[] = [
      member('t1', 'pending'),
      member('t2', 'in_progress'),
    ];
    const { store, cacheWrites } = fakeStore(members, 'in_progress');
    const listener = createSagaRollupListener({ sagaStore: store });
    listener({
      id: 't1',
      projectId: 'proj-a',
      description: '',
      status: 'in_progress',
      priority: 0,
      dependsOn: [],
      notes: [],
      createdAt: '',
      updatedAt: '',
    });
    expect(cacheWrites).toEqual([{ taskId: 't1', status: 'in_progress' }]);
  });

  it('errors thrown by the store are routed to onError, not propagated', () => {
    const store: SagaStore = {
      list: () => [],
      get: () => undefined,
      create: vi.fn(),
      update: vi.fn(),
      snapshot: () => undefined,
      snapshots: () => [],
      size: () => 0,
      addMember: vi.fn() as unknown as SagaStore['addMember'],
      findMemberByTaskId: () => {
        throw new Error('boom');
      },
      listMembers: () => [],
      updateMemberStatus: vi.fn() as unknown as SagaStore['updateMemberStatus'],
    };
    const errors: { err: unknown; taskId: string }[] = [];
    const listener = createSagaRollupListener({
      sagaStore: store,
      onError: (err, taskId) => errors.push({ err, taskId }),
    });
    expect(() =>
      listener({
        id: 't1',
        projectId: 'proj-a',
        description: '',
        status: 'completed',
        priority: 0,
        dependsOn: [],
        notes: [],
        createdAt: '',
        updatedAt: '',
      }),
    ).not.toThrow();
    expect(errors.length).toBe(1);
    expect((errors[0]!.err as Error).message).toBe('boom');
    expect(errors[0]!.taskId).toBe('t1');
  });
});
