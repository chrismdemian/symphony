import { z } from 'zod';
import type { ProjectStore } from '../../projects/types.js';
import { toTaskSnapshot } from '../../state/task-registry.js';
import type { TaskStore } from '../../state/types.js';
import type { ToolRegistration } from '../registry.js';

const shape = {
  project: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Project name or id the task belongs to. Optional: when omitted, the task lands on the active project (set via `set_active_project`) or the boot default. Phase 5D — mirrors `spawn_worker`\'s cursor-aware routing so Maestro can omit `project:` once a cursor is set.',
    ),
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
  /**
   * Phase 5D — resolves an omitted `project:` arg through the active-
   * project cursor before falling back to `defaultProjectPath`. Returns
   * the absolute project path; we then locate the matching record by
   * path (mirrors the listResolve / spawnResolve pattern in server.ts).
   * When omitted (older test rigs), an omitted `project:` rejects with
   * the original "Unknown project ''" shape so test fakes don't need
   * to grow a stub.
   */
  readonly resolveProjectPath?: (project?: string) => string;
}

export function makeCreateTaskTool(deps: CreateTaskDeps): ToolRegistration<typeof shape> {
  return {
    name: 'create_task',
    description:
      'Enqueue a new task against a project. Creates a pending TaskRecord. When `project:` is omitted, routes through the active-project cursor (set via `set_active_project`) before falling back to the boot default. Planning tool — available in PLAN and ACT mode (Maestro decomposes work during planning).',
    scope: 'both',
    capabilities: [],
    inputSchema: shape,
    handler: ({ project, description, priority, depends_on }) => {
      // Phase 5D — when caller omits `project:`, consult the resolver
      // (cursor → defaultProjectPath). The resolver returns a PATH;
      // we then find the matching project record by absolute-path
      // match (snapshot path is already path.resolve'd by the store).
      let resolvedProj: ReturnType<ProjectStore['get']> | undefined;
      if (project !== undefined && project.length > 0) {
        resolvedProj = deps.projectStore.get(project);
      } else if (deps.resolveProjectPath !== undefined) {
        const cursorPath = deps.resolveProjectPath(undefined);
        for (const p of deps.projectStore.list()) {
          if (p.path === cursorPath) {
            resolvedProj = p;
            break;
          }
        }
      }
      const proj = resolvedProj;
      if (!proj) {
        const reason =
          project === undefined || project.length === 0
            ? 'No active project set and no `project:` arg supplied. Call `set_active_project(name)` first, or pass `project:` explicitly.'
            : `Unknown project '${project}'.`;
        return {
          content: [{ type: 'text', text: reason }],
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
