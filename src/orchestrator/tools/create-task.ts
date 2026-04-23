import { z } from 'zod';
import type { ProjectStore } from '../../projects/types.js';
import { toTaskSnapshot } from '../../state/task-registry.js';
import type { TaskStore } from '../../state/types.js';
import type { ToolRegistration } from '../registry.js';

const shape = {
  project: z.string().min(1).describe('Project name or id the task belongs to.'),
  description: z
    .string()
    .min(1)
    .describe('Human-readable description of the work to be done.'),
  priority: z
    .number()
    .int()
    .optional()
    .describe('Higher runs sooner. Default 0. Advisory in 2A.3.'),
  depends_on: z
    .array(z.string())
    .optional()
    .describe('Task ids that must complete first (advisory until Phase 2B dependency engine).'),
};

export interface CreateTaskDeps {
  readonly taskStore: TaskStore;
  readonly projectStore: ProjectStore;
}

export function makeCreateTaskTool(deps: CreateTaskDeps): ToolRegistration<typeof shape> {
  return {
    name: 'create_task',
    description:
      'Enqueue a new task against a project. Creates a pending TaskRecord. Planning tool — available in PLAN and ACT mode (Maestro decomposes work during planning).',
    scope: 'both',
    capabilities: [],
    inputSchema: shape,
    handler: ({ project, description, priority, depends_on }) => {
      const proj = deps.projectStore.get(project);
      if (!proj) {
        return {
          content: [{ type: 'text', text: `Unknown project '${project}'.` }],
          isError: true,
        };
      }
      if (depends_on !== undefined) {
        const missing = depends_on.filter((id) => deps.taskStore.get(id) === undefined);
        if (missing.length > 0) {
          return {
            content: [
              {
                type: 'text',
                text: `Unknown dependency task ids: ${missing.join(', ')}`,
              },
            ],
            isError: true,
          };
        }
      }
      try {
        const record = deps.taskStore.create({
          projectId: proj.id,
          description,
          ...(priority !== undefined ? { priority } : {}),
          ...(depends_on !== undefined ? { dependsOn: depends_on } : {}),
        });
        const snap = toTaskSnapshot(record);
        return {
          content: [
            {
              type: 'text',
              text: `Task ${snap.id} created in ${proj.name} [${snap.status}].`,
            },
          ],
          structuredContent: snap as unknown as Record<string, unknown>,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text', text: `create_task failed: ${msg}` }],
          isError: true,
        };
      }
    },
  };
}
