import { describe, expect, it } from 'vitest';
import { createSymphonyRouter } from '../../src/rpc/router-impl.js';
import { ProjectRegistry } from '../../src/projects/registry.js';
import { TaskRegistry } from '../../src/state/task-registry.js';
import { QuestionRegistry } from '../../src/state/question-registry.js';
import { WaveRegistry } from '../../src/orchestrator/research-wave-registry.js';
import { WorkerRegistry } from '../../src/orchestrator/worker-registry.js';
import { ModeController } from '../../src/orchestrator/mode.js';

/**
 * Phase 3P — `tasks.graph()` returns the dep-graph snapshot used by
 * `/deps`. The router method delegates to the pure `extractGraphEdges`
 * helper; these tests verify the wiring + filter (graph-only nodes).
 */

const ISO = '2026-05-13T00:00:00.000Z';

function makeRouter(taskStore: TaskRegistry, projectStore: ProjectRegistry) {
  return createSymphonyRouter({
    projectStore,
    taskStore,
    questionStore: new QuestionRegistry(),
    waveStore: new WaveRegistry(),
    workerRegistry: new WorkerRegistry(),
    modeController: new ModeController({ initial: 'plan' }),
  });
}

describe('tasks.graph (3P)', () => {
  it('returns an empty graph when no tasks exist', () => {
    const projectStore = new ProjectRegistry();
    const taskStore = new TaskRegistry({ projectStore });
    const router = makeRouter(taskStore, projectStore);
    const out = router.tasks.graph();
    expect(out.nodes).toEqual([]);
    expect(out.edges).toEqual([]);
    expect(out.cycles).toEqual([]);
  });

  it('returns an empty graph when no task has deps (no edges, no nodes)', () => {
    const projectStore = new ProjectRegistry();
    projectStore.register({ id: 'p1', name: 'p1', path: '/tmp/p1', createdAt: ISO });
    const taskStore = new TaskRegistry({ projectStore });
    taskStore.create({ projectId: 'p1', description: 'A' });
    taskStore.create({ projectId: 'p1', description: 'B' });
    const router = makeRouter(taskStore, projectStore);
    const out = router.tasks.graph();
    expect(out.nodes).toEqual([]);
    expect(out.edges).toEqual([]);
  });

  it('returns only tasks with at least one edge', () => {
    const projectStore = new ProjectRegistry();
    projectStore.register({ id: 'p1', name: 'p1', path: '/tmp/p1', createdAt: ISO });
    const taskStore = new TaskRegistry({ projectStore });
    const a = taskStore.create({ projectId: 'p1', description: 'A' });
    const b = taskStore.create({ projectId: 'p1', description: 'B', dependsOn: [a.id] });
    taskStore.create({ projectId: 'p1', description: 'C-solo' });
    const router = makeRouter(taskStore, projectStore);
    const out = router.tasks.graph();
    expect(out.nodes.map((n) => n.id).sort()).toEqual([a.id, b.id].sort());
    expect(out.edges).toEqual([{ from: b.id, to: a.id }]);
  });

  it('returns cross-project edges with both projects in nodes', () => {
    const projectStore = new ProjectRegistry();
    projectStore.register({ id: 'p1', name: 'p1', path: '/tmp/p1', createdAt: ISO });
    projectStore.register({ id: 'p2', name: 'p2', path: '/tmp/p2', createdAt: ISO });
    const taskStore = new TaskRegistry({ projectStore });
    const a = taskStore.create({ projectId: 'p1', description: 'API' });
    const b = taskStore.create({ projectId: 'p2', description: 'Frontend', dependsOn: [a.id] });
    const router = makeRouter(taskStore, projectStore);
    const out = router.tasks.graph();
    expect(out.nodes.map((n) => n.id).sort()).toEqual([a.id, b.id].sort());
    expect(out.edges).toEqual([{ from: b.id, to: a.id }]);
  });

  it('passes detectCycles output through (defensive — usually empty)', () => {
    const projectStore = new ProjectRegistry();
    projectStore.register({ id: 'p1', name: 'p1', path: '/tmp/p1', createdAt: ISO });
    const taskStore = new TaskRegistry({ projectStore });
    taskStore.create({ projectId: 'p1', description: 'A' });
    const router = makeRouter(taskStore, projectStore);
    const out = router.tasks.graph();
    expect(out.cycles).toEqual([]);
  });
});

describe('tasks.list readyOnly (3P) — router passthrough', () => {
  it('passes readyOnly through to the store filter', () => {
    const projectStore = new ProjectRegistry();
    projectStore.register({ id: 'p1', name: 'p1', path: '/tmp/p1', createdAt: ISO });
    const taskStore = new TaskRegistry({ projectStore });
    const a = taskStore.create({ projectId: 'p1', description: 'A' });
    taskStore.create({ projectId: 'p1', description: 'B', dependsOn: [a.id] });
    const router = makeRouter(taskStore, projectStore);
    const all = router.tasks.list();
    expect(all).toHaveLength(2);
    const readyOnly = router.tasks.list({ readyOnly: true });
    expect(readyOnly.map((t) => t.id)).toEqual([a.id]);
  });
});
