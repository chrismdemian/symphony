import { describe, expect, it, vi } from 'vitest';
import { TaskRegistry } from '../../src/state/task-registry.js';
import { ProjectRegistry } from '../../src/projects/registry.js';
import { TaskReadyBrokerImpl } from '../../src/orchestrator/task-ready-broker.js';
import { createTaskReadyDispatcher } from '../../src/orchestrator/task-ready-dispatcher.js';
import type { TaskReadyEvent } from '../../src/orchestrator/task-ready-types.js';
import type { TaskSnapshot } from '../../src/state/types.js';

/**
 * Phase 3P — TaskReadyDispatcher.
 *
 * Wired into the store's `onTaskStatusChange` callback. The dispatcher
 * fires `task_ready` events when a task transitions to `completed` AND
 * any dependent task becomes ready as a result. Non-completion
 * transitions and same-status updates are silent.
 *
 * Test pattern mirrors `auto-merge-dispatcher.unit.test.ts`:
 *   - Wire a real TaskRegistry + ProjectRegistry + real broker, capture
 *     events into an array via subscribe.
 *   - Drive transitions through `taskStore.update` so we exercise the
 *     `onTaskStatusChange` seam end-to-end (not the dispatcher's
 *     `onTaskStatusChange` method in isolation).
 */

const ISO = '2026-04-23T00:00:00.000Z';

interface Harness {
  readonly taskStore: TaskRegistry;
  readonly projectStore: ProjectRegistry;
  readonly broker: TaskReadyBrokerImpl;
  readonly events: TaskReadyEvent[];
  readonly dispatcher: ReturnType<typeof createTaskReadyDispatcher>;
  readonly onError: ReturnType<typeof vi.fn>;
}

function setup(): Harness {
  const projectStore = new ProjectRegistry();
  projectStore.register({ id: 'p1', name: 'p1', path: '/tmp/p1', createdAt: ISO });
  projectStore.register({ id: 'p2', name: 'p2', path: '/tmp/p2', createdAt: ISO });
  const broker = new TaskReadyBrokerImpl();
  const events: TaskReadyEvent[] = [];
  broker.subscribe((e) => events.push(e));
  const onError = vi.fn();

  // Holder pattern: the dispatcher needs the store, and the store
  // needs the dispatcher's callback. Mirrors 3O.1 audit M2's circular
  // wiring solution.
  const holder: { current?: ReturnType<typeof createTaskReadyDispatcher> } = {};
  const taskStore = new TaskRegistry({
    now: () => Date.parse(ISO),
    projectStore,
    onTaskStatusChange: (snapshot) => holder.current?.onTaskStatusChange(snapshot),
  });
  const dispatcher = createTaskReadyDispatcher({
    taskStore,
    broker,
    getProjectName: (projectId) => projectStore.get(projectId)?.name ?? '(unknown)',
    now: () => Date.parse(ISO),
    onError,
  });
  holder.current = dispatcher;
  return { taskStore, projectStore, broker, events, dispatcher, onError };
}

