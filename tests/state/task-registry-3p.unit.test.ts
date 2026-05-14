import { describe, expect, it, vi } from 'vitest';
import { TaskRegistry } from '../../src/state/task-registry.js';
import type { TaskRecord } from '../../src/state/types.js';

/**
 * Phase 3P — TaskRegistry additions:
 *   - `list({readyOnly: true})` filters to pending tasks with all deps completed
 *   - `onTaskStatusChange` fires on real status transitions, never on
 *     same-status / notes-only / workerId-only / result-only patches
 *
 * Cross-project readiness (a dep in proj-A gates a task in proj-B) is
 * exercised by passing `projectId: 'p2'` to `list({readyOnly: true})`
 * — the gate still sees the proj-A dep via the FULL-set lookup.
 */

const ISO = '2026-04-23T00:00:00.000Z';

describe('TaskRegistry — readyOnly filter', () => {
  it('returns empty when no tasks are pending', () => {
    const r = new TaskRegistry({ now: () => Date.parse(ISO) });
    const a = r.create({ projectId: 'p1', description: 'A' });
    r.update(a.id, { status: 'in_progress' });
    expect(r.list({ readyOnly: true })).toEqual([]);
  });

  it('returns pending tasks with no deps', () => {
    const r = new TaskRegistry({ now: () => Date.parse(ISO) });
    const a = r.create({ projectId: 'p1', description: 'A' });
    expect(r.list({ readyOnly: true }).map((t) => t.id)).toEqual([a.id]);
  });

  it('excludes pending tasks whose deps are not all completed', () => {
    const r = new TaskRegistry({ now: () => Date.parse(ISO) });
    const a = r.create({ projectId: 'p1', description: 'A' });
    const b = r.create({ projectId: 'p1', description: 'B', dependsOn: [a.id] });
    // A still pending → B not ready
    expect(r.list({ readyOnly: true }).map((t) => t.id)).toEqual([a.id]);
    expect(r.list({ readyOnly: true }).map((t) => t.id)).not.toContain(b.id);
  });

  it('includes pending tasks once all deps are completed', () => {
    const r = new TaskRegistry({ now: () => Date.parse(ISO) });
    const a = r.create({ projectId: 'p1', description: 'A' });
    const b = r.create({ projectId: 'p1', description: 'B', dependsOn: [a.id] });
    r.update(a.id, { status: 'in_progress' });
    r.update(a.id, { status: 'completed' });
    expect(r.list({ readyOnly: true }).map((t) => t.id)).toEqual([b.id]);
  });

  it('cross-project: pending task in proj-B with completed dep in proj-A is ready', () => {
    const r = new TaskRegistry({ now: () => Date.parse(ISO) });
    const a = r.create({ projectId: 'p1', description: 'A' });
    const b = r.create({ projectId: 'p2', description: 'B', dependsOn: [a.id] });
    r.update(a.id, { status: 'in_progress' });
    r.update(a.id, { status: 'completed' });
    // Filter to project p2 ONLY — even with the cross-project hide,
    // the gate must still see A via the full-set lookup.
    expect(r.list({ projectId: 'p2', readyOnly: true }).map((t) => t.id)).toEqual([b.id]);
  });

  it('stacks with status filter — readyOnly never includes non-pending', () => {
    const r = new TaskRegistry({ now: () => Date.parse(ISO) });
    const a = r.create({ projectId: 'p1', description: 'A' });
    r.update(a.id, { status: 'in_progress' });
    expect(
      r
        .list({ status: 'in_progress', readyOnly: true })
        .map((t) => t.id),
    ).toEqual([]);
  });
});

describe('TaskRegistry — onTaskStatusChange', () => {
  it('fires on a real status transition', () => {
    const cb = vi.fn();
    const r = new TaskRegistry({ now: () => Date.parse(ISO), onTaskStatusChange: cb });
    const a = r.create({ projectId: 'p1', description: 'A' });
    r.update(a.id, { status: 'in_progress' });
    expect(cb).toHaveBeenCalledOnce();
    const call = cb.mock.calls[0]?.[0] as TaskRecord;
    expect(call.id).toBe(a.id);
    expect(call.status).toBe('in_progress');
  });

  it('does NOT fire on same-status idempotent updates', () => {
    const cb = vi.fn();
    const r = new TaskRegistry({ now: () => Date.parse(ISO), onTaskStatusChange: cb });
    const a = r.create({ projectId: 'p1', description: 'A' });
    r.update(a.id, { status: 'pending' });
    expect(cb).not.toHaveBeenCalled();
  });

  it('does NOT fire on notes-only patches', () => {
    const cb = vi.fn();
    const r = new TaskRegistry({ now: () => Date.parse(ISO), onTaskStatusChange: cb });
    const a = r.create({ projectId: 'p1', description: 'A' });
    r.update(a.id, { notes: 'a comment' });
    expect(cb).not.toHaveBeenCalled();
  });

  it('does NOT fire on workerId-only patches', () => {
    const cb = vi.fn();
    const r = new TaskRegistry({ now: () => Date.parse(ISO), onTaskStatusChange: cb });
    const a = r.create({ projectId: 'p1', description: 'A' });
    r.update(a.id, { workerId: 'wk-abc' });
    expect(cb).not.toHaveBeenCalled();
  });

  it('does NOT fire on result-only patches', () => {
    const cb = vi.fn();
    const r = new TaskRegistry({ now: () => Date.parse(ISO), onTaskStatusChange: cb });
    const a = r.create({ projectId: 'p1', description: 'A' });
    r.update(a.id, { result: 'done' });
    expect(cb).not.toHaveBeenCalled();
  });

  it('fires for each distinct status transition in a chain', () => {
    const cb = vi.fn();
    const r = new TaskRegistry({ now: () => Date.parse(ISO), onTaskStatusChange: cb });
    const a = r.create({ projectId: 'p1', description: 'A' });
    r.update(a.id, { status: 'in_progress' });
    r.update(a.id, { status: 'completed' });
    expect(cb).toHaveBeenCalledTimes(2);
    expect(cb.mock.calls[0]?.[0]).toMatchObject({ id: a.id, status: 'in_progress' });
    expect(cb.mock.calls[1]?.[0]).toMatchObject({ id: a.id, status: 'completed' });
  });

  it('swallows callback errors and still returns the updated record', () => {
    const cb = vi.fn(() => {
      throw new Error('downstream blew up');
    });
    const r = new TaskRegistry({ now: () => Date.parse(ISO), onTaskStatusChange: cb });
    const a = r.create({ projectId: 'p1', description: 'A' });
    expect(() => r.update(a.id, { status: 'in_progress' })).not.toThrow();
    expect(r.get(a.id)?.status).toBe('in_progress');
  });

  it('does not fire when the transition is rejected by the state machine', () => {
    const cb = vi.fn();
    const r = new TaskRegistry({ now: () => Date.parse(ISO), onTaskStatusChange: cb });
    const a = r.create({ projectId: 'p1', description: 'A' });
    r.update(a.id, { status: 'in_progress' });
    r.update(a.id, { status: 'completed' });
    cb.mockReset();
    // completed → pending is invalid; the throw must come BEFORE any fire.
    expect(() => r.update(a.id, { status: 'pending' })).toThrow();
    expect(cb).not.toHaveBeenCalled();
  });
});
