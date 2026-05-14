import { describe, expect, it } from 'vitest';
import { SymphonyDatabase } from '../../src/state/db.js';
import { SqliteProjectStore } from '../../src/state/sqlite-project-store.js';
import { SqliteTaskStore } from '../../src/state/sqlite-task-store.js';
import { createTaskReadyBroker } from '../../src/orchestrator/task-ready-broker.js';
import { createTaskReadyDispatcher } from '../../src/orchestrator/task-ready-dispatcher.js';
import type { TaskReadyEvent } from '../../src/orchestrator/task-ready-types.js';
import type { TaskReadyDispatcherHandle } from '../../src/orchestrator/task-ready-types.js';

/**
 * Phase 3P — full-stack integration: SQLite-backed task store, real
 * broker + dispatcher, holder pattern for circular wiring. Drives
 * task-status transitions through the store API (not the dispatcher's
 * onTaskStatusChange directly) so the entire chain is exercised:
 *
 *   store.update → onTaskStatusChange callback → dispatcher
 *     → recompute readiness → broker.publish → subscriber sees event
 *
 * Coverage:
 *   - Sequential chain A → B → C (only the just-completed dep emits)
 *   - Fan-out (A → {B, C, D}) emits one event per dependent
 *   - Cross-project deps (P1.A → P2.B) resolved correctly
 *   - Filter via tasks.list({readyOnly: true}) matches the dispatched
 *     readiness signal at every step
 *   - shutdown drains; post-shutdown updates do not fan out
 *
 * No mocking of the store: SqliteTaskStore is the production code path.
 */

const ISO = '2026-05-13T00:00:00.000Z';

interface Harness {
  readonly db: ReturnType<typeof SymphonyDatabase.open>;
  readonly taskStore: SqliteTaskStore;
  readonly projectStore: SqliteProjectStore;
  readonly broker: ReturnType<typeof createTaskReadyBroker>;
  readonly events: TaskReadyEvent[];
  readonly dispatcher: TaskReadyDispatcherHandle;
}

function setup(): Harness {
  const db = SymphonyDatabase.open({ filePath: ':memory:' });
  const projectStore = new SqliteProjectStore(db.db);
  projectStore.register({ id: 'p1', name: 'p1', path: '/tmp/p1', createdAt: ISO });
  projectStore.register({ id: 'p2', name: 'p2', path: '/tmp/p2', createdAt: ISO });
  const broker = createTaskReadyBroker();
  const events: TaskReadyEvent[] = [];
  broker.subscribe((e) => events.push(e));
  // Holder pattern — production code in server.ts uses the same shape.
  const holder: { current?: TaskReadyDispatcherHandle } = {};
  const taskStore = new SqliteTaskStore(db.db, {
    onTaskStatusChange: (s) => holder.current?.onTaskStatusChange(s),
  });
  const dispatcher = createTaskReadyDispatcher({
    taskStore,
    broker,
    getProjectName: (id) => projectStore.get(id)?.name ?? '(unknown)',
  });
  holder.current = dispatcher;
  return { db, taskStore, projectStore, broker, events, dispatcher };
}

