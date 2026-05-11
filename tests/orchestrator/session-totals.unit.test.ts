import { describe, expect, it } from 'vitest';
import {
  computeSessionTotals,
  formatCostUsd,
  formatTokenCount,
  EMPTY_SESSION_TOTALS,
} from '../../src/orchestrator/session-totals.js';
import type { WorkerRecordSnapshot } from '../../src/orchestrator/worker-registry.js';

function makeSnap(overrides: Partial<WorkerRecordSnapshot> = {}): WorkerRecordSnapshot {
  return {
    id: overrides.id ?? 'wk',
    projectPath: overrides.projectPath ?? '/p',
    worktreePath: overrides.worktreePath ?? '/p/.symphony/worktrees/wk',
    role: overrides.role ?? 'implementer',
    featureIntent: overrides.featureIntent ?? 'do-thing',
    taskDescription: overrides.taskDescription ?? 'task',
    autonomyTier: overrides.autonomyTier ?? 1,
    dependsOn: overrides.dependsOn ?? [],
    status: overrides.status ?? 'running',
    createdAt: overrides.createdAt ?? '2026-05-11T10:00:00.000Z',
    ...(overrides.model !== undefined ? { model: overrides.model } : {}),
    ...(overrides.sessionId !== undefined ? { sessionId: overrides.sessionId } : {}),
    ...(overrides.completedAt !== undefined ? { completedAt: overrides.completedAt } : {}),
    ...(overrides.lastEventAt !== undefined ? { lastEventAt: overrides.lastEventAt } : {}),
    ...(overrides.costUsd !== undefined ? { costUsd: overrides.costUsd } : {}),
    ...(overrides.sessionUsage !== undefined ? { sessionUsage: overrides.sessionUsage } : {}),
    ...(overrides.exitCode !== undefined ? { exitCode: overrides.exitCode } : {}),
    ...(overrides.exitSignal !== undefined ? { exitSignal: overrides.exitSignal } : {}),
  };
}

describe('computeSessionTotals', () => {
  it('returns empty totals on empty input', () => {
    expect(computeSessionTotals([])).toEqual(EMPTY_SESSION_TOTALS);
  });

  it('sums input+output tokens for the headline number; cache cols tracked separately', () => {
    const result = computeSessionTotals([
      makeSnap({
        id: 'a',
        costUsd: 0.1,
        sessionUsage: {
          inputTokens: 1000,
          outputTokens: 200,
          cacheReadTokens: 500,
          cacheWriteTokens: 50,
        },
      }),
      makeSnap({
        id: 'b',
        costUsd: 0.05,
        sessionUsage: {
          inputTokens: 300,
          outputTokens: 100,
          cacheReadTokens: 0,
          cacheWriteTokens: 25,
        },
      }),
    ]);
    expect(result.totalTokens).toBe(1_600); // 1000+200 + 300+100
    expect(result.totalCostUsd).toBeCloseTo(0.15);
    expect(result.workerCount).toBe(2);
    expect(result.cacheReadTokens).toBe(500);
    expect(result.cacheWriteTokens).toBe(75);
  });

  it('counts workers even when they have no usage or cost yet', () => {
    const result = computeSessionTotals([
      makeSnap({ id: 'spawning-1', status: 'spawning' }),
      makeSnap({ id: 'spawning-2', status: 'running' }),
    ]);
    expect(result.workerCount).toBe(2);
    expect(result.totalTokens).toBe(0);
    expect(result.totalCostUsd).toBe(0);
  });

  it('filters out workers whose createdAt predates bootIso (recovery exclusion)', () => {
    const bootIso = '2026-05-11T12:00:00.000Z';
    const result = computeSessionTotals(
      [
        // Survivor from a prior boot — recovery rehydrated it as 'crashed'.
        makeSnap({
          id: 'recovered',
          createdAt: '2026-05-10T08:00:00.000Z',
          status: 'crashed',
          costUsd: 999.99, // would inflate the total if not excluded
          sessionUsage: {
            inputTokens: 1_000_000,
            outputTokens: 1_000_000,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          },
        }),
        // This-session worker.
        makeSnap({
          id: 'fresh',
          createdAt: '2026-05-11T12:30:00.000Z',
          costUsd: 0.07,
          sessionUsage: {
            inputTokens: 5_000,
            outputTokens: 1_000,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          },
        }),
      ],
      bootIso,
    );
    expect(result.workerCount).toBe(1);
    expect(result.totalTokens).toBe(6_000);
    expect(result.totalCostUsd).toBeCloseTo(0.07);
  });

  it('counts every snapshot when bootIso is omitted (test-mode behavior)', () => {
    const result = computeSessionTotals([
      makeSnap({ id: 'a', createdAt: '2025-01-01T00:00:00.000Z' }),
      makeSnap({ id: 'b', createdAt: '2026-05-11T00:00:00.000Z' }),
    ]);
    expect(result.workerCount).toBe(2);
  });

  it('treats createdAt exactly equal to bootIso as in-session', () => {
    const bootIso = '2026-05-11T12:00:00.000Z';
    const result = computeSessionTotals(
      [makeSnap({ id: 'edge', createdAt: bootIso })],
      bootIso,
    );
    expect(result.workerCount).toBe(1);
  });

  it('ignores non-finite costUsd (defensive — should never occur but cheap insurance)', () => {
    const result = computeSessionTotals([
      makeSnap({ id: 'good', costUsd: 0.5 }),
      // Cast through unknown — production code can't write Infinity but
      // a corrupted persisted row could (REAL → infinite is technically
      // representable in SQLite via JSON1 round-trips).
      makeSnap({ id: 'bad', costUsd: Number.POSITIVE_INFINITY as unknown as number }),
    ]);
    expect(result.totalCostUsd).toBeCloseTo(0.5);
  });
});

