import { describe, expect, it } from 'vitest';
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
 * Phase 3L — `queue.list`/`cancel`/`reorder` RPC procedures. Tests the
 * router's argument validation, the `not_found` path when the lifecycle
 * is missing, and the pass-through to the lifecycle handle.
 */

function makeRouter(workerLifecycle?: Pick<
  WorkerLifecycleHandle,
  | 'listPendingGlobal'
  | 'cancelQueued'
  | 'reorderQueued'
  | 'killAllRunning'
  | 'cancelAllQueued'
>) {
  const projectStore = new ProjectRegistry();
  return createSymphonyRouter({
    projectStore,
    taskStore: new TaskRegistry({ projectStore }),
    questionStore: new QuestionRegistry(),
    waveStore: new WaveRegistry(),
    workerRegistry: new WorkerRegistry(),
    modeController: new ModeController({ initial: 'plan' }),
    ...(workerLifecycle !== undefined ? { workerLifecycle } : {}),
  });
}

function fakeLifecycle(overrides: Partial<{
  list: () => readonly PendingSpawnSnapshot[];
  cancel: (id: string) => { cancelled: boolean; reason?: string };
  reorder: (id: string, dir: 'up' | 'down') => { moved: boolean; reason?: string };
}> = {}): Pick<
  WorkerLifecycleHandle,
  | 'listPendingGlobal'
  | 'cancelQueued'
  | 'reorderQueued'
  | 'killAllRunning'
  | 'cancelAllQueued'
> & { calls: { list: number; cancel: Array<{ id: string }>; reorder: Array<{ id: string; dir: 'up' | 'down' }> } } {
  const calls = {
    list: 0,
    cancel: [] as Array<{ id: string }>,
    reorder: [] as Array<{ id: string; dir: 'up' | 'down' }>,
  };
  return {
    calls,
    listPendingGlobal: () => {
      calls.list += 1;
      return overrides.list?.() ?? [];
    },
    cancelQueued: (recordId: string) => {
      calls.cancel.push({ id: recordId });
      return overrides.cancel?.(recordId) ?? { cancelled: true };
    },
    reorderQueued: (recordId: string, direction: 'up' | 'down') => {
      calls.reorder.push({ id: recordId, dir: direction });
      return overrides.reorder?.(recordId, direction) ?? { moved: true };
    },
    killAllRunning: () => ({ killedIds: [] }),
    cancelAllQueued: () => ({ cancelledIds: [] }),
  };
}

describe('queue.list (3L)', () => {
  it('throws not_found when workerLifecycle is missing', () => {
    const router = makeRouter();
    expect(() => router.queue.list()).toThrow(/queue subsystem not configured/);
  });

  it('returns the lifecycle\'s flat global list verbatim', () => {
    const fixture: readonly PendingSpawnSnapshot[] = [
      {
        recordId: 'a1',
        projectPath: '/projA',
        featureIntent: 'add filters',
        taskDescription: 'add filters',
        enqueuedAt: 1000,
      },
      {
        recordId: 'b1',
        projectPath: '/projB',
        featureIntent: 'fix timeout',
        taskDescription: 'fix timeout',
        enqueuedAt: 1500,
      },
    ];
    const lc = fakeLifecycle({ list: () => fixture });
    const router = makeRouter(lc);
    const result = router.queue.list();
    expect(result).toEqual(fixture);
    expect(lc.calls.list).toBe(1);
  });
});

describe('queue.cancel (3L)', () => {
  it('throws not_found when workerLifecycle is missing', () => {
    const router = makeRouter();
    expect(() => router.queue.cancel({ recordId: 'x' })).toThrow(
      /queue subsystem not configured/,
    );
  });

  it('rejects empty recordId', () => {
    const router = makeRouter(fakeLifecycle());
    expect(() => router.queue.cancel({ recordId: '' })).toThrow(/recordId/);
  });

  it('rejects whitespace-only recordId', () => {
    const router = makeRouter(fakeLifecycle());
    expect(() => router.queue.cancel({ recordId: '   ' })).toThrow(/recordId/);
  });

  it('passes recordId through and returns the lifecycle result', () => {
    const lc = fakeLifecycle({ cancel: () => ({ cancelled: true }) });
    const router = makeRouter(lc);
    const result = router.queue.cancel({ recordId: 'rec-42' });
    expect(result).toEqual({ cancelled: true });
    expect(lc.calls.cancel).toEqual([{ id: 'rec-42' }]);
  });

  it('propagates {cancelled: false, reason: …} from the lifecycle (not-in-queue race)', () => {
    const lc = fakeLifecycle({
      cancel: () => ({ cancelled: false, reason: 'not in queue' }),
    });
    const router = makeRouter(lc);
    const result = router.queue.cancel({ recordId: 'gone' });
    expect(result).toEqual({ cancelled: false, reason: 'not in queue' });
  });
});

describe('queue.reorder (3L)', () => {
  it('throws not_found when workerLifecycle is missing', () => {
    const router = makeRouter();
    expect(() => router.queue.reorder({ recordId: 'x', direction: 'up' })).toThrow(
      /queue subsystem not configured/,
    );
  });

  it('rejects empty recordId', () => {
    const router = makeRouter(fakeLifecycle());
    expect(() => router.queue.reorder({ recordId: '', direction: 'up' })).toThrow(
      /recordId/,
    );
  });

  it('rejects unknown direction', () => {
    const router = makeRouter(fakeLifecycle());
    expect(() =>
      router.queue.reorder({
        recordId: 'r',
        direction: 'sideways' as unknown as 'up' | 'down',
      }),
    ).toThrow(/direction/);
  });

  it('accepts both "up" and "down" and passes through to the lifecycle', () => {
    const lc = fakeLifecycle({ reorder: () => ({ moved: true }) });
    const router = makeRouter(lc);
    router.queue.reorder({ recordId: 'rec-1', direction: 'up' });
    router.queue.reorder({ recordId: 'rec-2', direction: 'down' });
    expect(lc.calls.reorder).toEqual([
      { id: 'rec-1', dir: 'up' },
      { id: 'rec-2', dir: 'down' },
    ]);
  });

  it('propagates {moved: false, reason: "no neighbor"} from the lifecycle', () => {
    const lc = fakeLifecycle({
      reorder: () => ({ moved: false, reason: 'no neighbor' }),
    });
    const router = makeRouter(lc);
    const result = router.queue.reorder({ recordId: 'head', direction: 'up' });
    expect(result).toEqual({ moved: false, reason: 'no neighbor' });
  });
});
