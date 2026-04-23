import { z } from 'zod';
import type { ToolRegistration } from '../registry.js';
import type { WorkerRegistry } from '../worker-registry.js';

const shape = {
  worker_id: z.string().min(1).describe('Worker id to terminate.'),
  reason: z.string().optional().describe('Free-form explanation (logged, not forwarded).'),
};

export interface KillWorkerDeps {
  readonly registry: WorkerRegistry;
}

export function makeKillWorkerTool(deps: KillWorkerDeps): ToolRegistration<typeof shape> {
  return {
    name: 'kill_worker',
    description:
      'Terminate a running worker (SIGTERM → 8s grace → SIGKILL). Does NOT delete the worktree — preserve diffs for review. finalize owns cleanup.',
    scope: 'act',
    capabilities: [],
    inputSchema: shape,
    handler: ({ worker_id, reason }) => {
      const record = deps.registry.get(worker_id);
      if (!record) {
        return {
          content: [{ type: 'text', text: `Unknown worker '${worker_id}'.` }],
          isError: true,
        };
      }
      const terminal =
        record.status === 'completed' ||
        record.status === 'failed' ||
        record.status === 'killed' ||
        record.status === 'timeout' ||
        record.status === 'crashed';
      if (terminal) {
        return {
          content: [
            {
              type: 'text',
              text: `Worker '${worker_id}' is already ${record.status}; no action.`,
            },
          ],
          structuredContent: { worker_id, status: record.status, skipped: true },
        };
      }
      try {
        record.worker.kill('SIGTERM');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text', text: `kill_worker failed: ${msg}` }],
          isError: true,
        };
      }
      return {
        content: [
          {
            type: 'text',
            text: `Sent SIGTERM to ${worker_id}${reason ? ` (reason: ${reason})` : ''}.`,
          },
        ],
        structuredContent: {
          worker_id,
          previous_status: record.status,
          ...(reason !== undefined ? { reason } : {}),
        },
      };
    },
  };
}
