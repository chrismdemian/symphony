/**
 * Phase 3P — Cross-project task dependencies.
 *
 * Pure helpers consumed by:
 *   - `tasks.list({readyOnly})` filter (server.ts → store passthrough)
 *   - `spawn_worker` task auto-link ready-gate
 *   - `TaskReadyDispatcher` (emits on newly-ready dependents post-completion)
 *   - `/deps` panel rendering (graph + cycle banner)
 *
 * Cycle detection note: the current `create_task` API rejects unknown
 * depended-upon ids, so by-construction in-order creates can never
 * produce a cycle (a task can't reference an id that doesn't exist
 * yet, and `update_task` does not mutate `dependsOn`). `detectCycles`
 * stays as defensive insurance for hand-edited SQLite or future API
 * mutation paths — the `/deps` panel surfaces a red banner if one is
 * found.
 */
import type { TaskSnapshot, TaskStatus } from '../state/types.js';

/** Read-only minimal shape both `TaskRecord` and `TaskSnapshot` satisfy. */
export interface TaskDepNode {
  readonly id: string;
  readonly projectId: string;
  readonly status: TaskStatus;
  readonly dependsOn: readonly string[];
}

/**
 * `true` iff `task.status === 'pending'` AND every entry in
 * `task.dependsOn` resolves to a task whose status is `'completed'`.
 * Unknown dep ids (id not in `allTasks`) make the task UNREADY — a
 * dependency that doesn't exist can never be satisfied. Returns false
 * for non-pending tasks (already running / terminal / blocked).
 */
export function isTaskReady(task: TaskDepNode, allTasks: readonly TaskDepNode[]): boolean {
  if (task.status !== 'pending') return false;
  if (task.dependsOn.length === 0) return true;
  const index = indexById(allTasks);
  for (const depId of task.dependsOn) {
    const dep = index.get(depId);
    if (dep === undefined) return false;
    if (dep.status !== 'completed') return false;
  }
  return true;
}

/**
 * Tasks whose `dependsOn` lists `taskId`. Order matches `allTasks`.
 * `TaskReadyDispatcher` calls this after a task transitions to
 * `completed` to find candidates whose readiness might have flipped.
 */
export function dependentsOf<T extends TaskDepNode>(
  taskId: string,
  allTasks: readonly T[],
): readonly T[] {
  const out: T[] = [];
  for (const t of allTasks) {
    if (t.dependsOn.includes(taskId)) out.push(t);
  }
  return out;
}

/**
 * Deps that are NOT yet completed (missing-by-id or status≠completed).
 * Order matches `task.dependsOn`. Used to compose the
 * `TaskNotReadyError.blockedBy` payload so the chat row can name the
 * blockers concretely instead of "deps unmet".
 */
export interface UnmetDep {
  readonly id: string;
  /** `null` when the dep id is unknown (not in `allTasks`). */
  readonly status: TaskStatus | null;
}

export function unmetDepsOf(
  task: TaskDepNode,
  allTasks: readonly TaskDepNode[],
): readonly UnmetDep[] {
  if (task.dependsOn.length === 0) return [];
  const index = indexById(allTasks);
  const out: UnmetDep[] = [];
  for (const depId of task.dependsOn) {
    const dep = index.get(depId);
    if (dep === undefined) {
      out.push({ id: depId, status: null });
    } else if (dep.status !== 'completed') {
      out.push({ id: depId, status: dep.status });
    }
  }
  return out;
}

/**
 * Pure DFS cycle detector. Returns a list of cycle paths; each path
 * is the ordered task-id sequence forming a back-edge.
 *
 * Example: if `A → B → C → A`, returns `[['A','B','C','A']]`.
 *
 * Distinct cycles are reported once (smallest start-id sorted to the
 * front). Self-loops (`X → X`) count as cycles too.
 *
 * Defensive — should always return `[]` under current API rules.
 */
