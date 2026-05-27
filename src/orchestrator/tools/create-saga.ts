/**
 * Phase 5E — `create_saga` MCP tool.
 *
 * Creates a new saga binding 2+ task records across one or more projects
 * under a single user-visible intent. Member specs are resolved into
 * `create_task` calls AND saga membership rows in one shot — every
 * member task is registered with the SagaStore before this tool returns.
 *
 * Saga membership is set at task-creation time only and is immutable
 * thereafter. Adding/removing members post-hoc would race the rollup
 * writer (see `saga-rollup.ts` JSDoc).
 *
 * `create_saga` requires AT LEAST 2 member specs by design — single-project
 * work belongs on the existing `create_task` + `spawn_worker(task_id)`
 * happy path, per the Maestro cross-project-saga protocol fragment.
 */
import { z } from 'zod';

import type { ProjectStore } from '../../projects/types.js';
import type { SagaStore } from '../../state/saga-types.js';
import type { TaskStore } from '../../state/types.js';
import type { ToolRegistration } from '../registry.js';

const memberSpec = z.object({
  project: z
    .string()
    .min(1)
    .describe(
      'Project name or id this member task targets. Each member must name a registered project — sagas with unregistered absolute paths are rejected at the boundary so the rollup writer never sees orphan rows.',
    ),
  task_description: z
    .string()
    .min(1)
    .describe(
      'Full task description for the member task — what the worker should do. The member task is created with status=pending; spawn_worker(task_id=...) claims it later.',
    ),
  priority: z
    .number()
    .int()
    .optional()
    .describe('Priority forwarded to the member task. Default 0.'),
});

const shape = {
  description: z
    .string()
    .min(1)
    .describe(
      'User-visible intent the saga represents. Surfaces in the chat row when the saga completes and in `list_sagas` listings. Example: "Add healthcheck to API + ping button to client".',
    ),
  members: z
    .array(memberSpec)
    .min(2)
    .describe(
      'At least two member specs, each naming a project + task description. Each member spec is materialized as a `create_task` + `addMember` on the SagaStore. Members are immutable once written (no `add_saga_member` tool).',
    ),
};

export interface CreateSagaDeps {
  readonly sagaStore: SagaStore;
  readonly taskStore: TaskStore;
  readonly projectStore: ProjectStore;
}

export function makeCreateSagaTool(
  deps: CreateSagaDeps,
): ToolRegistration<typeof shape> {
  return {
    name: 'create_saga',
    description:
      'Create a cross-project saga — binds N member tasks across one or more projects under a single user intent. Member tasks are created `pending` with saga membership stamped in one transaction. Saga membership is IMMUTABLE after creation. Use sagas ONLY when the USER request explicitly names 2+ registered projects in one breath; single-project work stays on the bare `create_task` path. Planning tool — available in PLAN and ACT mode.',
    scope: 'both',
    capabilities: [],
    inputSchema: shape,
    handler: ({ description, members }) => {
      // Pre-resolve every member's project so we reject before any
      // partial write. Sagas straddling unknown projects are a fast
      // fail (the alternative — create the saga, fail mid-member-loop,
      // partial saga rows persisted — is worse).
      const resolved: { record: { id: string; name: string }; spec: z.infer<typeof memberSpec> }[] = [];
      for (const m of members) {
        const proj = deps.projectStore.get(m.project);
        if (proj === undefined) {
          return errorResult(
            `create_saga: unknown project '${m.project}'. Register it via \`symphony add\` first.`,
          );
        }
        resolved.push({ record: { id: proj.id, name: proj.name }, spec: m });
      }
      // Defensive — require the members to span at least one distinct
      // pair of projects. A "saga" with all members in one project is
      // a degenerate use of the abstraction; nudge the caller back to
      // bare `create_task`s. The unit test enforces this contract.
      const distinctProjects = new Set(resolved.map((r) => r.record.id));
      if (distinctProjects.size < 2) {
        return errorResult(
          'create_saga: all members target the same project. Sagas are for CROSS-project intents — use bare `create_task` for single-project work.',
        );
      }
      const saga = deps.sagaStore.create({ description });
      const createdMembers: {
        sagaId: string;
        taskId: string;
        projectId: string;
        projectName: string;
        description: string;
      }[] = [];
      try {
        for (const { record: proj, spec } of resolved) {
          const task = deps.taskStore.create({
            projectId: proj.id,
            description: spec.task_description,
            ...(spec.priority !== undefined ? { priority: spec.priority } : {}),
          });
          deps.sagaStore.addMember({
            sagaId: saga.id,
            taskId: task.id,
            projectId: proj.id,
          });
          createdMembers.push({
            sagaId: saga.id,
            taskId: task.id,
            projectId: proj.id,
            projectName: proj.name,
            description: task.description,
          });
        }
      } catch (err) {
        // Best effort rollback of any tasks we already wrote — the
        // saga row + member rows that committed are left for the user
        // to clean up via `update_saga(status='cancelled')`. SQLite
        // cascades take care of `saga_members` when `tasks` is deleted,
        // so the typical reset path stays clean.
        const msg = err instanceof Error ? err.message : String(err);
        return errorResult(
          `create_saga: failed after creating saga ${saga.id} with ${createdMembers.length} member(s). Error: ${msg}. Cancel the saga via \`update_saga(${saga.id}, status: 'cancelled')\` to clean up.`,
        );
      }
      const snap = deps.sagaStore.snapshot(saga.id)!;
      const memberSummary = createdMembers
        .map((m) => `- ${m.taskId} (${m.projectName}) — ${m.description.slice(0, 60)}`)
        .join('\n');
      return {
        content: [
          {
            type: 'text',
            text: `Saga ${saga.id} created with ${createdMembers.length} member(s):\n${memberSummary}\nUse \`spawn_worker(task_id=<id>)\` per member to start work.`,
          },
        ],
        structuredContent: {
          saga: snap as unknown as Record<string, unknown>,
          members: createdMembers,
        },
      };
    },
  };
}

function errorResult(text: string): ReturnType<
  NonNullable<ToolRegistration<typeof shape>['handler']>
> {
  return {
    content: [{ type: 'text', text }],
    isError: true,
  };
}
