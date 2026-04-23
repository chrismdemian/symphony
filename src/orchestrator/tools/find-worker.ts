import { z } from 'zod';
import type { ToolRegistration } from '../registry.js';
import type { WorkerRegistry } from '../worker-registry.js';

const shape = {
  description: z
    .string()
    .min(1)
    .describe(
      'Natural-language reference to a worker ("the auth one", "the play bar fix"). Matched against worker id + feature intent.',
    ),
};

export interface FindWorkerDeps {
  readonly registry: WorkerRegistry;
}

export function makeFindWorkerTool(deps: FindWorkerDeps): ToolRegistration<typeof shape> {
  return {
    name: 'find_worker',
    description:
      'Resolve a natural-language reference to one or more workers by substring match against their feature intent or id. Returns an empty matches list if nothing hit.',
    scope: 'act',
    capabilities: [],
    inputSchema: shape,
    handler: ({ description }) => {
      const matches = deps.registry.find(description);
      if (matches.length === 0) {
        return {
          content: [{ type: 'text', text: `No workers matched "${description}".` }],
          structuredContent: { matches: [] },
        };
      }
      const text = matches
        .map((m) => `- ${m.id} [${m.status}] ${m.role}/${m.featureIntent} (via ${m.matchedBy})`)
        .join('\n');
      return {
        content: [{ type: 'text', text }],
        structuredContent: { matches: matches as unknown as Record<string, unknown>[] },
      };
    },
  };
}
