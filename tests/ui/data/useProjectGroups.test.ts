import { describe, expect, it } from 'vitest';
import type { WorkerRecordSnapshot } from '../../../src/orchestrator/worker-registry.js';
import { buildProjectGroups } from '../../../src/ui/data/useProjectGroups.js';

function snap(over: Partial<WorkerRecordSnapshot>): WorkerRecordSnapshot {
  return {
    id: 'w',
    projectPath: 'C:/projects/alpha',
    worktreePath: 'C:/projects/alpha/.symphony/worktrees/w',
    role: 'implementer',
    featureIntent: 'do a thing',
    taskDescription: 'do a thing',
    autonomyTier: 1,
    dependsOn: [],
    status: 'running',
    createdAt: '2026-05-03T12:00:00.000Z',
    ...over,
  };
}

describe('buildProjectGroups', () => {
  it('groups by projectPath', () => {
    const a = snap({ id: 'a', projectPath: 'C:/projects/alpha' });
    const b = snap({ id: 'b', projectPath: 'C:/projects/alpha' });
    const c = snap({ id: 'c', projectPath: 'C:/projects/beta' });
    const groups = buildProjectGroups([a, b, c]);
    expect(groups).toHaveLength(2);
    const alpha = groups.find((g) => g.projectPath === 'C:/projects/alpha');
    const beta = groups.find((g) => g.projectPath === 'C:/projects/beta');
    expect(alpha?.workers.map((w) => w.id)).toEqual(['a', 'b']);
    expect(beta?.workers.map((w) => w.id)).toEqual(['c']);
  });

  it('alphabetizes groups by display name', () => {
    const z = snap({ id: 'z', projectPath: 'C:/zeta' });
    const a = snap({ id: 'a', projectPath: 'C:/alpha' });
    const m = snap({ id: 'm', projectPath: 'C:/middle' });
    const groups = buildProjectGroups([z, a, m]);
    expect(groups.map((g) => g.displayName)).toEqual(['alpha', 'middle', 'zeta']);
  });

  it('places (unregistered) at the end', () => {
    const a = snap({ id: 'a', projectPath: '' });
    const b = snap({ id: 'b', projectPath: 'C:/alpha' });
    const groups = buildProjectGroups([a, b]);
    expect(groups.map((g) => g.displayName)).toEqual(['alpha', '(unregistered)']);
  });

  it('sorts workers within a group by createdAt asc', () => {
    const newer = snap({ id: 'newer', createdAt: '2026-05-03T13:00:00.000Z' });
    const older = snap({ id: 'older', createdAt: '2026-05-03T12:00:00.000Z' });
    const groups = buildProjectGroups([newer, older]);
    expect(groups[0]?.workers.map((w) => w.id)).toEqual(['older', 'newer']);
  });

  it('derives display name from last path segment, handling backslashes', () => {
    const a = snap({ id: 'a', projectPath: 'C:\\Users\\chris\\projects\\foo' });
    const b = snap({ id: 'b', projectPath: 'C:/Users/chris/projects/bar/' });
    const groups = buildProjectGroups([a, b]);
    const names = groups.map((g) => g.displayName).sort();
    expect(names).toEqual(['bar', 'foo']);
  });

  it('returns empty when there are no workers', () => {
    expect(buildProjectGroups([])).toEqual([]);
  });
});
