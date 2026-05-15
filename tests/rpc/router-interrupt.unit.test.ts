import { describe, expect, it, vi } from 'vitest';
import { createSymphonyRouter } from '../../src/rpc/router-impl.js';
import { ProjectRegistry } from '../../src/projects/registry.js';
import { TaskRegistry } from '../../src/state/task-registry.js';
import { QuestionRegistry } from '../../src/state/question-registry.js';
import { WaveRegistry } from '../../src/orchestrator/research-wave-registry.js';
import { WorkerRegistry } from '../../src/orchestrator/worker-registry.js';
import { ModeController } from '../../src/orchestrator/mode.js';
import type {
  PendingSpawnSnapshot,
  WorkerLifecycleHandle,
} from '../../src/orchestrator/worker-lifecycle.js';

/**
 * Phase 3T — `runtime.interrupt` RPC. Composes three orthogonal
 * mutations (killAllRunning, cancelAllQueued, cancelAllPending) plus
 * flips an `interruptPending` cursor that the dispatch shim reads.
 */

function makeRouterWithLifecycle(
  killCount = 0,
  queueCount = 0,
): {
  router: ReturnType<typeof createSymphonyRouter>;
  setInterruptCalls: boolean[];
  taskStore: TaskRegistry;
  killCalls: number;
  cancelAllQueuedCalls: number;
} {
  const projectStore = new ProjectRegistry();
  projectStore.register({ id: 'p1', name: 'p1', path: '/tmp/p1', createdAt: '' });
  const taskStore = new TaskRegistry({ projectStore });
  const setInterruptCalls: boolean[] = [];

  // Track call counts on the fake lifecycle.
  let killCalls = 0;
  let cancelAllQueuedCalls = 0;

  const workerLifecycle: Pick<
    WorkerLifecycleHandle,
    | 'listPendingGlobal'
    | 'cancelQueued'
    | 'reorderQueued'
    | 'killAllRunning'
    | 'cancelAllQueued'
  > = {
    listPendingGlobal: () => [],
    cancelQueued: () => ({ cancelled: false, reason: 'not in queue' }),
    reorderQueued: () => ({ moved: false, reason: 'not in queue' }),
    killAllRunning: () => {
      killCalls += 1;
      return { killedIds: Array.from({ length: killCount }, (_, i) => `w-${i}`) };
    },
    cancelAllQueued: () => {
      cancelAllQueuedCalls += 1;
      return { cancelledIds: Array.from({ length: queueCount }, (_, i) => `q-${i}`) };
    },
  };

  const router = createSymphonyRouter({
    projectStore,
    taskStore,
    questionStore: new QuestionRegistry(),
    waveStore: new WaveRegistry(),
    workerRegistry: new WorkerRegistry(),
    modeController: new ModeController({ initial: 'plan' }),
    workerLifecycle,
    setInterruptPending: (value: boolean) => {
      setInterruptCalls.push(value);
    },
  });

  return {
    router,
    setInterruptCalls,
    taskStore,
    get killCalls() {
      return killCalls;
    },
    get cancelAllQueuedCalls() {
      return cancelAllQueuedCalls;
    },
  };
}

describe('runtime.interrupt (3T)', () => {
  it('composes killAllRunning + cancelAllQueued + cancelAllPending + setInterruptPending(true)', async () => {
    const harness = makeRouterWithLifecycle(2, 1);
    harness.taskStore.create({ projectId: 'p1', description: 'pending-A' });
    harness.taskStore.create({ projectId: 'p1', description: 'pending-B' });

    const result = await harness.router.runtime.interrupt();

    expect(result.workersKilled).toEqual(['w-0', 'w-1']);
    expect(result.queuedCancelled).toEqual(['q-0']);
    expect(result.tasksCancelled).toHaveLength(2);
    expect(harness.killCalls).toBe(1);
    expect(harness.cancelAllQueuedCalls).toBe(1);
    expect(harness.setInterruptCalls).toEqual([true]);
  });

  it('is idempotent — a second call returns empty arrays (mutations already settled)', async () => {
    const harness = makeRouterWithLifecycle(0, 0);
    harness.taskStore.create({ projectId: 'p1', description: 'A' });

    const first = await harness.router.runtime.interrupt();
    expect(first.tasksCancelled).toHaveLength(1);

    const second = await harness.router.runtime.interrupt();
    expect(second.workersKilled).toEqual([]);
    expect(second.queuedCancelled).toEqual([]);
    expect(second.tasksCancelled).toEqual([]);
    // Both calls still flip the cursor — caller (TUI) re-uses the same
    // flag for the chat envelope each time. Safe because clear happens
    // at the TUI side after wrapping the next user message.
    expect(harness.setInterruptCalls).toEqual([true, true]);
  });

  it('clearInterruptPending RPC fires setInterruptPending(false)', async () => {
    const harness = makeRouterWithLifecycle(0, 0);
    await harness.router.runtime.interrupt();
    expect(harness.setInterruptCalls).toEqual([true]);

    const result = await harness.router.runtime.clearInterruptPending();
    expect(result.cleared).toBe(true);
    expect(harness.setInterruptCalls).toEqual([true, false]);
  });

  it('clearInterruptPending is idempotent (legacy test rig without setter still resolves)', async () => {
    const projectStore = new ProjectRegistry();
    projectStore.register({ id: 'p1', name: 'p1', path: '/tmp/p1', createdAt: '' });
    const router = createSymphonyRouter({
      projectStore,
      taskStore: new TaskRegistry({ projectStore }),
      questionStore: new QuestionRegistry(),
      waveStore: new WaveRegistry(),
      workerRegistry: new WorkerRegistry(),
      modeController: new ModeController({ initial: 'plan' }),
    });
    const first = await router.runtime.clearInterruptPending();
    const second = await router.runtime.clearInterruptPending();
    expect(first.cleared).toBe(true);
    expect(second.cleared).toBe(true);
  });

  it('works without a workerLifecycle (legacy test rig — task cancellation still fires)', async () => {
    const projectStore = new ProjectRegistry();
    projectStore.register({ id: 'p1', name: 'p1', path: '/tmp/p1', createdAt: '' });
    const taskStore = new TaskRegistry({ projectStore });
    taskStore.create({ projectId: 'p1', description: 'A' });

    const router = createSymphonyRouter({
      projectStore,
      taskStore,
      questionStore: new QuestionRegistry(),
      waveStore: new WaveRegistry(),
      workerRegistry: new WorkerRegistry(),
      modeController: new ModeController({ initial: 'plan' }),
      // workerLifecycle omitted intentionally
    });

    const result = await router.runtime.interrupt();
    expect(result.workersKilled).toEqual([]);
    expect(result.queuedCancelled).toEqual([]);
    expect(result.tasksCancelled).toHaveLength(1);
  });
});
