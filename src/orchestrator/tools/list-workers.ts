import { z } from 'zod';
import type { ProjectStore } from '../../projects/types.js';
import type { ToolRegistration } from '../registry.js';
import { mergeLiveAndPersisted, type WorkerRegistry } from '../worker-registry.js';

const shape = {
  project: z
    .string()
    .optional()
    .describe('Filter to this project (name or absolute path). Omit to list all workers.'),
  include_terminal: z
    .boolean()
    .optional()
    .describe(
      'Include terminal (completed/failed/killed/timeout/crashed) workers from persistent storage. Default true — answers "where was I?" across orchestrator restarts.',
    ),
};

export interface ListWorkersDeps {
  readonly registry: WorkerRegistry;
  readonly resolveProjectPath: (project?: string) => string | undefined;
  /**
   * Phase 2B.1b — used to map persisted `projectId` back to a path so
   * callers see persisted-only crashed workers in `list_workers`.
   */
  readonly projectStore?: ProjectStore;
}

export function makeListWorkersTool(deps: ListWorkersDeps): ToolRegistration<typeof shape> {
  return {
    name: 'list_workers',
    description:
      'List all workers with status + feature intent. Used by Maestro to answer "where was I?" and to decide what to spawn next. Includes persisted terminal workers by default.',
    scope: 'act',
    capabilities: [],
    inputSchema: shape,
    handler: ({ project, include_terminal }) => {
      const filterPath = project !== undefined ? deps.resolveProjectPath(project) : undefined;
      const includeTerminal = include_terminal ?? true;
      const snaps = mergeLiveAndPersisted(deps.registry, {
        ...(deps.projectStore !== undefined ? { projectStore: deps.projectStore } : {}),
        ...(filterPath !== undefined ? { projectPath: filterPath } : {}),
        includeTerminal,
      });
      const summary = snaps.length === 0
        ? 'No workers registered.'
        : snaps
            .map((s) => `- ${s.id} [${s.status}] ${s.role}/${s.featureIntent} — ${s.worktreePath}`)
            .join('\n');
      return {
        content: [{ type: 'text', text: summary }],
        structuredContent: { workers: snaps as unknown as Record<string, unknown>[] },
      };
    },
  };
}
