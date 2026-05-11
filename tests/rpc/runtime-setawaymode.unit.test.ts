import { describe, it, expect, vi } from 'vitest';
import { createSymphonyRouter } from '../../src/rpc/router-impl.js';
import { ProjectRegistry } from '../../src/projects/registry.js';
import { TaskRegistry } from '../../src/state/task-registry.js';
import { QuestionRegistry } from '../../src/state/question-registry.js';
import { WaveRegistry } from '../../src/orchestrator/research-wave-registry.js';
import { WorkerRegistry } from '../../src/orchestrator/worker-registry.js';
import { ModeController } from '../../src/orchestrator/mode.js';

/**
 * Phase 3M — RPC `runtime.setAwayMode` bridges the TUI's `awayMode`
 * config flips into the orchestrator's live dispatch context. The
 * capability shim (`capabilities.ts`) reads `ctx.awayMode` per tool
 * call; without this seam the field would stay at the boot-time value.
 */

interface RouterFixture {
  router: ReturnType<typeof createSymphonyRouter>;
  setter: ReturnType<typeof vi.fn>;
}

function makeRouter(opts: { withSetter?: boolean } = {}): RouterFixture {
  const projectStore = new ProjectRegistry();
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
    ...(withSetter ? { setDispatchAwayMode: setter } : {}),
  });
  return { router, setter };
}

describe('rpc runtime.setAwayMode (3M)', () => {
  it('forwards true to the dispatch-context setter and echoes the value', async () => {
    const { router, setter } = makeRouter();
    const result = await router.runtime.setAwayMode({ awayMode: true });
    expect(result).toEqual({ awayMode: true });
    expect(setter).toHaveBeenCalledTimes(1);
    expect(setter).toHaveBeenCalledWith(true);
  });

  it('forwards false to the dispatch-context setter', async () => {
    const { router, setter } = makeRouter();
    await router.runtime.setAwayMode({ awayMode: true });
    await router.runtime.setAwayMode({ awayMode: false });
    expect(setter).toHaveBeenNthCalledWith(2, false);
  });

  it('no-ops when setDispatchAwayMode is absent (legacy rigs)', async () => {
    const { router } = makeRouter({ withSetter: false });
    const result = await router.runtime.setAwayMode({ awayMode: true });
    expect(result).toEqual({ awayMode: true });
  });

  it('rejects non-boolean args (audit-style boundary validation)', async () => {
    const { router } = makeRouter();
    for (const bad of [undefined, null, 0, 1, 'true', 'false', [], {}]) {
      await expect(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        router.runtime.setAwayMode({ awayMode: bad as any }),
      ).rejects.toThrow(/awayMode/);
    }
  });

  it('rejects missing args object entirely', async () => {
    const { router } = makeRouter();
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      router.runtime.setAwayMode(undefined as any),
    ).rejects.toThrow(/awayMode/);
  });
});
