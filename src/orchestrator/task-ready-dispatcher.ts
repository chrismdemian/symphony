import type { TaskSnapshot, TaskStore } from '../state/types.js';
import {
  dependentsOf,
  isTaskReady,
  type TaskDepNode,
} from './task-deps.js';
import type {
  TaskReadyBroker,
  TaskReadyDispatcherHandle,
  TaskReadyEvent,
} from './task-ready-types.js';

/**
 * Phase 3P — Task-ready dispatcher.
 *
 * Wired between `TaskStoreOptions.onTaskStatusChange` (event source)
 * and the `TaskReadyBroker` (fan-out to TUI). Behavior:
 *
 *   - On a `completed` transition: look up dependents via the store,
 *     re-check readiness for each, emit one `task_ready` event per
 *     newly-ready dependent. The just-completed task's snapshot is
 *     attached as `unblockedBy` so the chat row can render
 *     "now ready after Tk-1234" without a follow-up RPC.
 *   - On any other transition: no-op. `in_progress`, `failed`,
 *     `cancelled`, and same-status updates do not fire (the store
 *     already gates on real transitions).
 *
 * The dispatcher does NOT walk the dependency tree transitively in
 * one fire: when A completes and unblocks B, we emit "B ready". If
 * the user then runs B and it completes, the next fire will unblock
 * C if applicable. This matches the per-transition contract of the
 * store hook and keeps each event one hop deep.
 *
 * Disposed flag (mirror 3O.1 audit M1): entry-only check shortcircuits
 * post-shutdown firings. Mid-chain disposed checks would race the
 * shutdown's flag-then-await sequence — the dispatcher's work here is
 * synchronous so there's no inflight set to drain, but the pattern
 * stays for parity with the auto-merge dispatcher in case future
 * extensions add async resolvers (e.g., richer project-name lookup).
 *
 * Resolver: `getProjectName(projectId): string` — server.ts wires it
 * through `projectStore`. Returns `'(unknown)'` for unregistered ids.
 */

export interface TaskReadyDispatcherDeps {
  /**
   * Read the FULL task set on demand. Source of truth for readiness
   * evaluation; the dispatcher cannot rely on its event source alone
   * because cross-project deps and prior pending tasks live there too.
   */
  readonly taskStore: TaskStore;
  /** Pub-sub channel that fans out to TUI subscribers. */
  readonly broker: TaskReadyBroker;
  /**
   * Resolve a display name for a `projectId`. Falls back to
   * `'(unknown)'` for unregistered projects (mirrors notifications +
   * auto-merge dispatcher conventions).
   */
  readonly getProjectName: (projectId: string) => string;
  /** Test seam. Defaults to `Date.now`. */
  readonly now?: () => number;
  /** Sink for unexpected errors. Defaults to no-op. */
  readonly onError?: (err: Error) => void;
}

export function createTaskReadyDispatcher(
  deps: TaskReadyDispatcherDeps,
): TaskReadyDispatcherHandle {
  const now = deps.now ?? Date.now;
  const onError = deps.onError ?? ((): void => undefined);
  let disposed = false;

  function isoNow(): string {
    return new Date(now()).toISOString();
  }

  function emit(event: TaskReadyEvent): void {
    try {
      deps.broker.publish(event);
    } catch (err) {
      onError(err instanceof Error ? err : new Error(String(err)));
    }
  }

  function buildHeadline(
    task: TaskSnapshot,
    projectName: string,
    unblockedBy: TaskSnapshot,
    unblockedByProjectName: string,
  ): string {
    const sameProject = projectName === unblockedByProjectName;
    const trigger = sameProject
      ? `${shortDescription(unblockedBy.description)} completed`
      : `${shortDescription(unblockedBy.description)} (${unblockedByProjectName}) completed`;
    return `Task ready: ${shortDescription(task.description)} (${projectName}) — ${trigger}`;
  }

  function handleStatusChange(snapshot: TaskSnapshot): void {
    if (disposed) return;
    if (snapshot.status !== 'completed') return; // only completion unblocks deps
    let dependents: readonly TaskDepNode[];
    let allTasks: readonly TaskDepNode[];
    try {
      // The store is the source of truth — its current snapshot already
      // reflects the just-completed task (the hook fired post-update).
      allTasks = deps.taskStore.list() as readonly TaskDepNode[];
      dependents = dependentsOf(snapshot.id, allTasks);
    } catch (err) {
      onError(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    if (dependents.length === 0) return;

    const unblockedByProjectName = resolveProjectName(deps, snapshot.projectId);
    for (const dependent of dependents) {
      if (!isTaskReady(dependent, allTasks)) continue;
      // Hydrate the dependent into a real snapshot via the store so the
      // wire shape stays consistent (callers expect TaskSnapshot, not
      // TaskDepNode). One per-dependent get() — acceptable; the
      // dependents list is bounded by fan-out width.
      let dependentSnapshot: TaskSnapshot | undefined;
      try {
        dependentSnapshot = deps.taskStore.snapshot(dependent.id);
      } catch (err) {
        onError(err instanceof Error ? err : new Error(String(err)));
        continue;
      }
      if (dependentSnapshot === undefined) continue;
      const projectName = resolveProjectName(deps, dependent.projectId);
      emit({
        kind: 'task_ready',
        task: dependentSnapshot,
        projectName,
        unblockedBy: snapshot,
        unblockedByProjectName,
        headline: buildHeadline(
          dependentSnapshot,
          projectName,
          snapshot,
          unblockedByProjectName,
        ),
        ts: isoNow(),
      });
    }
  }

  return {
    onTaskStatusChange(snapshot): void {
      handleStatusChange(snapshot);
    },
    async shutdown(): Promise<void> {
      if (disposed) return;
      disposed = true;
      // No inflight set today — handleStatusChange is fully sync. The
      // return value stays Promise<void> to match the AutoMergeDispatcher
      // contract so the server's close path can `await` both shutdowns
      // uniformly.
    },
  };
}

/**
 * Trim a long task description to a chat-row-friendly headline. Keeps
 * the first 60 chars + ellipsis; the panel popup shows the full text.
 */
function shortDescription(description: string): string {
  const trimmed = description.trim();
  if (trimmed.length <= 60) return trimmed;
  return `${trimmed.slice(0, 57)}…`;
}

function resolveProjectName(
  deps: TaskReadyDispatcherDeps,
  projectId: string,
): string {
  try {
    return deps.getProjectName(projectId);
  } catch {
    // A misbehaving resolver must not poison the dispatch.
    return '(unknown)';
  }
}
