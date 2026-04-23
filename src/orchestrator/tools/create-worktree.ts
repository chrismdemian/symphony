import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { ProjectStore } from '../../projects/types.js';
import type { WorktreeManager } from '../../worktree/manager.js';
import type { ToolRegistration } from '../registry.js';

const shape = {
  project_name: z.string().min(1).describe('Project name or id (not a path).'),
  branch: z
    .string()
    .optional()
    .describe('Base branch/commit/ref to fork the worktree from. Defaults to the project HEAD.'),
  short_description: z
    .string()
    .max(80)
    .optional()
    .describe(
      'Short human-readable description. Becomes part of the worktree branch name (slugified).',
    ),
};

function generateWorktreeId(): string {
  return `wt-${randomBytes(4).toString('hex')}`;
}

export interface CreateWorktreeDeps {
  readonly store: ProjectStore;
  readonly worktreeManager: WorktreeManager;
  readonly idGenerator?: () => string;
}

export function makeCreateWorktreeTool(
  deps: CreateWorktreeDeps,
): ToolRegistration<typeof shape> {
  const genId = deps.idGenerator ?? generateWorktreeId;
  return {
    name: 'create_worktree',
    description:
      'Manually create an isolated git worktree for a project without spawning a worker. Use when Maestro wants a staging area it will inspect, diff, or populate before later calling spawn_worker. ACT mode only — touches disk.',
    scope: 'act',
    capabilities: [],
    inputSchema: shape,
    handler: async ({ project_name, branch, short_description }, ctx) => {
      const project = deps.store.get(project_name);
      if (!project) {
        return {
          content: [{ type: 'text', text: `Unknown project '${project_name}'.` }],
          isError: true,
        };
      }
      if (ctx.signal?.aborted) {
        return {
          content: [{ type: 'text', text: 'create_worktree aborted before worktree creation.' }],
          isError: true,
        };
      }
      const workerId = genId();
      try {
        const info = await deps.worktreeManager.create({
          projectPath: project.path,
          workerId,
          ...(branch !== undefined ? { baseRef: branch } : {}),
          ...(short_description !== undefined
            ? { shortDescription: short_description }
            : {}),
          ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
        });
        return {
          content: [
            {
              type: 'text',
              text: `Worktree ${info.id} created at ${info.path} (branch ${info.branch} from ${info.baseRef}).`,
            },
          ],
          structuredContent: {
            worktree: info as unknown as Record<string, unknown>,
            project: { id: project.id, name: project.name },
          },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text', text: `create_worktree failed: ${msg}` }],
          isError: true,
        };
      }
    },
  };
}
