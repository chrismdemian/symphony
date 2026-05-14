import { describe, expect, it } from 'vitest';
import {
  dependentsOf,
  detectCycles,
  extractGraphEdges,
  groupEdgesByFrom,
  groupEdgesByTo,
  isTaskReady,
  unmetDepsOf,
  type TaskDepNode,
} from '../../src/orchestrator/task-deps.js';
import type { TaskSnapshot, TaskStatus } from '../../src/state/types.js';
import { TaskCycleError, TaskNotReadyError } from '../../src/state/types.js';

/**
 * Phase 3P — pure helpers covering:
 *   - readiness gate (`isTaskReady` + `unmetDepsOf`)
 *   - reverse-edge lookup (`dependentsOf`)
 *   - graph extraction filtered to nodes with edges
 *   - DFS cycle detector (defensive — current API can't produce them)
 *   - typed error shapes (code discriminant + payload)
 *
 * No I/O. Everything is a pure function over readonly arrays.
 */

function node(
  id: string,
  status: TaskStatus,
  dependsOn: readonly string[] = [],
  projectId = 'proj-1',
): TaskDepNode {
  return { id, projectId, status, dependsOn };
}

function snap(
  id: string,
  status: TaskStatus,
  dependsOn: readonly string[] = [],
  projectId = 'proj-1',
): TaskSnapshot {
  return {
    id,
    projectId,
    description: `task ${id}`,
    status,
    priority: 0,
    dependsOn,
    notes: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('isTaskReady', () => {
  it('returns true for pending task with no deps', () => {
    const t = node('A', 'pending');
    expect(isTaskReady(t, [t])).toBe(true);
  });

  it('returns true when every dep is completed', () => {
    const a = node('A', 'completed');
    const b = node('B', 'completed');
    const c = node('C', 'pending', ['A', 'B']);
    expect(isTaskReady(c, [a, b, c])).toBe(true);
  });

  it('returns false when any dep is pending', () => {
    const a = node('A', 'completed');
    const b = node('B', 'pending');
    const c = node('C', 'pending', ['A', 'B']);
    expect(isTaskReady(c, [a, b, c])).toBe(false);
  });

  it('returns false when any dep is in_progress', () => {
    const a = node('A', 'in_progress');
    const c = node('C', 'pending', ['A']);
    expect(isTaskReady(c, [a, c])).toBe(false);
  });

  it('returns false when any dep is failed', () => {
    const a = node('A', 'failed');
    const c = node('C', 'pending', ['A']);
    expect(isTaskReady(c, [a, c])).toBe(false);
  });

  it('returns false when any dep is cancelled', () => {
    const a = node('A', 'cancelled');
    const c = node('C', 'pending', ['A']);
    expect(isTaskReady(c, [a, c])).toBe(false);
  });

  it('returns false when a dep id is unknown', () => {
    // Hand-edited / corrupted state: dep references id not in the set.
    // A task that depends on a missing id can never satisfy.
    const c = node('C', 'pending', ['MISSING']);
    expect(isTaskReady(c, [c])).toBe(false);
  });

  it('returns false for in_progress tasks', () => {
    const t = node('A', 'in_progress');
    expect(isTaskReady(t, [t])).toBe(false);
  });

  it('returns false for completed tasks', () => {
    const t = node('A', 'completed');
    expect(isTaskReady(t, [t])).toBe(false);
  });

  it('returns false for failed / cancelled tasks', () => {
    const failed = node('F', 'failed');
    const cancelled = node('X', 'cancelled');
    expect(isTaskReady(failed, [failed])).toBe(false);
    expect(isTaskReady(cancelled, [cancelled])).toBe(false);
  });

  it('handles cross-project deps identically to same-project deps', () => {
    const a = node('A', 'completed', [], 'proj-1');
    const b = node('B', 'pending', ['A'], 'proj-2');
    expect(isTaskReady(b, [a, b])).toBe(true);
  });
});

describe('unmetDepsOf', () => {
  it('returns empty when task has no deps', () => {
    const t = node('A', 'pending');
    expect(unmetDepsOf(t, [t])).toEqual([]);
  });

  it('returns empty when all deps are completed', () => {
    const a = node('A', 'completed');
    const c = node('C', 'pending', ['A']);
    expect(unmetDepsOf(c, [a, c])).toEqual([]);
  });

  it('reports non-completed deps with their current status', () => {
    const a = node('A', 'completed');
    const b = node('B', 'in_progress');
    const c = node('C', 'pending', ['A', 'B']);
    expect(unmetDepsOf(c, [a, b, c])).toEqual([{ id: 'B', status: 'in_progress' }]);
  });

  it('reports unknown dep ids with null status', () => {
    const c = node('C', 'pending', ['GHOST']);
    expect(unmetDepsOf(c, [c])).toEqual([{ id: 'GHOST', status: null }]);
  });

  it('preserves the dependsOn order', () => {
    const c = node('C', 'pending', ['Z', 'A', 'B']);
    const a = node('A', 'pending');
    const b = node('B', 'completed');
    const z = node('Z', 'failed');
    expect(unmetDepsOf(c, [a, b, c, z]).map((d) => d.id)).toEqual(['Z', 'A']);
  });
});

describe('dependentsOf', () => {
  it('returns empty when no task depends on the given id', () => {
    const a = node('A', 'pending');
    const b = node('B', 'pending');
    expect(dependentsOf('A', [a, b])).toEqual([]);
  });

  it('returns every task whose dependsOn includes the id', () => {
    const a = node('A', 'completed');
    const b = node('B', 'pending', ['A']);
    const c = node('C', 'pending', ['A', 'B']);
    const d = node('D', 'pending', ['B']);
    const result = dependentsOf('A', [a, b, c, d]);
    expect(result.map((t) => t.id)).toEqual(['B', 'C']);
  });

  it('preserves input order', () => {
    const b = node('B', 'pending', ['A']);
    const c = node('C', 'pending', ['A']);
    const d = node('D', 'pending', ['A']);
    // Reverse input order — result should match.
    expect(dependentsOf('A', [d, c, b]).map((t) => t.id)).toEqual(['D', 'C', 'B']);
  });
});

describe('detectCycles', () => {
  it('returns empty for an acyclic graph', () => {
    const a = node('A', 'completed');
    const b = node('B', 'pending', ['A']);
    const c = node('C', 'pending', ['A', 'B']);
    expect(detectCycles([a, b, c])).toEqual([]);
  });

  it('returns empty for an empty graph', () => {
    expect(detectCycles([])).toEqual([]);
  });

  it('detects a simple 2-cycle (A → B → A)', () => {
    const a = node('A', 'pending', ['B']);
    const b = node('B', 'pending', ['A']);
    const cycles = detectCycles([a, b]);
    expect(cycles).toHaveLength(1);
    // Canonical form: smallest id starts the path.
    expect(cycles[0]).toEqual(['A', 'B', 'A']);
  });

  it('detects a 3-cycle and reports it once regardless of DFS entry', () => {
    const a = node('A', 'pending', ['B']);
    const b = node('B', 'pending', ['C']);
    const c = node('C', 'pending', ['A']);
    const cycles = detectCycles([c, b, a]);
    expect(cycles).toHaveLength(1);
    expect(cycles[0]).toEqual(['A', 'B', 'C', 'A']);
  });

  it('detects self-loops', () => {
    const a = node('A', 'pending', ['A']);
    const cycles = detectCycles([a]);
    expect(cycles).toHaveLength(1);
    expect(cycles[0]).toEqual(['A', 'A']);
  });

  it('does not flag a diamond as a cycle', () => {
    //     A
    //    / \
    //   B   C
    //    \ /
    //     D
    // B and C both depend on A; D depends on B and C. Acyclic.
    const a = node('A', 'completed');
    const b = node('B', 'pending', ['A']);
    const c = node('C', 'pending', ['A']);
    const d = node('D', 'pending', ['B', 'C']);
    expect(detectCycles([a, b, c, d])).toEqual([]);
  });
});

describe('extractGraphEdges', () => {
  it('returns empty graph when no task has deps', () => {
    const out = extractGraphEdges([snap('A', 'pending'), snap('B', 'pending')]);
    expect(out.nodes).toEqual([]);
    expect(out.edges).toEqual([]);
    expect(out.cycles).toEqual([]);
  });

  it('includes only tasks with at least one edge', () => {
    const a = snap('A', 'completed');
    const b = snap('B', 'pending', ['A']);
    const c = snap('C', 'pending'); // solo
    const out = extractGraphEdges([a, b, c]);
    expect(out.nodes.map((n) => n.id)).toEqual(['A', 'B']);
    expect(out.edges).toEqual([{ from: 'B', to: 'A' }]);
  });

  it('preserves input order in nodes', () => {
    const a = snap('A', 'completed');
    const b = snap('B', 'pending', ['A']);
    const c = snap('C', 'pending', ['B']);
    const out = extractGraphEdges([c, a, b]);
    expect(out.nodes.map((n) => n.id)).toEqual(['C', 'A', 'B']);
  });

  it('tolerates unknown dep ids in edges but does not synthesize node entries for them', () => {
    const a = snap('A', 'pending', ['GHOST']);
    const out = extractGraphEdges([a]);
    expect(out.edges).toEqual([{ from: 'A', to: 'GHOST' }]);
    // GHOST is referenced but not in the input — still listed in nodes?
    // No: nodes are tasks IN THE INPUT that are referenced. GHOST is
    // referenced but not in the input, so the panel renders "→ GHOST"
    // without a node tile.
    expect(out.nodes.map((n) => n.id)).toEqual(['A']);
  });

  it('passes cycles through from detectCycles', () => {
    const a = snap('A', 'pending', ['B']);
    const b = snap('B', 'pending', ['A']);
    const out = extractGraphEdges([a, b]);
    expect(out.cycles).toHaveLength(1);
  });
});

describe('groupEdgesByFrom / groupEdgesByTo', () => {
  it('groups edges by from (depends-on adjacency)', () => {
    const edges = [
      { from: 'A', to: 'X' },
      { from: 'A', to: 'Y' },
      { from: 'B', to: 'X' },
    ];
    const m = groupEdgesByFrom(edges);
    expect(m.get('A')).toEqual(['X', 'Y']);
    expect(m.get('B')).toEqual(['X']);
    expect(m.size).toBe(2);
  });

  it('groups edges by to (dependents adjacency)', () => {
    const edges = [
      { from: 'A', to: 'X' },
      { from: 'B', to: 'X' },
      { from: 'A', to: 'Y' },
    ];
    const m = groupEdgesByTo(edges);
    expect(m.get('X')).toEqual(['A', 'B']);
    expect(m.get('Y')).toEqual(['A']);
  });
});

describe('TaskNotReadyError shape', () => {
  it('exposes typed code + taskId + blockedBy payload', () => {
    const err = new TaskNotReadyError('C', [
      { id: 'A', status: 'pending' },
      { id: 'B', status: null },
    ]);
    expect(err.code).toBe('task-not-ready');
    expect(err.taskId).toBe('C');
    expect(err.blockedBy).toHaveLength(2);
    expect(err.message).toContain('A');
    expect(err.message).toContain('B');
    expect(err.name).toBe('TaskNotReadyError');
    expect(err instanceof Error).toBe(true);
  });
});

describe('TaskCycleError shape', () => {
  it('exposes typed code + cycle path', () => {
    const err = new TaskCycleError(['A', 'B', 'C', 'A']);
    expect(err.code).toBe('task-cycle');
    expect(err.path).toEqual(['A', 'B', 'C', 'A']);
    expect(err.message).toContain('A → B → C → A');
    expect(err.name).toBe('TaskCycleError');
  });
});
