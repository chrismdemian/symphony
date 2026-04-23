import { z } from 'zod';
import type { ProjectStore } from '../../projects/types.js';
import type { ToolRegistration } from '../registry.js';
import type { WorkerRegistry } from '../worker-registry.js';

const shape = {
  project_name: z
    .string()
    .min(1)
    .describe('Project name or id. Absolute paths are rejected — use list_projects first.'),
};

export interface GetProjectInfoDeps {
  readonly store: ProjectStore;
  readonly workerRegistry: WorkerRegistry;
}

export function makeGetProjectInfoTool(
  deps: GetProjectInfoDeps,
): ToolRegistration<typeof shape> {
  return {
    name: 'get_project_info',
    description:
      'Return detail for a single project: path, git branch, base ref, remote, and a count of registered workers. Planning tool — available in PLAN and ACT mode.',
    scope: 'both',
    capabilities: [],
    inputSchema: shape,
    handler: ({ project_name }) => {
      const snap = deps.store.snapshot(project_name);
      if (!snap) {
        return {
          content: [{ type: 'text', text: `Unknown project '${project_name}'.` }],
          isError: true,
        };
      }
      const workers = deps.workerRegistry.snapshots({ projectPath: snap.path });
      const activeCount = workers.filter(
        (w) => w.status === 'running' || w.status === 'spawning',
      ).length;
      const text = [
        `${snap.name} @ ${snap.path}`,
        snap.gitBranch ? `branch: ${snap.gitBranch}` : undefined,
        snap.baseRef ? `baseRef: ${snap.baseRef}` : undefined,
        snap.gitRemote ? `remote: ${snap.gitRemote}` : undefined,
        snap.defaultModel ? `defaultModel: ${snap.defaultModel}` : undefined,
        `workers: ${workers.length} total, ${activeCount} active`,
      ]
        .filter((line): line is string => line !== undefined)
        .join('\n');
      return {
        content: [{ type: 'text', text }],
        structuredContent: {
          project: snap as unknown as Record<string, unknown>,
          workers: {
            total: workers.length,
            active: activeCount,
          },
        },
      };
    },
  };
}
