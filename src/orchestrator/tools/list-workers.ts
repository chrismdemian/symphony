import { z } from 'zod';
import type { ToolRegistration } from '../registry.js';
import type { WorkerRegistry } from '../worker-registry.js';

const shape = {
  project: z
    .string()
    .optional()
    .describe('Filter to this project (name or absolute path). Omit to list all workers.'),
};

export interface ListWorkersDeps {
  readonly registry: WorkerRegistry;
  readonly resolveProjectPath: (project?: string) => string | undefined;
}

export function makeListWorkersTool(deps: ListWorkersDeps): ToolRegistration<typeof shape> {
  return {
    name: 'list_workers',
    description:
      'List all workers with status + feature intent. Used by Maestro to answer "where was I?" and to decide what to spawn next.',
    scope: 'act',
    capabilities: [],
    inputSchema: shape,
    handler: ({ project }) => {
      const filterPath = project !== undefined ? deps.resolveProjectPath(project) : undefined;
      const snaps = deps.registry.snapshots(
        filterPath !== undefined ? { projectPath: filterPath } : {},
      );
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