export function detectCycles(allTasks: readonly TaskDepNode[]): readonly (readonly string[])[] {
  const adj = adjacencyOutgoing(allTasks);
  const seen = new Set<string>();
  const stack: string[] = [];
  const inStack = new Set<string>();
  const cycles = new Map<string, readonly string[]>();

  function visit(id: string): void {
    if (inStack.has(id)) {
      const startIdx = stack.indexOf(id);
      if (startIdx === -1) return;
      const path = [...stack.slice(startIdx), id];
      // Canonicalize so the cycle is reported once regardless of where
      // DFS enters it: rotate the path so the smallest id starts it.
      // Self-loop case (`[X, X]`) trivially canonical.
      const minIdx = minIdIndex(path.slice(0, -1));
      const rotated =
        minIdx === 0
          ? path
          : ([...path.slice(minIdx, -1), ...path.slice(0, minIdx), path.slice(minIdx)[0]!] as string[]);
      const key = rotated.join('->');
      if (!cycles.has(key)) cycles.set(key, rotated);
      return;
    }
    if (seen.has(id)) return;
    seen.add(id);
    inStack.add(id);
    stack.push(id);
    const out = adj.get(id) ?? [];
    for (const next of out) visit(next);
    stack.pop();
    inStack.delete(id);
  }

  for (const t of allTasks) visit(t.id);
  return Array.from(cycles.values());
}

/**
 * Adjacency directed FROM dependent TO dep (matches `dependsOn`
 * semantics: an edge `X → Y` reads "X depends on Y"). Cycle detection
 * traverses this graph; an SCC contains the cycle path.
 */
function adjacencyOutgoing(allTasks: readonly TaskDepNode[]): Map<string, readonly string[]> {
  const m = new Map<string, readonly string[]>();
  for (const t of allTasks) m.set(t.id, t.dependsOn);
  return m;
}

function indexById<T extends TaskDepNode>(allTasks: readonly T[]): Map<string, T> {
  const m = new Map<string, T>();
  for (const t of allTasks) m.set(t.id, t);
  return m;
}

function minIdIndex(ids: readonly string[]): number {
  if (ids.length === 0) return 0;
  let bestIdx = 0;
  let best = ids[0]!;
  for (let i = 1; i < ids.length; i += 1) {
    if (ids[i]! < best) {
      best = ids[i]!;
      bestIdx = i;
    }
  }
  return bestIdx;
}

/**
 * Graph snapshot used by `/deps` (server-side via `tasks.graph` RPC).
 *
 * `nodes` is filtered per Chris's choice (PLAN §3P) to **graph only**:
 * tasks with at least one edge (incoming OR outgoing). Solo tasks live
 * in the 3L Queue panel, not here. `edges.from → edges.to` reads
 * "`from` depends on `to`" — same direction as `dependsOn`.
 *
 * `cycles` is the `detectCycles` output passed through so the panel
 * can paint a banner without re-running the DFS.
 */
export interface TaskGraph {
  readonly nodes: readonly TaskSnapshot[];
  readonly edges: readonly { readonly from: string; readonly to: string }[];
  readonly cycles: readonly (readonly string[])[];
}

export function extractGraphEdges(allTasks: readonly TaskSnapshot[]): TaskGraph {
  // Pass 1: collect node ids referenced by any edge (outgoing OR
  // incoming). Unknown ids in `dependsOn` are tolerated for edges so
  // the panel can show "Tk-xxxx → ???" — `/deps` is a debug surface,
  // not a hard validator.
  const referenced = new Set<string>();
  const edges: { from: string; to: string }[] = [];
  for (const t of allTasks) {
    for (const depId of t.dependsOn) {
      edges.push({ from: t.id, to: depId });
      referenced.add(t.id);
      referenced.add(depId);
    }
  }
  // Pass 2: nodes = tasks present in the input AND in `referenced`.
  // Order preserved from input so the panel renders deterministically.
  const nodes = allTasks.filter((t) => referenced.has(t.id));
  // Reuse detectCycles. The snapshot shape satisfies TaskDepNode.
  const cycles = detectCycles(allTasks as readonly TaskDepNode[]);
  return { nodes, edges, cycles };
}

/**
 * Build adjacency map keyed by `from` for grouped rendering. Used by
 * `DepsPanel` to render "X depends on: a, b, c" rows.
 */
export function groupEdgesByFrom(
  edges: readonly { from: string; to: string }[],
): ReadonlyMap<string, readonly string[]> {
  const out = new Map<string, string[]>();
  for (const e of edges) {
    const list = out.get(e.from);
    if (list === undefined) out.set(e.from, [e.to]);
    else list.push(e.to);
  }
  return out;
}

/**
 * Reverse map keyed by `to` — used by the dispatcher to find "what
 * tasks unblock when `to` completes" without rescanning all tasks.
 */
export function groupEdgesByTo(
  edges: readonly { from: string; to: string }[],
): ReadonlyMap<string, readonly string[]> {
  const out = new Map<string, string[]>();
  for (const e of edges) {
    const list = out.get(e.to);
    if (list === undefined) out.set(e.to, [e.from]);
    else list.push(e.from);
  }
  return out;
}
