/**
 * Phase 5F — `buildProjectGroups(workers, scopeToProjectPath?)` filter
 * behavior. The pure helper is the right level to test the scope
 * semantics; the hook is a one-line `useMemo` wrapper.
 */
import { describe, expect, it } from 'vitest';

import { buildProjectGroups } from '../../../src/ui/data/useProjectGroups.js';
import type { WorkerRecordSnapshot } from '../../../src/orchestrator/worker-registry.js';

function worker(id: string, projectPath: string, createdAt: string): WorkerRecordSnapshot {
  return {
    id,
    role: 'implementer',
    projectPath,
    projectId: null,
    taskId: null,
    worktreePath: `/tmp/wt/${id}`,
    sessionId: undefined,
    status: 'running',
    autonomyTier: 2,
    featureIntent: 'feat',
    taskDescription: 'task',
    dependsOn: [],
    createdAt,
    auditAttempts: 0,
  } as WorkerRecordSnapshot;
}

describe('buildProjectGroups — Phase 5F scopeToProjectPath', () => {
  const a1 = worker('w1', '/p/A', '2026-05-26T00:00:00.000Z');
  const a2 = worker('w2', '/p/A', '2026-05-26T00:01:00.000Z');
  const b1 = worker('w3', '/p/B', '2026-05-26T00:02:00.000Z');
  const unreg = worker('w4', '', '2026-05-26T00:03:00.000Z');
  const all = [a1, a2, b1, unreg];

  it('undefined scope keeps every group (pre-5F behavior)', () => {
    const groups = buildProjectGroups(all);
    const paths = groups.map((g) => g.projectPath);
    expect(paths).toContain('/p/A');
    expect(paths).toContain('/p/B');
    expect(paths).toContain('(unregistered)');
  });

  it("scope=/p/A drops everything else", () => {
    const groups = buildProjectGroups(all, '/p/A');
    expect(groups.length).toBe(1);
    expect(groups[0]!.projectPath).toBe('/p/A');
    expect(groups[0]!.workers.map((w) => w.id)).toEqual(['w1', 'w2']);
  });

  it('scope=/p/B keeps only the B group', () => {
    const groups = buildProjectGroups(all, '/p/B');
    expect(groups.length).toBe(1);
    expect(groups[0]!.workers.map((w) => w.id)).toEqual(['w3']);
  });

  it('scope=/p/MISSING returns no groups', () => {
    const groups = buildProjectGroups(all, '/p/MISSING');
    expect(groups).toEqual([]);
  });

  it('scope=(unregistered) targets the unregistered bucket', () => {
    const groups = buildProjectGroups(all, '(unregistered)');
    expect(groups.length).toBe(1);
    expect(groups[0]!.projectPath).toBe('(unregistered)');
    expect(groups[0]!.workers.map((w) => w.id)).toEqual(['w4']);
  });

  it('empty workers list with a scope still returns empty', () => {
    expect(buildProjectGroups([], '/p/A')).toEqual([]);
  });
});
