/**
 * Phase 5E — `get_saga` MCP tool. Returns the full saga snapshot
 * including members + notes. Maestro polls this when tracking saga
 * progress.
 */
import { z } from 'zod';

import type { SagaStore } from '../../state/saga-types.js';
import type { ToolRegistration } from '../registry.js';

const shape = {
  saga_id: z
    .string()
    .min(1)
    .describe('The saga id returned by `create_saga`.'),
};

export interface GetSagaDeps {
  readonly sagaStore: SagaStore;
}

export function makeGetSagaTool(deps: GetSagaDeps): ToolRegistration<typeof shape> {
  return {
    name: 'get_saga',
    description:
      'Fetch one saga snapshot including its members + notes. Planning tool — available in PLAN and ACT mode. Maestro polls this while members are in flight to decide when to surface a rollup row to the user.',
    scope: 'both',
    capabilities: [],
    inputSchema: shape,
    handler: ({ saga_id }) => {
      const snap = deps.sagaStore.snapshot(saga_id);
      if (snap === undefined) {
        return {
          content: [{ type: 'text', text: `get_saga: unknown saga '${saga_id}'.` }],
          isError: true,
        };
      }
      const memberLines = snap.members
        .map(
          (m) =>
            `  - ${m.taskId} (${m.projectName}) [${m.status}]`,
        )
        .join('\n');
      const text = [
        `${snap.id} [${snap.status}] — ${snap.description}`,
        snap.result !== undefined ? `Result: ${snap.result}` : null,
        snap.members.length > 0 ? `Members:\n${memberLines}` : 'Members: (none)',
        snap.notes.length > 0 ? `Notes: ${snap.notes.length} entry(ies)` : null,
      ]
        .filter((s): s is string => s !== null)
        .join('\n');
      return {
        content: [{ type: 'text', text }],
        structuredContent: { saga: snap as unknown as Record<string, unknown> },
      };
    },
  };
}
