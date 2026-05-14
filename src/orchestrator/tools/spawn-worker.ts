import { z } from 'zod';
import type { ProjectStore } from '../../projects/types.js';
import type { ToolRegistration } from '../registry.js';
import { WORKER_ROLES, type WorkerRole } from '../types.js';
import type { WorkerLifecycleHandle, SpawnWorkerInput } from '../worker-lifecycle.js';
import { toSnapshot, type WorkerRegistry } from '../worker-registry.js';
import { TaskNotReadyError, type TaskStore } from '../../state/types.js';
import { unmetDepsOf, type TaskDepNode } from '../task-deps.js';

const shape = {
  project: z
    .string()
    .optional()
    .describe(
      'Project key (name or absolute path). Omit to use the orchestrator default project.',
    ),
  task_description: z
    .string()
    .min(1)
    .describe('Full worker prompt — context, scope, definition of done.'),
  role: z
    .enum(WORKER_ROLES as readonly [WorkerRole, ...WorkerRole[]])
    .describe('implementer | researcher | reviewer | debugger | planner'),
  model: z.string().optional().describe('Optional model override (default: Symphony default).'),
  depends_on: z
    .array(z.string())
    .optional()
    .describe('Worker IDs that must complete before this worker is spawned (advisory).'),
  autonomy_tier: z
    .union([z.literal(1), z.literal(2), z.literal(3)])
    .optional()
    .describe('Worker autonomy tier (1 = free reign, 2 = notify, 3 = confirm). Default: 1.'),
  task_id: z
    .string()
    .optional()
    .describe(
      "Phase 3P — link this worker to a pending Task. When set, spawn_worker validates the task's dependsOn chain is fully completed (TaskNotReadyError otherwise), then atomically flips the task to in_progress + stamps task.workerId on successful spawn.",
    ),
};

export interface SpawnWorkerDeps {
  readonly registry: WorkerRegistry;
  readonly lifecycle: WorkerLifecycleHandle;
  readonly resolveProjectPath: (project?: string) => string;
  /**
   * Phase 2B.1b — project store seam used to resolve a stable `projectId`
   * for SQL persistence. Returns `null` for unregistered absolute paths
   * (don't fabricate IDs — audit M2 from 2A.4a).
   */
  readonly projectStore?: ProjectStore;
  /**
   * Phase 3P — task store for the optional `task_id` auto-link gate.
   * When provided AND `task_id` is set, the tool validates readiness
   * before spawning and updates the task post-spawn. When omitted,
   * `task_id` is ignored (degrades gracefully — pre-3P test seams
   * keep working).
   */
  readonly taskStore?: TaskStore;
}

export function makeSpawnWorkerTool(deps: SpawnWorkerDeps): ToolRegistration<typeof shape> {
  return {
    name: 'spawn_worker',
    description:
      'Create a Claude Code worker in a fresh worktree with a role-specific prompt. Returns the worker record including its id, worktree path, and feature intent.',
    scope: 'act',
    capabilities: [],
    inputSchema: shape,
    handler: async (
      { project, task_description, role, model, depends_on, autonomy_tier, task_id },
      ctx,
    ) => {
      const projectPath = deps.resolveProjectPath(project);
      const projectId = resolveProjectId(deps.projectStore, project, projectPath);

      // Phase 3P — when task_id is provided AND we have a taskStore,
      // validate the task is ready before spawning. Pre-spawn check
      // matters: spawning creates a worktree (expensive), then if we
      // discovered the task wasn't ready we'd have to clean up. Gate
      // first.
      if (task_id !== undefined && deps.taskStore !== undefined) {
        const task = deps.taskStore.get(task_id);
        if (task === undefined) {
          return {
            content: [{ type: 'text', text: `Unknown task '${task_id}'.` }],
            isError: true,
          };
        }
        if (task.status !== 'pending') {
          return {
            content: [
              {
                type: 'text',
                text: `Task '${task_id}' is ${task.status}, not pending — cannot link a new worker. Use resume_worker on the existing worker, or create a new task.`,
              },
            ],
            isError: true,
          };
        }
        const allTasks = deps.taskStore.list() as readonly TaskDepNode[];
        const unmet = unmetDepsOf(task, allTasks);
        if (unmet.length > 0) {
          const err = new TaskNotReadyError(task_id, unmet);
          return {
            content: [
              { type: 'text', text: err.message },
            ],
            isError: true,
            structuredContent: {
              code: err.code,
              taskId: err.taskId,
              blockedBy: err.blockedBy,
            } as unknown as Record<string, unknown>,
          };
        }
      }

      const input: SpawnWorkerInput = {
        projectPath,
        projectId,
        taskDescription: task_description,
        role,
        ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
        ...(model !== undefined ? { model } : {}),
        ...(depends_on !== undefined ? { dependsOn: depends_on } : {}),
        ...(autonomy_tier !== undefined ? { autonomyTier: autonomy_tier } : {}),
        ...(task_id !== undefined ? { taskId: task_id } : {}),
      };
      const record = await deps.lifecycle.spawn(input);

      // Phase 3P — auto-link succeeded; flip task to in_progress and
      // stamp workerId. Per Chris's PLAN choice (auto-link). One
      // update covers both fields. Errors here are surfaced but the
      // worker is already alive — the chat row makes the mismatch
      // visible.
      if (task_id !== undefined && deps.taskStore !== undefined) {
        try {
          deps.taskStore.update(task_id, {
            status: 'in_progress',
            workerId: record.id,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return {
            content: [
              {
                type: 'text',
                text: `Spawned worker ${record.id} but failed to auto-link task '${task_id}': ${msg}. Worker is live; flip task state manually with update_task.`,
              },
            ],
            isError: true,
            structuredContent: toSnapshot(record) as unknown as Record<string, unknown>,
          };
        }
      }

      const snap = toSnapshot(record);
      return {
        content: [
          {
            type: 'text',
            text: `Spawned worker ${snap.id} (${snap.role} / ${snap.featureIntent}) in ${snap.worktreePath}`,
          },
        ],
        structuredContent: snap as unknown as Record<string, unknown>,
      };
    },
  };
}

/**
 * Resolve a stable `projectId` for SQL persistence. Behavior parity with
 * `server.ts:resolveProjectPath`: named lookup → store id; absolute path
 * fallback → look up by path; otherwise `null`. Audit M2 from 2A.4a:
 * never fabricate IDs for unregistered projects.
 */
export function resolveProjectId(
  store: ProjectStore | undefined,
  project: string | undefined,
  projectPath: string,
): string | null {
  if (store === undefined) return null;
  if (project !== undefined && project.length > 0) {
    const named = store.get(project);
    if (named) return named.id;
  }
  // Absolute-path callers: the project store keys by name, so we match by path.
  for (const r of store.list()) {
    if (r.path === projectPath) return r.id;
  }
  return null;
}
