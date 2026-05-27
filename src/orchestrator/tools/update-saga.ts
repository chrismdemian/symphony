/**
 * Phase 5E — `update_saga` MCP tool.
 *
 * Maestro's hook for explicit saga status changes (cancellation, explicit
 * failure annotation) + note appends. The rollup writer handles automatic
 * transitions on member task changes; this tool covers the cases the
 * rollup can't infer — e.g. user pivots and cancels the saga before its
 * members all complete.
 *
 * The status transitions follow the same `SagaStatus` state machine as
 * the rollup writer; `update_saga(status='completed')` is rejected when
 * members are incomplete (the rollup is authoritative for completion).
 */
import { z } from 'zod';

import {
  isTerminalSagaStatus,
  SAGA_STATUSES,
  type SagaStatus,
  type SagaStore,
} from '../../state/saga-types.js';
import type { ToolRegistration } from '../registry.js';

const statusLiterals = SAGA_STATUSES as readonly [SagaStatus, ...SagaStatus[]];

const shape = {
  saga_id: z
    .string()
    .min(1)
    .describe('The saga id returned by `create_saga`.'),
  status: z
    .enum(statusLiterals)
    .optional()
    .describe(
      'Optional new status. The rollup writer drives automatic transitions; use this for explicit cancellation/failure annotation. `completed` is rejected unless every member is already `completed` — call this AFTER finalizing every member.',
    ),
  notes: z
    .string()
    .optional()
    .describe('Optional note text. Trimmed; blank notes are no-ops.'),
  result: z
    .string()
    .optional()
    .describe(
      'Optional free-form result text — surfaces in `list_sagas` / `get_saga` for saga-completion context.',
    ),
};

export interface UpdateSagaDeps {
  readonly sagaStore: SagaStore;
}

export function makeUpdateSagaTool(
  deps: UpdateSagaDeps,
): ToolRegistration<typeof shape> {
  return {
    name: 'update_saga',
    description:
      'Explicitly transition a saga or append a note/result. The rollup writer handles automatic transitions on member changes — use this tool for cancellation, explicit failure annotation, or note tracking. `update_saga(status="completed")` rejects when members are incomplete (the rollup is authoritative for completion). Planning tool — available in PLAN and ACT mode.',
    scope: 'both',
    capabilities: [],
    inputSchema: shape,
    handler: ({ saga_id, status, notes, result }) => {
      const existing = deps.sagaStore.get(saga_id);
      if (existing === undefined) {
        return errorResult(`update_saga: unknown saga '${saga_id}'.`);
      }
      // Block `update_saga(status='completed')` unless every member is
      // already completed — the rollup writer is the only path to
      // legitimate completion.
      if (status === 'completed') {
        const members = deps.sagaStore.listMembers(saga_id);
        const incomplete = members.filter((m) => m.status !== 'completed');
        if (incomplete.length > 0) {
          return errorResult(
            `update_saga: saga '${saga_id}' has ${incomplete.length} non-completed member(s). The rollup writer transitions to 'completed' automatically when all members complete — don't force it.`,
          );
        }
      }
      try {
        const updated = deps.sagaStore.update(saga_id, {
          ...(status !== undefined ? { status } : {}),
          ...(notes !== undefined ? { notes } : {}),
          ...(result !== undefined ? { result } : {}),
        });
        const snap = deps.sagaStore.snapshot(saga_id)!;
        const tail = isTerminalSagaStatus(updated.status)
          ? ` (terminal)`
          : '';
        return {
          content: [
            {
              type: 'text',
              text: `Saga ${saga_id} → ${updated.status}${tail}.`,
            },
          ],
          structuredContent: { saga: snap as unknown as Record<string, unknown> },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return errorResult(`update_saga failed: ${msg}`);
      }
    },
  };
}

function errorResult(text: string): ReturnType<
  NonNullable<ToolRegistration<typeof shape>['handler']>
> {
  return {
    content: [{ type: 'text', text }],
    isError: true,
  };
}
