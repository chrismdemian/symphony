import { describe, expect, it, vi } from 'vitest';
import { TaskRegistry } from '../../src/state/task-registry.js';
import type { TaskSnapshot } from '../../src/state/types.js';

/**
 * Phase 3T — `TaskRegistry.cancelAllPending(projectId?)`. Used by the
 * `runtime.interrupt` RPC to flip every pending task to `cancelled` in
 * one shot when the user pivots.
 */

const ISO = '2026-04-23T00:00:00.000Z';

describe('TaskRegistry.cancelAllPending (3T)', () => {
  it('returns empty when there are no pending tasks', () => {
    const r = new TaskRegistry({ now: () => Date.parse(ISO) });
    const result = r.cancelAllPending();
    expect(result.cancelledIds).toEqual([]);
  });

  it('cancels every pending task globally and fires onTaskStatusChange per task', () => {
    const events: TaskSnapshot[] = [];
    const r = new TaskRegistry({
      now: () => Date.parse(ISO),
      onTaskStatusChange: (snap) => events.push(snap),
    });
    const a = r.create({ projectId: 'p1', description: 'A' });
    const b = r.create({ projectId: 'p1', description: 'B' });
    const c = r.create({ projectId: 'p2', description: 'C' });

    const result = r.cancelAllPending();
    expect([...result.cancelledIds].sort()).toEqual([a.id, b.id, c.id].sort());

    // All three transitioned; each fires once.
    expect(events.length).toBe(3);
    expect(new Set(events.map((e) => e.status))).toEqual(new Set(['cancelled']));

    // Records show terminal state with completedAt stamped.
    for (const id of [a.id, b.id, c.id]) {
      const rec = r.get(id);
      expect(rec?.status).toBe('cancelled');
      expect(rec?.completedAt).toBe(ISO);
    }
  });

  it('skips in_progress / completed / failed tasks (only pending → cancelled)', () => {
    const r = new TaskRegistry({ now: () => Date.parse(ISO) });
    const pending = r.create({ projectId: 'p1', description: 'P' });
    const inProgress = r.create({ projectId: 'p1', description: 'IP' });
    r.update(inProgress.id, { status: 'in_progress' });
    const completed = r.create({ projectId: 'p1', description: 'C' });
    r.update(completed.id, { status: 'in_progress' });
    r.update(completed.id, { status: 'completed' });

    const result = r.cancelAllPending();
    expect(result.cancelledIds).toEqual([pending.id]);
    expect(r.get(inProgress.id)?.status).toBe('in_progress');
    expect(r.get(completed.id)?.status).toBe('completed');
  });

  it('projectId arg scopes the cancellation', () => {
    const r = new TaskRegistry({ now: () => Date.parse(ISO) });
    const a = r.create({ projectId: 'p1', description: 'A' });
    const b = r.create({ projectId: 'p2', description: 'B' });
    const c = r.create({ projectId: 'p2', description: 'C' });

    const result = r.cancelAllPending('p2');
    expect([...result.cancelledIds].sort()).toEqual([b.id, c.id].sort());
    expect(r.get(a.id)?.status).toBe('pending');
    expect(r.get(b.id)?.status).toBe('cancelled');
    expect(r.get(c.id)?.status).toBe('cancelled');
  });

  it('is idempotent — a second call returns an empty list', () => {
    const onChange = vi.fn();
    const r = new TaskRegistry({
      now: () => Date.parse(ISO),
      onTaskStatusChange: onChange,
    });
    r.create({ projectId: 'p1', description: 'A' });
    r.create({ projectId: 'p1', description: 'B' });

    const first = r.cancelAllPending();
    expect(first.cancelledIds).toHaveLength(2);
    expect(onChange).toHaveBeenCalledTimes(2);

    onChange.mockClear();
    const second = r.cancelAllPending();
    expect(second.cancelledIds).toEqual([]);
    expect(onChange).not.toHaveBeenCalled();
  });
});
