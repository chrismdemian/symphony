import { z } from 'zod';
import type { ProjectStore } from '../../projects/types.js';
import type {
  TaskListFilter,
  TaskSnapshot,
  TaskStore,
} from '../../state/types.js';
import { TASK_STATUSES, type TaskStatus } from '../../state/types.js';
import type { ToolRegistration } from '../registry.js';

const DEFAULT_CAP = 500;
const statusLiterals = TASK_STATUSES as readonly [TaskStatus, ...TaskStatus[]];

const shape = {
  project: z
    .string()
    .optional()
    .describe('Filter by project name or id. Omit to list across all projects.'),
  status: z
    .union([z.enum(statusLiterals), z.array(z.enum(statusLiterals)).min(1)])
    .optional()
    .describe('Filter by one status or an array of statuses.'),
  limit: z
    .number()
    .int()
    .positive()
    .max(DEFAULT_CAP)
    .optional()
    .describe(`Max records returned (1..${DEFAULT_CAP}, default ${DEFAULT_CAP}).`),
  ready_only: z
    .boolean()
    .optional()
    .describe(
      "Phase 3P — only return tasks with status='pending' AND every dep in 'completed' status (cross-project deps resolved against the full task set). Combine with `project` to find ready tasks for one project.",
    ),
  include_notes: z
    .boolean()
    .optional()
    .describe(
      'Phase 5C — when true, the embedded `notes` array stays in each returned task. Default false: notes are stripped to keep payloads compact. Use `task_notes(action:"read")` for per-task note inspection instead.',
    ),
};

export interface ListTasksDeps {
  readonly taskStore: TaskStore;
  readonly projectStore: ProjectStore;
}

export function makeListTasksTool(deps: ListTasksDeps): ToolRegistration<typeof shape> {
  return {
    name: 'list_tasks',
    description:
      'List tasks across projects, optionally filtered by status and/or project. Planning tool — available in PLAN and ACT mode. By default `structuredContent.tasks[]` OMITS the per-task notes array to keep payloads compact; pass `include_notes: true` to include them. `structuredContent.notesIncluded: boolean` reflects which view you got back.',
    scope: 'both',
    capabilities: [],
    inputSchema: shape,
    handler: ({ project, status, limit, ready_only, include_notes }) => {
      let projectId: string | undefined;
      if (project !== undefined) {
        const proj = deps.projectStore.get(project);
        if (!proj) {
          return {
            content: [{ type: 'text', text: `Unknown project '${project}'.` }],
            isError: true,
          };
        }
        projectId = proj.id;
      }
      const filter: TaskListFilter = {
        ...(projectId !== undefined ? { projectId } : {}),
        ...(status !== undefined ? { status } : {}),
        ...(ready_only !== undefined ? { readyOnly: ready_only } : {}),
      };
      const cap = limit ?? DEFAULT_CAP;
      const all = deps.taskStore.snapshots(filter);
      const total = all.length;
      const truncated = total > cap;
      const tasks = truncated ? all.slice(0, cap) : all;
      const text =
        tasks.length === 0
          ? 'No tasks match.'
          : tasks
              .map(
                (t) =>
                  `- ${t.id} [${t.status}] (${t.projectId}) ${truncate(t.description, 80)}`,
              )
              .join('\n');
      // Phase 5C — by default, strip the embedded notes array from the
      // structuredContent payload to keep Maestro's context tight.
      // Notes are pulled per-task via `task_notes(action:"read")`.
      // Callers that explicitly need the embedded notes pass
      // `include_notes: true`. The text output never included notes —
      // unchanged.
      const stripNotes = include_notes !== true;
      const projectedTasks = stripNotes
        ? tasks.map(stripNotesField)
        : tasks;
      return {
        content: [{ type: 'text', text }],
        structuredContent: {
          tasks: projectedTasks as unknown as Record<string, unknown>[],
          total,
          truncated,
          notesIncluded: include_notes === true,
        },
      };
    },
  };
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

/**
 * Phase 5C — strip the embedded `notes` array from a `TaskSnapshot` so
 * `list_tasks` doesn't flood Maestro's context. Uses a destructuring
 * rest pattern so future TaskSnapshot fields land in the output
 * automatically.
 */
function stripNotesField(snap: TaskSnapshot): Omit<TaskSnapshot, 'notes'> {
  // `notes` is the only field we want to drop; all others propagate.
  const { notes: _drop, ...rest } = snap;
  return rest;
}
