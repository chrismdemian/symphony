/**
 * Phase 5E — `list_sagas` MCP tool. Lists sagas optionally filtered by
 * status and/or project (membership). Members are included in the
 * structuredContent so Maestro doesn't need a `get_saga` round-trip
 * unless it wants notes.
 */
import { z } from 'zod';

import type { ProjectStore } from '../../projects/types.js';
import {
  SAGA_STATUSES,
  type SagaStatus,
  type SagaStore,
} from '../../state/saga-types.js';
import type { ToolRegistration } from '../registry.js';

const DEFAULT_CAP = 200;
const statusLiterals = SAGA_STATUSES as readonly [SagaStatus, ...SagaStatus[]];

const shape = {
  project: z
    .string()
    .optional()
    .describe(
      'Filter to sagas whose members include this project (name or id). Omit to list across all projects.',
    ),
  status: z
    .union([z.enum(statusLiterals), z.array(z.enum(statusLiterals)).min(1)])
    .optional()
    .describe('Filter by saga status (or array of statuses).'),
  limit: z
    .number()
    .int()
    .positive()
    .max(DEFAULT_CAP)
    .optional()
    .describe(`Max sagas returned (1..${DEFAULT_CAP}, default ${DEFAULT_CAP}).`),
};

export interface ListSagasDeps {
  readonly sagaStore: SagaStore;
  readonly projectStore: ProjectStore;
}

export function makeListSagasTool(
  deps: ListSagasDeps,
): ToolRegistration<typeof shape> {
  return {
    name: 'list_sagas',
    description:
      'List cross-project sagas with member rollup. Optionally filtered by status and/or project (filters by membership — a saga matches `project:` if ANY member targets that project). Planning tool — available in PLAN and ACT mode.',
    scope: 'both',
    capabilities: [],
    inputSchema: shape,
    handler: ({ project, status, limit }) => {
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
      const all = deps.sagaStore.snapshots({
        ...(projectId !== undefined ? { projectId } : {}),
        ...(status !== undefined ? { status } : {}),
      });
      const cap = limit ?? DEFAULT_CAP;
      const total = all.length;
      const truncated = total > cap;
      const sagas = truncated ? all.slice(0, cap) : all;
      const text =
        sagas.length === 0
          ? 'No sagas match.'
          : sagas
              .map((s) => {
                const projectsLine = s.members
                  .map((m) => `${m.projectName}:${m.status}`)
                  .join(', ');
                return `- ${s.id} [${s.status}] ${truncate(s.description, 70)} (${projectsLine})`;
              })
              .join('\n');
      return {
        content: [{ type: 'text', text }],
        structuredContent: {
          sagas: sagas as unknown as Record<string, unknown>[],
          total,
          truncated,
        },
      };
    },
  };
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}
