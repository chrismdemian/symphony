import { describe, it, expect, vi } from 'vitest';
import { createSymphonyRouter } from '../../src/rpc/router-impl.js';
import { ProjectRegistry } from '../../src/projects/registry.js';
import { TaskRegistry } from '../../src/state/task-registry.js';
import { QuestionRegistry } from '../../src/state/question-registry.js';
import { WaveRegistry } from '../../src/orchestrator/research-wave-registry.js';
import { WorkerRegistry } from '../../src/orchestrator/worker-registry.js';
import { ModeController } from '../../src/orchestrator/mode.js';

/**
 * Phase 5D — RPC `runtime.setActiveProject` validates the project NAME
 * against the live project store BEFORE forwarding to the dispatch
 * cursor setter. Mirrors 3M's `runtime.setAwayMode` test shape.
 */

interface RouterFixture {
  router: ReturnType<typeof createSymphonyRouter>;
  setter: ReturnType<typeof vi.fn>;
  projectStore: ProjectRegistry;
}

function makeRouter(opts: { withSetter?: boolean } = {}): RouterFixture {
  const projectStore = new ProjectRegistry();
  projectStore.register({ id: 'p1', name: 'demo', path: '/tmp/demo', createdAt: '' });
  projectStore.register({ id: 'p2', name: 'second', path: '/tmp/second', createdAt: '' });
  const taskStore = new TaskRegistry({ projectStore });
  const questionStore = new QuestionRegistry();
  const waveStore = new WaveRegistry();
  const workerRegistry = new WorkerRegistry();
  const modeController = new ModeController({ initial: 'plan' });
  const setter = vi.fn();
  const withSetter = opts.withSetter !== false;
  const router = createSymphonyRouter({
    projectStore,
    taskStore,
    questionStore,
    waveStore,
    workerRegistry,
    modeController,
    ...(withSetter ? { setDispatchActiveProject: setter } : {}),
  });
  return { router, setter, projectStore };
}

describe('rpc runtime.setActiveProject (5D)', () => {
  it('forwards a valid name (resolved via store) to the setter + echoes it', async () => {
    const { router, setter } = makeRouter();
    const result = await router.runtime.setActiveProject({ project: 'demo' });
    expect(result).toEqual({ project: 'demo' });
    expect(setter).toHaveBeenCalledTimes(1);
    expect(setter).toHaveBeenCalledWith('demo');
  });

  it('resolves project lookup by id, echoes the canonical name', async () => {
    const { router, setter } = makeRouter();
    const result = await router.runtime.setActiveProject({ project: 'p2' });
    // ID input resolves to the canonical NAME on the wire.
    expect(result).toEqual({ project: 'second' });
    expect(setter).toHaveBeenCalledWith('second');
  });

  it('forwards null to the setter (clears the cursor)', async () => {
    const { router, setter } = makeRouter();
    const result = await router.runtime.setActiveProject({ project: null });
    expect(result).toEqual({ project: null });
    expect(setter).toHaveBeenCalledWith(null);
  });

  it('rejects unknown project names BEFORE touching the setter', async () => {
    const { router, setter } = makeRouter();
    await expect(
      router.runtime.setActiveProject({ project: 'ghost' }),
    ).rejects.toThrow(/unknown project 'ghost'/);
    expect(setter).not.toHaveBeenCalled();
  });

  it('rejects non-string non-null args (boundary validation)', async () => {
    const { router } = makeRouter();
    for (const bad of [undefined, 0, 1, true, '', [], {}]) {
      await expect(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        router.runtime.setActiveProject({ project: bad as any }),
      ).rejects.toThrow(/project/);
    }
  });

  it('no-ops when setDispatchActiveProject is absent (legacy rigs)', async () => {
    const { router } = makeRouter({ withSetter: false });
    const result = await router.runtime.setActiveProject({ project: 'demo' });
    expect(result).toEqual({ project: 'demo' });
  });

  it('rejects missing args object entirely', async () => {
    const { router } = makeRouter();
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      router.runtime.setActiveProject(undefined as any),
    ).rejects.toThrow(/project/);
  });
});
