import { describe, expect, it } from 'vitest';
import { createSymphonyRouter } from '../../src/rpc/router-impl.js';
import { ProjectRegistry } from '../../src/projects/registry.js';
import { TaskRegistry } from '../../src/state/task-registry.js';
import { QuestionRegistry } from '../../src/state/question-registry.js';
import { WaveRegistry } from '../../src/orchestrator/research-wave-registry.js';
import {
  CircularBuffer,
  WorkerRegistry,
  type WorkerRecord,
} from '../../src/orchestrator/worker-registry.js';
import { ModeController } from '../../src/orchestrator/mode.js';
import type { StreamEvent, Worker, WorkerExitInfo } from '../../src/workers/types.js';

/**
 * Phase 3N.3 — `stats.byProject` + `stats.byWorker` RPC procedures.
 *
 * Tests the in-memory aggregation logic, the recovery-filter behavior
 * (mirrors session()'s bootIso semantics indirectly via `mergeLiveAndPersisted`),
 * sort orders, and argument validation.
 */

function makeFakeWorker(id: string): Worker {
  return {
    id,
    sessionId: undefined,
    status: 'spawning',
    events: (async function* () {})(),
    sendFollowup() {},
    endInput() {},
    kill() {},
    waitForExit: async (): Promise<WorkerExitInfo> => ({
      status: 'completed',
      exitCode: 0,
      signal: null,
      durationMs: 0,
    }),
  };
}

function makeRecord(overrides: Partial<WorkerRecord>): WorkerRecord {
  return {
    id: overrides.id ?? 'wk',
    projectPath: overrides.projectPath ?? '/p1',
    projectId: overrides.projectId ?? 'p1',
    taskId: overrides.taskId ?? null,
    worktreePath: overrides.worktreePath ?? '/p1/.symphony/worktrees/wk',
    role: overrides.role ?? 'implementer',
    featureIntent: overrides.featureIntent ?? 'do-thing',
    taskDescription: overrides.taskDescription ?? 'do thing',
    autonomyTier: overrides.autonomyTier ?? 1,
    dependsOn: overrides.dependsOn ?? [],
    createdAt: overrides.createdAt ?? '2026-05-11T12:00:00.000Z',
    status: overrides.status ?? 'completed',
    worker: overrides.worker ?? makeFakeWorker(overrides.id ?? 'wk'),
    buffer: overrides.buffer ?? new CircularBuffer<StreamEvent>(10),
    detach: overrides.detach ?? (() => {}),
    ...(overrides.sessionId !== undefined ? { sessionId: overrides.sessionId } : {}),
    ...(overrides.model !== undefined ? { model: overrides.model } : {}),
    ...(overrides.completedAt !== undefined ? { completedAt: overrides.completedAt } : {}),
    ...(overrides.lastEventAt !== undefined ? { lastEventAt: overrides.lastEventAt } : {}),
    ...(overrides.exitInfo !== undefined ? { exitInfo: overrides.exitInfo } : {}),
    ...(overrides.costUsd !== undefined ? { costUsd: overrides.costUsd } : {}),
    ...(overrides.sessionUsage !== undefined ? { sessionUsage: overrides.sessionUsage } : {}),
  };
}

function makeRouter(records: readonly WorkerRecord[], projects: readonly { id: string; name: string; path: string }[] = []) {
  const projectStore = new ProjectRegistry();
  for (const p of projects) {
    projectStore.register({
      id: p.id,
      name: p.name,
      path: p.path,
      createdAt: '2026-05-11T00:00:00.000Z',
    });
  }
  const workerRegistry = new WorkerRegistry();
  for (const r of records) workerRegistry.register(r);
  return createSymphonyRouter({
    projectStore,
    taskStore: new TaskRegistry({ projectStore }),
    questionStore: new QuestionRegistry(),
    waveStore: new WaveRegistry(),
    workerRegistry,
    modeController: new ModeController({ initial: 'plan' }),
  });
}

