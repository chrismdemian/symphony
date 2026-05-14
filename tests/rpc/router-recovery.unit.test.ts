import { describe, expect, it } from 'vitest';
import { createSymphonyRouter } from '../../src/rpc/router-impl.js';
import { ProjectRegistry } from '../../src/projects/registry.js';
import { TaskRegistry } from '../../src/state/task-registry.js';
import { QuestionRegistry } from '../../src/state/question-registry.js';
import { WaveRegistry } from '../../src/orchestrator/research-wave-registry.js';
import { WorkerRegistry } from '../../src/orchestrator/worker-registry.js';
import { ModeController } from '../../src/orchestrator/mode.js';

/**
 * Phase 3Q — `recovery.report` returns the boot-time snapshot of
 * crash-recovered workers (the IDs `WorkerLifecycle.recoverFromStore`
 * flipped from `running`/`spawning` to `crashed`). The launcher reads
 * this immediately after RPC connect to decide whether to surface a
 * banner row in the TUI chat history.
 */

function makeBaseDeps() {
  const projectStore = new ProjectRegistry();
  const taskStore = new TaskRegistry({ projectStore });
  return {
    projectStore,
    taskStore,
    questionStore: new QuestionRegistry(),
    waveStore: new WaveRegistry(),
    workerRegistry: new WorkerRegistry(),
    modeController: new ModeController({ initial: 'plan' }),
  };
}

describe('recovery.report (3Q)', () => {
  it('returns the captured snapshot verbatim', () => {
    const router = createSymphonyRouter({
      ...makeBaseDeps(),
      recoveryReport: {
        crashedIds: ['w-1', 'w-2', 'w-3'],
        capturedAt: '2026-05-14T12:34:56.789Z',
      },
    });
    expect(router.recovery.report()).toEqual({
      crashedIds: ['w-1', 'w-2', 'w-3'],
      capturedAt: '2026-05-14T12:34:56.789Z',
    });
  });

  it('returns the same snapshot on repeat calls (idempotent)', () => {
    const router = createSymphonyRouter({
      ...makeBaseDeps(),
      recoveryReport: {
        crashedIds: ['w-1'],
        capturedAt: '2026-05-14T00:00:00.000Z',
      },
    });
    const a = router.recovery.report();
    const b = router.recovery.report();
    const c = router.recovery.report();
    expect(b).toEqual(a);
    expect(c).toEqual(a);
  });

  it('falls back to an empty list when no recoveryReport is wired (legacy test rigs)', () => {
    const router = createSymphonyRouter(makeBaseDeps());
    const out = router.recovery.report();
    expect(out.crashedIds).toEqual([]);
    // capturedAt is a synthetic epoch ISO so the wire shape stays stable.
    expect(out.capturedAt).toBe('1970-01-01T00:00:00.000Z');
  });

  it('preserves empty list when recoveryReport.crashedIds is empty (no recoveries)', () => {
    const router = createSymphonyRouter({
      ...makeBaseDeps(),
      recoveryReport: {
        crashedIds: [],
        capturedAt: '2026-05-14T08:00:00.000Z',
      },
    });
    expect(router.recovery.report()).toEqual({
      crashedIds: [],
      capturedAt: '2026-05-14T08:00:00.000Z',
    });
  });
});
