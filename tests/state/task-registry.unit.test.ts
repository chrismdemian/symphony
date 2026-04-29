import { describe, expect, it } from 'vitest';
import { TaskRegistry } from '../../src/state/task-registry.js';
import { ProjectRegistry } from '../../src/projects/registry.js';
import type { ProjectRecord } from '../../src/projects/types.js';
import {
  InvalidTaskTransitionError,
  UnknownProjectIdError,
  UnknownTaskError,
  canTransition,
  isTerminalStatus,
  type TaskStatus,
} from '../../src/state/types.js';

const ISO = '2026-04-23T00:00:00.000Z';

describe('TaskRegistry — creation', () => {
  it('creates pending tasks with required fields', () => {
    const r = new TaskRegistry({ now: () => Date.parse(ISO), idGenerator: () => 'tk-1' });
    const rec = r.create({ projectId: 'p1', description: 'do the thing' });
    expect(rec).toMatchObject({
      id: 'tk-1',
      projectId: 'p1',
      status: 'pending',
      priority: 0,
      dependsOn: [],
      createdAt: ISO,
      updatedAt: ISO,
    });
  });

  it('trims description and rejects empty', () => {
    const r = new TaskRegistry();
    expect(() => r.create({ projectId: 'p1', description: '  ' })).toThrow(/description/);
  });

  it('rejects missing projectId', () => {
    const r = new TaskRegistry();
    expect(() => r.create({ projectId: '', description: 'x' })).toThrow(/projectId/);
  });

  it('rejects unknown projectId when projectStore is wired (2B.1 m4)', () => {
    const projectStore = new ProjectRegistry();
    const knownProject: ProjectRecord = {
      id: 'p-known',
      name: 'known',
      path: '/tmp/known',
      defaultModel: 'sonnet',
      createdAt: ISO,
    };
    projectStore.register(knownProject);
    const r = new TaskRegistry({ projectStore });
    expect(() => r.create({ projectId: 'p-known', description: 'ok' })).not.toThrow();
    expect(() => r.create({ projectId: 'known', description: 'by name' })).not.toThrow();
    expect(() => r.create({ projectId: 'p-missing', description: 'x' })).toThrow(
      UnknownProjectIdError,
    );
  });

  it('skips projectId validation when no projectStore is wired (back-compat)', () => {
    const r = new TaskRegistry();
    // Without a store, any non-empty projectId is accepted — preserves the
    // 2A unit-test fast path.
    expect(() => r.create({ projectId: 'anything', description: 'x' })).not.toThrow();
  });

  it('preserves dependsOn and priority', () => {
    const r = new TaskRegistry();
    const rec = r.create({
      projectId: 'p1',
      description: 'x',
      priority: 10,
      dependsOn: ['tk-0'],
    });
    expect(rec.priority).toBe(10);
    expect(rec.dependsOn).toEqual(['tk-0']);
  });

  it('rejects non-integer priority (SQLite forward-compat)', () => {
    const r = new TaskRegistry();
    expect(() =>
      r.create({ projectId: 'p', description: 'x', priority: 3.14 }),
    ).toThrow(/must be an integer/);
    expect(() =>
      r.create({ projectId: 'p', description: 'x', priority: Number.NaN }),
    ).toThrow(/must be an integer/);
  });

  it('retries on id collisions', () => {
    // Generator returns 'tk-dup' three times, then fresh ids. First create takes
    // 'tk-dup'. Second create sees 'tk-dup' taken on its first two tries, then
    // receives 'tk-4' on the third.
    let called = 0;
    const r = new TaskRegistry({
      idGenerator: () => {
        called += 1;
        return called <= 3 ? 'tk-dup' : `tk-${called}`;
      },
    });
    const first = r.create({ projectId: 'p', description: 'a' });
    expect(first.id).toBe('tk-dup');
    const second = r.create({ projectId: 'p', description: 'b' });
    expect(second.id).not.toBe('tk-dup');
    expect(called).toBeGreaterThan(3);
  });

  it('gives up after 8 id-gen collisions', () => {
    const r = new TaskRegistry({ idGenerator: () => 'tk-same' });
    r.create({ projectId: 'p', description: 'a' });
    expect(() => r.create({ projectId: 'p', description: 'b' })).toThrow(
      /8 collisions/,
    );
  });
});