describe('stats.byProject (3N.3)', () => {
  it('returns empty when no workers have billed', () => {
    const router = makeRouter([]);
    expect(router.stats.byProject()).toEqual([]);
  });

  it('filters out zero-cost-zero-tokens buckets', () => {
    const router = makeRouter(
      [
        makeRecord({
          id: 'wk-empty',
          projectId: 'p1',
          projectPath: '/p1',
        }), // no cost, no usage — should be filtered
      ],
      [{ id: 'p1', name: 'projA', path: '/p1' }],
    );
    expect(router.stats.byProject()).toEqual([]);
  });

  it('aggregates cost + input+output tokens per project', () => {
    const router = makeRouter(
      [
        makeRecord({
          id: 'wk-a',
          projectId: 'p1',
          projectPath: '/p1',
          costUsd: 0.5,
          sessionUsage: {
            inputTokens: 1_000,
            outputTokens: 500,
            cacheReadTokens: 200,
            cacheWriteTokens: 100,
          },
        }),
        makeRecord({
          id: 'wk-b',
          projectId: 'p1',
          projectPath: '/p1',
          costUsd: 0.25,
          sessionUsage: {
            inputTokens: 800,
            outputTokens: 200,
            cacheReadTokens: 100,
            cacheWriteTokens: 50,
          },
        }),
        makeRecord({
          id: 'wk-c',
          projectId: 'p2',
          projectPath: '/p2',
          costUsd: 0.1,
          sessionUsage: {
            inputTokens: 200,
            outputTokens: 50,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          },
        }),
      ],
      [
        { id: 'p1', name: 'projA', path: '/p1' },
        { id: 'p2', name: 'projB', path: '/p2' },
      ],
    );
    const result = router.stats.byProject();
    expect(result.length).toBe(2);
    // Sort by cost desc: p1 (0.75) first, then p2 (0.1).
    expect(result[0]?.projectId).toBe('p1');
    expect(result[0]?.workerCount).toBe(2);
    expect(result[0]?.totalCostUsd).toBeCloseTo(0.75);
    expect(result[0]?.totalTokens).toBe(2_500); // 1000+500 + 800+200
    expect(result[0]?.cacheReadTokens).toBe(300);
    expect(result[0]?.cacheWriteTokens).toBe(150);
    expect(result[1]?.projectId).toBe('p2');
    expect(result[1]?.totalCostUsd).toBeCloseTo(0.1);
  });

  it('buckets unregistered-path workers under projectId=null with sentinel name', () => {
    const router = makeRouter([
      makeRecord({
        id: 'wk-orphan',
        projectId: null,
        projectPath: '/some/random/path',
        costUsd: 0.03,
        sessionUsage: {
          inputTokens: 100,
          outputTokens: 50,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      }),
    ]);
    const result = router.stats.byProject();
    expect(result.length).toBe(1);
    expect(result[0]?.projectId).toBeNull();
    expect(result[0]?.projectName).toBe('(unregistered)');
    expect(result[0]?.totalCostUsd).toBeCloseTo(0.03);
  });
});

describe('stats.byWorker (3N.3)', () => {
  it('returns empty array when no workers exist', () => {
    const router = makeRouter([]);
    expect(router.stats.byWorker()).toEqual([]);
  });

  it('returns recent workers sorted by createdAt DESC', () => {
    const router = makeRouter(
      [
        makeRecord({
          id: 'wk-old',
          projectId: 'p1',
          projectPath: '/p1',
          createdAt: '2026-05-11T10:00:00.000Z',
          costUsd: 0.1,
        }),
        makeRecord({
          id: 'wk-mid',
          projectId: 'p1',
          projectPath: '/p1',
          createdAt: '2026-05-11T11:00:00.000Z',
          costUsd: 0.2,
        }),
        makeRecord({
          id: 'wk-new',
          projectId: 'p1',
          projectPath: '/p1',
          createdAt: '2026-05-11T12:00:00.000Z',
          costUsd: 0.3,
        }),
      ],
      [{ id: 'p1', name: 'projA', path: '/p1' }],
    );
    const result = router.stats.byWorker();
    expect(result.map((r) => r.workerId)).toEqual(['wk-new', 'wk-mid', 'wk-old']);
  });

  it('honors limit argument', () => {
    const records = Array.from({ length: 10 }, (_, i) =>
      makeRecord({
        id: `wk-${i}`,
        projectId: 'p1',
        projectPath: '/p1',
        createdAt: `2026-05-11T1${i}:00:00.000Z`,
        costUsd: 0.01 * (i + 1),
      }),
    );
    const router = makeRouter(records, [{ id: 'p1', name: 'projA', path: '/p1' }]);
    expect(router.stats.byWorker({ limit: 3 }).length).toBe(3);
    expect(router.stats.byWorker({ limit: 100 }).length).toBe(10);
  });

  it('rejects limit < 1 or > 200', () => {
    const router = makeRouter([]);
    expect(() => router.stats.byWorker({ limit: 0 })).toThrow(/limit must be an integer/);
    expect(() => router.stats.byWorker({ limit: 201 })).toThrow(/limit must be an integer/);
    expect(() => router.stats.byWorker({ limit: 1.5 })).toThrow(/limit must be an integer/);
  });

  it('filters by projectId', () => {
    const router = makeRouter(
      [
        makeRecord({
          id: 'wk-a',
          projectId: 'p1',
          projectPath: '/p1',
          costUsd: 0.1,
        }),
        makeRecord({
          id: 'wk-b',
          projectId: 'p2',
          projectPath: '/p2',
          costUsd: 0.2,
        }),
      ],
      [
        { id: 'p1', name: 'projA', path: '/p1' },
        { id: 'p2', name: 'projB', path: '/p2' },
      ],
    );
    const filtered = router.stats.byWorker({ projectId: 'p1' });
    expect(filtered.length).toBe(1);
    expect(filtered[0]?.workerId).toBe('wk-a');
  });

  it('exposes the four token columns + costUsd per row', () => {
    const router = makeRouter(
      [
        makeRecord({
          id: 'wk',
          projectId: 'p1',
          projectPath: '/p1',
          costUsd: 0.42,
          sessionUsage: {
            inputTokens: 100,
            outputTokens: 200,
            cacheReadTokens: 300,
            cacheWriteTokens: 400,
          },
        }),
      ],
      [{ id: 'p1', name: 'projA', path: '/p1' }],
    );
    const result = router.stats.byWorker();
    expect(result[0]).toMatchObject({
      workerId: 'wk',
      projectId: 'p1',
      projectName: 'projA',
      costUsd: 0.42,
      inputTokens: 100,
      outputTokens: 200,
      cacheReadTokens: 300,
      cacheWriteTokens: 400,
    });
  });

  it('emits nulls for cost + token columns when worker never billed', () => {
    const router = makeRouter(
      [
        makeRecord({
          id: 'wk-pending',
          projectId: 'p1',
          projectPath: '/p1',
          status: 'spawning',
        }),
      ],
      [{ id: 'p1', name: 'projA', path: '/p1' }],
    );
    const result = router.stats.byWorker();
    expect(result[0]).toMatchObject({
      workerId: 'wk-pending',
      costUsd: null,
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
    });
  });
});