describe('Phase 3P — integration: dep chain + dispatcher + broker', () => {
  it('chain A→B→C emits B when A completes, then C when B completes', async () => {
    const h = setup();
    try {
      const a = h.taskStore.create({ projectId: 'p1', description: 'A' });
      const b = h.taskStore.create({ projectId: 'p1', description: 'B', dependsOn: [a.id] });
      const c = h.taskStore.create({ projectId: 'p1', description: 'C', dependsOn: [b.id] });

      // Ready-only filter agrees with the dispatcher: at start, only A is ready.
      expect(h.taskStore.list({ readyOnly: true }).map((t) => t.id)).toEqual([a.id]);

      // Run A through the pipeline.
      h.taskStore.update(a.id, { status: 'in_progress' });
      expect(h.events).toHaveLength(0);
      h.taskStore.update(a.id, { status: 'completed' });
      expect(h.events).toHaveLength(1);
      expect(h.events[0]!.task.id).toBe(b.id);
      expect(h.events[0]!.unblockedBy.id).toBe(a.id);
      // B is now ready; C still blocked.
      expect(h.taskStore.list({ readyOnly: true }).map((t) => t.id)).toEqual([b.id]);

      // Run B.
      h.taskStore.update(b.id, { status: 'in_progress' });
      h.taskStore.update(b.id, { status: 'completed' });
      expect(h.events).toHaveLength(2);
      expect(h.events[1]!.task.id).toBe(c.id);
      expect(h.events[1]!.unblockedBy.id).toBe(b.id);
      // C is now ready.
      expect(h.taskStore.list({ readyOnly: true }).map((t) => t.id)).toEqual([c.id]);
    } finally {
      await h.dispatcher.shutdown();
      h.db.close();
    }
  });

  it('fan-out A → {B, C, D}: one completion emits three task_ready events', async () => {
    const h = setup();
    try {
      const a = h.taskStore.create({ projectId: 'p1', description: 'A' });
      const b = h.taskStore.create({ projectId: 'p1', description: 'B', dependsOn: [a.id] });
      const c = h.taskStore.create({ projectId: 'p1', description: 'C', dependsOn: [a.id] });
      const d = h.taskStore.create({ projectId: 'p1', description: 'D', dependsOn: [a.id] });
      h.taskStore.update(a.id, { status: 'in_progress' });
      h.taskStore.update(a.id, { status: 'completed' });
      expect(h.events).toHaveLength(3);
      const ids = h.events.map((e) => e.task.id).sort();
      expect(ids).toEqual([b.id, c.id, d.id].sort());
      // All three dependents are now ready.
      expect(h.taskStore.list({ readyOnly: true }).map((t) => t.id).sort()).toEqual(
        [b.id, c.id, d.id].sort(),
      );
    } finally {
      await h.dispatcher.shutdown();
      h.db.close();
    }
  });

  it('cross-project P1.A → P2.B: event names both projects', async () => {
    const h = setup();
    try {
      const a = h.taskStore.create({ projectId: 'p1', description: 'API task' });
      const b = h.taskStore.create({
        projectId: 'p2',
        description: 'Frontend task',
        dependsOn: [a.id],
      });
      h.taskStore.update(a.id, { status: 'in_progress' });
      h.taskStore.update(a.id, { status: 'completed' });
      expect(h.events).toHaveLength(1);
      const evt = h.events[0]!;
      expect(evt.task.id).toBe(b.id);
      expect(evt.projectName).toBe('p2');
      expect(evt.unblockedByProjectName).toBe('p1');
      expect(evt.headline).toContain('Frontend task');
      expect(evt.headline).toContain('API task');
      // readyOnly cross-project: B in P2 is ready.
      expect(h.taskStore.list({ projectId: 'p2', readyOnly: true }).map((t) => t.id)).toEqual([
        b.id,
      ]);
    } finally {
      await h.dispatcher.shutdown();
      h.db.close();
    }
  });

  it('fan-in: B blocked on {A, X, Y} fires once when LAST dep completes', async () => {
    const h = setup();
    try {
      const a = h.taskStore.create({ projectId: 'p1', description: 'A' });
      const x = h.taskStore.create({ projectId: 'p1', description: 'X' });
      const y = h.taskStore.create({ projectId: 'p1', description: 'Y' });
      const b = h.taskStore.create({
        projectId: 'p1',
        description: 'B',
        dependsOn: [a.id, x.id, y.id],
      });
      h.taskStore.update(a.id, { status: 'in_progress' });
      h.taskStore.update(a.id, { status: 'completed' });
      expect(h.events).toHaveLength(0); // x + y still pending
      h.taskStore.update(x.id, { status: 'in_progress' });
      h.taskStore.update(x.id, { status: 'completed' });
      expect(h.events).toHaveLength(0); // y still pending
      h.taskStore.update(y.id, { status: 'in_progress' });
      h.taskStore.update(y.id, { status: 'completed' });
      expect(h.events).toHaveLength(1);
      expect(h.events[0]!.task.id).toBe(b.id);
      // Whichever dep was just completed is named as unblockedBy.
      expect(h.events[0]!.unblockedBy.id).toBe(y.id);
    } finally {
      await h.dispatcher.shutdown();
      h.db.close();
    }
  });

  it('post-shutdown: a completion does not produce events', async () => {
    const h = setup();
    try {
      const a = h.taskStore.create({ projectId: 'p1', description: 'A' });
      h.taskStore.create({ projectId: 'p1', description: 'B', dependsOn: [a.id] });
      await h.dispatcher.shutdown();
      h.taskStore.update(a.id, { status: 'in_progress' });
      h.taskStore.update(a.id, { status: 'completed' });
      expect(h.events).toHaveLength(0);
    } finally {
      h.db.close();
    }
  });

  it('failed/cancelled transitions do NOT unblock dependents', async () => {
    const h = setup();
    try {
      const a = h.taskStore.create({ projectId: 'p1', description: 'A' });
      h.taskStore.create({ projectId: 'p1', description: 'B', dependsOn: [a.id] });
      // A → failed. B stays blocked; no event emitted.
      h.taskStore.update(a.id, { status: 'failed' });
      expect(h.events).toHaveLength(0);
      // readyOnly: nothing ready (A is failed, B has unmet dep).
      expect(h.taskStore.list({ readyOnly: true })).toEqual([]);
    } finally {
      await h.dispatcher.shutdown();
      h.db.close();
    }
  });
});