describe('TaskRegistry — updates and transitions', () => {
  it('transitions pending -> in_progress -> completed', () => {
    const r = new TaskRegistry();
    const created = r.create({ projectId: 'p', description: 'x' });
    const started = r.update(created.id, { status: 'in_progress' });
    expect(started.status).toBe('in_progress');
    const done = r.update(created.id, { status: 'completed', result: 'ok' });
    expect(done.status).toBe('completed');
    expect(done.completedAt).toBeDefined();
    expect(done.result).toBe('ok');
  });

  it('rejects completed -> anything', () => {
    const r = new TaskRegistry();
    const t = r.create({ projectId: 'p', description: 'x' });
    r.update(t.id, { status: 'in_progress' });
    r.update(t.id, { status: 'completed' });
    expect(() => r.update(t.id, { status: 'failed' })).toThrow(InvalidTaskTransitionError);
    expect(() => r.update(t.id, { status: 'in_progress' })).toThrow(InvalidTaskTransitionError);
  });

  it('allows pending -> cancelled', () => {
    const r = new TaskRegistry();
    const t = r.create({ projectId: 'p', description: 'x' });
    const cancelled = r.update(t.id, { status: 'cancelled' });
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.completedAt).toBeDefined();
  });

  it('appends notes only when non-empty', () => {
    const r = new TaskRegistry();
    const t = r.create({ projectId: 'p', description: 'x' });
    r.update(t.id, { notes: 'progress update' });
    r.update(t.id, { notes: '   ' });
    r.update(t.id, { notes: 'another' });
    const snap = r.snapshot(t.id)!;
    expect(snap.notes.map((n) => n.text)).toEqual(['progress update', 'another']);
  });

  it('self-transitions are allowed (no-op)', () => {
    const r = new TaskRegistry();
    const t = r.create({ projectId: 'p', description: 'x' });
    expect(() => r.update(t.id, { status: 'pending' })).not.toThrow();
  });

  it('throws UnknownTaskError for missing id', () => {
    const r = new TaskRegistry();
    expect(() => r.update('tk-missing', { status: 'cancelled' })).toThrow(UnknownTaskError);
  });

  it('worker_id and result overwrite', () => {
    const r = new TaskRegistry();
    const t = r.create({ projectId: 'p', description: 'x' });
    r.update(t.id, { workerId: 'wk-1' });
    r.update(t.id, { workerId: 'wk-2' });
    expect(r.snapshot(t.id)?.workerId).toBe('wk-2');
  });
});

describe('TaskRegistry — list/filter', () => {
  it('filters by single status and array of statuses', () => {
    const r = new TaskRegistry();
    const a = r.create({ projectId: 'p', description: 'a' });
    const b = r.create({ projectId: 'p', description: 'b' });
    const c = r.create({ projectId: 'p', description: 'c' });
    r.update(b.id, { status: 'in_progress' });
    r.update(c.id, { status: 'cancelled' });
    expect(r.list({ status: 'pending' }).map((t) => t.id)).toEqual([a.id]);
    expect(
      r
        .list({ status: ['in_progress', 'cancelled'] })
        .map((t) => t.id)
        .sort(),
    ).toEqual([b.id, c.id].sort());
  });

  it('filters by projectId', () => {
    const r = new TaskRegistry();
    r.create({ projectId: 'p1', description: 'a' });
    r.create({ projectId: 'p2', description: 'b' });
    expect(r.list({ projectId: 'p2' }).length).toBe(1);
  });

  it('size() reports count', () => {
    const r = new TaskRegistry();
    expect(r.size()).toBe(0);
    r.create({ projectId: 'p', description: 'x' });
    expect(r.size()).toBe(1);
  });
});

describe('Transition table', () => {
  it('canTransition matches exported table', () => {
    const valid: Array<[TaskStatus, TaskStatus]> = [
      ['pending', 'in_progress'],
      ['pending', 'cancelled'],
      ['pending', 'failed'],
      ['in_progress', 'completed'],
      ['in_progress', 'failed'],
      ['in_progress', 'cancelled'],
    ];
    for (const [from, to] of valid) expect(canTransition(from, to)).toBe(true);
    expect(canTransition('completed', 'in_progress')).toBe(false);
    expect(canTransition('failed', 'pending')).toBe(false);
    expect(canTransition('cancelled', 'completed')).toBe(false);
  });

  it('isTerminalStatus matches the terminal set', () => {
    expect(isTerminalStatus('completed')).toBe(true);
    expect(isTerminalStatus('failed')).toBe(true);
    expect(isTerminalStatus('cancelled')).toBe(true);
    expect(isTerminalStatus('pending')).toBe(false);
    expect(isTerminalStatus('in_progress')).toBe(false);
  });
});