describe('formatTokenCount', () => {
  it('renders raw count below 1K', () => {
    expect(formatTokenCount(0)).toBe('0');
    expect(formatTokenCount(42)).toBe('42');
    expect(formatTokenCount(999)).toBe('999');
  });

  it('renders one-decimal K between 1K and 10K', () => {
    expect(formatTokenCount(1_000)).toBe('1.0K');
    expect(formatTokenCount(1_200)).toBe('1.2K');
    // Audit M2 (3N.2): values just below 10K must NOT round up across
    // the decade boundary. `9_999` reads as `9.9K`, NOT `10.0K`.
    expect(formatTokenCount(9_999)).toBe('9.9K');
    expect(formatTokenCount(9_949)).toBe('9.9K');
  });

  it('renders no-decimal K between 10K and 1M', () => {
    expect(formatTokenCount(10_000)).toBe('10K');
    expect(formatTokenCount(45_678)).toBe('45K');
    expect(formatTokenCount(999_000)).toBe('999K');
  });

  it('renders one-decimal M between 1M and 10M', () => {
    expect(formatTokenCount(1_000_000)).toBe('1.0M');
    expect(formatTokenCount(1_400_000)).toBe('1.4M');
  });

  it('renders no-decimal M at or above 10M', () => {
    expect(formatTokenCount(10_000_000)).toBe('10M');
    expect(formatTokenCount(125_000_000)).toBe('125M');
  });

  it('returns "0" for negative / non-finite input', () => {
    expect(formatTokenCount(-1)).toBe('0');
    expect(formatTokenCount(Number.NaN)).toBe('0');
    expect(formatTokenCount(Number.POSITIVE_INFINITY)).toBe('0');
  });
});

describe('formatCostUsd', () => {
  it('renders <$0.01 with 4-decimal precision (exact 0 special-cased)', () => {
    // Exact 0 → `$0.00` via the dedicated branch (NOT `$0.0000`).
    expect(formatCostUsd(0)).toBe('$0.00');
    expect(formatCostUsd(0.0042)).toBe('$0.0042');
    expect(formatCostUsd(0.0001)).toBe('$0.0001');
  });

  it('rounds away the sub-cent threshold weirdness (audit M3 fix)', () => {
    // 0.009999 used to render as `$0.0100` because toFixed(4) rounds.
    // After M3, the threshold check sees the 4-decimal-rounded value
    // (0.0100) which is ≥ 0.01 → 2-decimal branch → `$0.01`. Clean.
    expect(formatCostUsd(0.009999)).toBe('$0.01');
    // Just below the threshold WITHOUT rounding past it stays in the
    // 4-decimal branch.
    expect(formatCostUsd(0.0094)).toBe('$0.0094');
  });

  it('renders ≥$0.01 with 2-decimal precision', () => {
    expect(formatCostUsd(0.01)).toBe('$0.01');
    expect(formatCostUsd(0.42)).toBe('$0.42');
    expect(formatCostUsd(12.34)).toBe('$12.34');
    expect(formatCostUsd(1_234.567)).toBe('$1234.57');
  });

  it('returns "$0.00" for negative / non-finite input', () => {
    expect(formatCostUsd(-0.01)).toBe('$0.00');
    expect(formatCostUsd(Number.NaN)).toBe('$0.00');
  });
});
