import { z } from 'zod';
import type { ToolRegistration } from '../registry.js';
import { WORKER_ROLES, type WorkerRole } from '../types.js';
import type { WorkerLifecycleHandle, SpawnWorkerInput } from '../worker-lifecycle.js';
import { toSnapshot, type WorkerRegistry } from '../worker-registry.js';

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
};

export interface SpawnWorkerDeps {
  readonly registry: WorkerRegistry;
  readonly lifecycle: WorkerLifecycleHandle;
  readonly resolveProjectPath: (project?: string) => string;
}

export function makeSpawnWorkerTool(deps: SpawnWorkerDeps): ToolRegistration<typeof shape> {
  return {
    name: 'spawn_worker',
    description:
      'Create a Claude Code worker in a fresh worktree with a role-specific prompt. Returns the worker record including its id, worktree path, and feature intent.',
    scope: 'act',
    capabilities: [],
    inputSchema: shape,
    handler: async ({ project, task_description, role, model, depends_on, autonomy_tier }, ctx) => {
      const projectPath = deps.resolveProjectPath(project);
      const input: SpawnWorkerInput = {
        projectPath,
        taskDescription: task_description,
        role,
        ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
        ...(model !== undefined ? { model } : {}),
        ...(depends_on !== undefined ? { dependsOn: depends_on } : {}),
        ...(autonomy_tier !== undefined ? { autonomyTier: autonomy_tier } : {}),
      };
      const record = await deps.lifecycle.spawn(input);
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
