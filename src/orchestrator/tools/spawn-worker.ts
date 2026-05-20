import path from 'node:path';
import { z } from 'zod';
import type { ProjectStore } from '../../projects/types.js';
import type { ToolRegistration } from '../registry.js';
import { WORKER_ROLES, type WorkerRole } from '../types.js';
import { loadProjectDroids } from '../../droids/registry.js';
import { formatDroidLabel, type DroidDefinition } from '../../droids/types.js';
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
    .string()
    .min(1)
    .describe(
      'A built-in role (implementer | researcher | reviewer | debugger | planner) ' +
        'OR a project custom-droid name (a file in <project>/.symphony/droids/). ' +
        'A custom droid whose name equals a built-in shadows the built-in.',
    ),
  model: z.string().optional().describe('Optional model override (default: Symphony default).'),
  depends_on: z
    .array(z.string())
    .optional()
    .describe('Worker IDs that must complete before this worker is spawned (advisory).'),
  autonomy_tier: z
    .union([z.literal(1), z.literal(2), z.literal(3)])
    .optional()
    .describe(
      'Per-worker autonomy tier override (1=free reign, 2=notify, 3=confirm). Defaults to the orchestrator-wide tier (config.autonomyTier, cycled via Ctrl+Y) when omitted. Advisory in 3S — surfaced via list_workers for Maestro context and as a worker-row chip when tier=3; architectural enforcement requires Phase 7 worker-side MCP.',
    ),
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
  /**
   * Phase 4F.2 — bundled droids loaded once at server boot
   * (`loadBundledDroids` in `src/droids/bundled.ts`). Resolution
   * precedence: project droid (under `<project>/.symphony/droids/`)
   * SHADOWS bundled droid SHADOWS built-in role (PLAN.md §4F override
   * rule). Omitted in pre-4F.2 test seams; resolution falls back to
   * project + built-in.
   */
  readonly bundledDroids?: ReadonlyMap<string, DroidDefinition>;
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

      // Phase 4F.1 — resolve the role. A project custom droid SHADOWS a
      // built-in of the same name (PLAN.md §4F override rule).
      // Discovered fresh per spawn so droid-file edits take effect
      // without restarting Symphony. An unknown role fails HERE, before
      // any Phase 3P task claim, so a bad role never strands a task
      // in_progress.
      const { droids, warnings: droidWarnings } =
        await loadProjectDroids(projectPath);
      // 4F.1 audit C2 + 4F.2 audit C1 — if the USER authored a droid
      // file at `<role>.md` INTENDING to shadow ANY downstream
      // resolution (built-in role OR bundled droid) with their own
      // restricted policy but the file failed to parse, DO NOT silently
      // fall through (which would spawn the less-restrictive downstream
      // tier — exact opposite of user intent). Fail closed. This check
      // is HOISTED ABOVE the bundled/built-in resolution so it covers
      // both shadow tiers, not just built-in (4F.2 C1 specifically
      // caught the bundled-shadow case the 4F.1 C2 fix had missed).
      const projectDroid = droids.get(role);
      if (projectDroid === undefined) {
        const shadowed = droidWarnings.find(
          (w) => path.basename(w.source) === `${role}.md`,
        );
        if (shadowed !== undefined) {
          // Name the tier the user was trying to shadow so the error is
          // actionable. WORKER_ROLES = built-in; bundledDroids = bundled.
          const tier = (WORKER_ROLES as readonly string[]).includes(role)
            ? 'built-in'
            : deps.bundledDroids?.has(role) === true
              ? 'bundled'
              : 'downstream';
          return {
            content: [
              {
                type: 'text',
                text:
                  `Cannot spawn '${role}': a droid file at ${shadowed.source} ` +
                  `is intended to shadow the ${tier} '${role}' but failed to parse — ` +
                  `${shadowed.message}. Fix the droid file (or delete it to fall ` +
                  `back to the ${tier} '${role}').`,
              },
            ],
            isError: true,
          };
        }
      }
      // 4F.2 — precedence: project droid > bundled droid > built-in role.
      const customDroid: DroidDefinition | undefined =
        projectDroid ?? deps.bundledDroids?.get(role);
      let resolvedRole: WorkerRole;
      if (customDroid !== undefined) {
        // `WorkerRole` is load-bearing across pipeline/SQL/snapshot;
        // a custom droid keeps a built-in baseline there and carries
        // its identity via the prompt + fence + response text.
        resolvedRole = 'implementer';
      } else if ((WORKER_ROLES as readonly string[]).includes(role)) {
        resolvedRole = role as WorkerRole;
      } else {
        const projectNames = [...droids.keys()].sort();
        const bundledNames = [
          ...(deps.bundledDroids?.keys() ?? []),
        ].sort();
        const warnText =
          droidWarnings.length > 0
            ? ' Skipped malformed droid file(s): ' +
              droidWarnings
                .map((w) => `${w.source} — ${w.message}`)
                .join('; ') +
              '.'
            : '';
        return {
          content: [
            {
              type: 'text',
              text:
                `Unknown role '${role}'. Built-in roles: ${WORKER_ROLES.join(
                  ', ',
                )}. Project droids: ${
                  projectNames.length > 0 ? projectNames.join(', ') : '(none)'
                }. Bundled droids: ${
                  bundledNames.length > 0 ? bundledNames.join(', ') : '(none)'
                }.${warnText}`,
            },
          ],
          isError: true,
        };
      }

      // Phase 3P — when task_id is provided AND we have a taskStore,
      // CLAIM the task BEFORE spawning. The atomic claim primitive
      // (audit M1) guarantees two concurrent spawn_worker(task_id=X)
      // callers can't both spawn parallel worktrees against the same
      // task: only the first wins the pending→in_progress transition.
      // The ready-gate (unmetDepsOf) runs before the claim so we can
      // surface the typed TaskNotReadyError shape distinct from the
      // generic "already claimed" rejection.
      //
      // Order:
      //   1. Resolve task; reject unknown
      //   2. Validate ready (unmetDepsOf returns []); reject with typed
      //      error otherwise — gives Maestro a structured payload
      //   3. CLAIM (atomic pending → in_progress + stamp workerId=record.id)
      //      We DON'T know the worker id yet, so use a temp placeholder
      //      and rewrite after spawn. Two callers race here; one wins.
      //   4. Spawn. On failure, REVERT the claim by re-issuing
      //      update_task(status='pending', workerId='') — best effort;
      //      a failed revert leaves the row in_progress with the temp
      //      worker id, surfaced in the error text.
      let claimedTempWorkerId: string | undefined;
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
        // Atomic claim — workerId placeholder rewritten post-spawn.
        claimedTempWorkerId = `pending-claim-${task_id}`;
        const claimed = deps.taskStore.claim(task_id, claimedTempWorkerId);
        if (claimed === null) {
          return {
            content: [
              {
                type: 'text',
                text: `Task '${task_id}' was claimed by another spawn_worker call between the readiness check and the claim. Refresh and try the next ready task.`,
              },
            ],
            isError: true,
          };
        }
      }

      const input: SpawnWorkerInput = {
        projectPath,
        projectId,
        taskDescription: task_description,
        role: resolvedRole,
        ...(customDroid !== undefined ? { droid: customDroid } : {}),
        ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
        ...(model !== undefined ? { model } : {}),
        ...(depends_on !== undefined ? { dependsOn: depends_on } : {}),
        ...(autonomy_tier !== undefined ? { autonomyTier: autonomy_tier } : {}),
        ...(task_id !== undefined ? { taskId: task_id } : {}),
      };
      let record;
      try {
        record = await deps.lifecycle.spawn(input);
      } catch (err) {
        // Spawn failed AFTER the claim. Revert so the task is reclaimable.
        if (task_id !== undefined && deps.taskStore !== undefined) {
          try {
            // status remains in_progress (claimed) until we explicitly
            // flip back. The state machine allows in_progress →
            // cancelled but NOT in_progress → pending; transition the
            // claim into cancelled so a follow-up create_task can
            // reschedule. (PLAN.md: task state machine.)
            deps.taskStore.update(task_id, {
              status: 'cancelled',
              result: `spawn_worker failed; claim reverted: ${err instanceof Error ? err.message : String(err)}`,
            });
          } catch {
            // best effort — the claim stays in_progress with the
            // placeholder workerId; user can update_task manually.
          }
        }
        throw err;
      }

      // Rewrite the placeholder workerId with the real one (the claim
      // already flipped status; this update only stamps the real id).
      if (task_id !== undefined && deps.taskStore !== undefined) {
        try {
          deps.taskStore.update(task_id, { workerId: record.id });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return {
            content: [
              {
                type: 'text',
                text: `Spawned worker ${record.id} but failed to stamp final workerId on task '${task_id}': ${msg}. Worker is live; task currently shows the placeholder id '${claimedTempWorkerId}'. Update manually with update_task.`,
              },
            ],
            isError: true,
            structuredContent: toSnapshot(record) as unknown as Record<string, unknown>,
          };
        }
      }

      const snap = toSnapshot(record);
      const roleLabel =
        customDroid !== undefined
          ? formatDroidLabel(customDroid.name)
          : snap.role;
      // Surface non-fatal droid load warnings so a malformed sibling
      // droid isn't silently missing (rule #7: visible, not noisy).
      const warnNote =
        droidWarnings.length > 0
          ? ` Note: ${droidWarnings.length} droid file(s) skipped — ` +
            droidWarnings.map((w) => `${w.source} (${w.message})`).join('; ')
          : '';
      return {
        content: [
          {
            type: 'text',
            text: `Spawned worker ${snap.id} (${roleLabel} / ${snap.featureIntent}) in ${snap.worktreePath}.${warnNote}`,
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