describe('TaskReadyDispatcher', () => {
  it('fires task_ready when a dep completes and unblocks one dependent', async () => {
    const h = setup();
    const a = h.taskStore.create({ projectId: 'p1', description: 'A' });
    const b = h.taskStore.create({ projectId: 'p1', description: 'B', dependsOn: [a.id] });
    h.taskStore.update(a.id, { status: 'in_progress' });
    expect(h.events).toHaveLength(0); // in_progress is not "completed"
    h.taskStore.update(a.id, { status: 'completed' });
    expect(h.events).toHaveLength(1);
    const evt = h.events[0]!;
    expect(evt.kind).toBe('task_ready');
    expect(evt.task.id).toBe(b.id);
    expect(evt.unblockedBy.id).toBe(a.id);
    expect(evt.projectName).toBe('p1');
    expect(evt.unblockedByProjectName).toBe('p1');
    expect(evt.headline).toContain('Task ready: B');
    expect(evt.headline).toContain('A completed');
  });

  it('does NOT fire when the unblocking task has no dependents', () => {
    const h = setup();
    const a = h.taskStore.create({ projectId: 'p1', description: 'A' });
    h.taskStore.update(a.id, { status: 'in_progress' });
    h.taskStore.update(a.id, { status: 'completed' });
    expect(h.events).toHaveLength(0);
  });

  it('does NOT fire when a dependent still has OTHER unmet deps', () => {
    const h = setup();
    const a = h.taskStore.create({ projectId: 'p1', description: 'A' });
    const x = h.taskStore.create({ projectId: 'p1', description: 'X' });
    const c = h.taskStore.create({ projectId: 'p1', description: 'C', dependsOn: [a.id, x.id] });
    h.taskStore.update(a.id, { status: 'in_progress' });
    h.taskStore.update(a.id, { status: 'completed' });
    expect(h.events).toHaveLength(0);
    h.taskStore.update(x.id, { status: 'in_progress' });
    h.taskStore.update(x.id, { status: 'completed' });
    expect(h.events).toHaveLength(1);
    expect(h.events[0]!.task.id).toBe(c.id);
  });

  it('fires one event PER newly-ready dependent (fan-out)', () => {
    const h = setup();
    const a = h.taskStore.create({ projectId: 'p1', description: 'A' });
    const b = h.taskStore.create({ projectId: 'p1', description: 'B', dependsOn: [a.id] });
    const c = h.taskStore.create({ projectId: 'p1', description: 'C', dependsOn: [a.id] });
    const d = h.taskStore.create({ projectId: 'p1', description: 'D', dependsOn: [a.id] });
    h.taskStore.update(a.id, { status: 'in_progress' });
    h.taskStore.update(a.id, { status: 'completed' });
    expect(h.events).toHaveLength(3);
    const ids = h.events.map((e) => e.task.id).sort();
    expect(ids).toEqual([b.id, c.id, d.id].sort());
  });

  it('handles cross-project dependents (headline mentions project name)', () => {
    const h = setup();
    const a = h.taskStore.create({ projectId: 'p1', description: 'A' });
    const b = h.taskStore.create({ projectId: 'p2', description: 'B', dependsOn: [a.id] });
    h.taskStore.update(a.id, { status: 'in_progress' });
    h.taskStore.update(a.id, { status: 'completed' });
    expect(h.events).toHaveLength(1);
    const evt = h.events[0]!;
    expect(evt.task.id).toBe(b.id);
    expect(evt.projectName).toBe('p2');
    expect(evt.unblockedByProjectName).toBe('p1');
    // Cross-project headline includes the source project name.
    expect(evt.headline).toContain('A (p1) completed');
  });

  it('only `completed` transitions trigger emits — `failed` and `cancelled` are silent', () => {
    const h = setup();
    const a = h.taskStore.create({ projectId: 'p1', description: 'A' });
    h.taskStore.create({ projectId: 'p1', description: 'B', dependsOn: [a.id] });
    h.taskStore.update(a.id, { status: 'failed' });
    expect(h.events).toHaveLength(0);
    const c = h.taskStore.create({ projectId: 'p1', description: 'C' });
    h.taskStore.create({ projectId: 'p1', description: 'D', dependsOn: [c.id] });
    h.taskStore.update(c.id, { status: 'cancelled' });
    expect(h.events).toHaveLength(0);
  });

  it('post-shutdown emits short-circuit', async () => {
    const h = setup();
    const a = h.taskStore.create({ projectId: 'p1', description: 'A' });
    h.taskStore.create({ projectId: 'p1', description: 'B', dependsOn: [a.id] });
    await h.dispatcher.shutdown();
    h.taskStore.update(a.id, { status: 'in_progress' });
    h.taskStore.update(a.id, { status: 'completed' });
    expect(h.events).toHaveLength(0);
  });

  it('shutdown is idempotent', async () => {
    const h = setup();
    await expect(h.dispatcher.shutdown()).resolves.toBeUndefined();
    await expect(h.dispatcher.shutdown()).resolves.toBeUndefined();
  });

  it('resolves project name as "(unknown)" for unregistered project ids', () => {
    const broker = new TaskReadyBrokerImpl();
    const events: TaskReadyEvent[] = [];
    broker.subscribe((e) => events.push(e));
    const holder: { current?: ReturnType<typeof createTaskReadyDispatcher> } = {};
    const store = new TaskRegistry({
      now: () => Date.parse(ISO),
      onTaskStatusChange: (s) => holder.current?.onTaskStatusChange(s),
    });
    holder.current = createTaskReadyDispatcher({
      taskStore: store,
      broker,
      // Resolver that returns '(unknown)' for unregistered ids.
      getProjectName: () => '(unknown)',
      now: () => Date.parse(ISO),
    });
    const a = store.create({ projectId: 'orphan', description: 'A' });
    store.create({ projectId: 'orphan', description: 'B', dependsOn: [a.id] });
    store.update(a.id, { status: 'in_progress' });
    store.update(a.id, { status: 'completed' });
    expect(events).toHaveLength(1);
    expect(events[0]!.projectName).toBe('(unknown)');
    expect(events[0]!.unblockedByProjectName).toBe('(unknown)');
  });

  it('survives a resolver throw without losing the event', () => {
    const broker = new TaskReadyBrokerImpl();
    const events: TaskReadyEvent[] = [];
    broker.subscribe((e) => events.push(e));
    const holder: { current?: ReturnType<typeof createTaskReadyDispatcher> } = {};
    const store = new TaskRegistry({
      now: () => Date.parse(ISO),
      onTaskStatusChange: (s) => holder.current?.onTaskStatusChange(s),
    });
    holder.current = createTaskReadyDispatcher({
      taskStore: store,
      broker,
      getProjectName: () => {
        throw new Error('resolver blew up');
      },
      now: () => Date.parse(ISO),
    });
    const a = store.create({ projectId: 'p1', description: 'A' });
    store.create({ projectId: 'p1', description: 'B', dependsOn: [a.id] });
    store.update(a.id, { status: 'in_progress' });
    store.update(a.id, { status: 'completed' });
    expect(events).toHaveLength(1);
    expect(events[0]!.projectName).toBe('(unknown)');
  });

  it('directly invoking onTaskStatusChange with a non-completed snapshot is a no-op', () => {
    const h = setup();
    const a = h.taskStore.create({ projectId: 'p1', description: 'A' });
    const inProgressSnapshot: TaskSnapshot = {
      ...h.taskStore.snapshot(a.id)!,
      status: 'in_progress',
    };
    h.dispatcher.onTaskStatusChange(inProgressSnapshot);
    expect(h.events).toHaveLength(0);
  });

  it('a broker throw is captured via onError and does not propagate', () => {
    const onError = vi.fn();
    const broker = new TaskReadyBrokerImpl();
    broker.subscribe(() => {
      // ignore — the throw below is from broker.publish itself.
    });
    // Force broker.publish to throw by monkey-patching.
    (broker as unknown as { publish: () => void }).publish = (): never => {
      throw new Error('broker failure');
    };
    const holder: { current?: ReturnType<typeof createTaskReadyDispatcher> } = {};
    const store = new TaskRegistry({
      now: () => Date.parse(ISO),
      onTaskStatusChange: (s) => holder.current?.onTaskStatusChange(s),
    });
    holder.current = createTaskReadyDispatcher({
      taskStore: store,
      broker,
      getProjectName: () => 'p1',
      now: () => Date.parse(ISO),
      onError,
    });
    const a = store.create({ projectId: 'p1', description: 'A' });
    store.create({ projectId: 'p1', description: 'B', dependsOn: [a.id] });
    expect(() => {
      store.update(a.id, { status: 'in_progress' });
      store.update(a.id, { status: 'completed' });
    }).not.toThrow();
    expect(onError).toHaveBeenCalled();
  });
});
