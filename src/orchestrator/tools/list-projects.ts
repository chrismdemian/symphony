import { z } from 'zod';
import type { ProjectStore } from '../../projects/types.js';
import type { ToolRegistration } from '../registry.js';

const DEFAULT_CAP = 500;

const shape = {
  name_contains: z
    .string()
    .optional()
    .describe('Substring filter on project name (case-insensitive).'),
  limit: z
    .number()
    .int()
    .positive()
    .max(DEFAULT_CAP)
    .optional()
    .describe(`Max records returned (1..${DEFAULT_CAP}, default ${DEFAULT_CAP}).`),
};

export interface ListProjectsDeps {
  readonly store: ProjectStore;
}

export function makeListProjectsTool(deps: ListProjectsDeps): ToolRegistration<typeof shape> {
  return {
    name: 'list_projects',
    description:
      'List all projects registered with Symphony. Planning tool — available in PLAN and ACT mode.',
    scope: 'both',
    capabilities: [],
    inputSchema: shape,
    handler: ({ name_contains, limit }) => {
      const cap = limit ?? DEFAULT_CAP;
      const all = deps.store.snapshots(
        name_contains !== undefined ? { nameContains: name_contains } : {},
      );
      const total = all.length;
      const truncated = total > cap;
      const projects = truncated ? all.slice(0, cap) : all;
      const text =
        projects.length === 0
          ? 'No projects registered.'
          : projects.map((p) => `- ${p.name} (${p.path})`).join('\n');
      return {
        content: [{ type: 'text', text }],
        structuredContent: {
          projects: projects as unknown as Record<string, unknown>[],
          total,
          truncated,
        },
      };
    },
  };
}
