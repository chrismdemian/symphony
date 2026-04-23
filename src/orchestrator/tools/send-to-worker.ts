import { z } from 'zod';
import type { ToolRegistration } from '../registry.js';
import type { WorkerRegistry } from '../worker-registry.js';

const shape = {
  worker_id: z.string().min(1).describe('Worker id to address.'),
  message: z.string().min(1).describe('Follow-up message to append to the worker conversation.'),
};

export interface SendToWorkerDeps {
  readonly registry: WorkerRegistry;
}

export function makeSendToWorkerTool(deps: SendToWorkerDeps): ToolRegistration<typeof shape> {
  return {
    name: 'send_to_worker',
    description:
      'Append a follow-up message to a running worker (multi-turn). Fails if the worker is not running; use resume_worker for terminal workers.',
    scope: 'act',
    capabilities: [],
    inputSchema: shape,
    handler: ({ worker_id, message }) => {
      const record = deps.registry.get(worker_id);
      if (!record) {
        return {
          content: [{ type: 'text', text: `Unknown worker '${worker_id}'.` }],
          isError: true,
        };
      }
      if (record.status !== 'running') {
        return {
          content: [
            {
              type: 'text',
              text: `Worker '${worker_id}' is ${record.status}; use resume_worker for terminal workers or wait for status=running.`,
            },
          ],
          isError: true,
        };
      }
      try {
        record.worker.sendFollowup(message);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text', text: `send_to_worker failed: ${msg}` }],
          isError: true,
        };
      }
      return {
        content: [{ type: 'text', text: `Message sent to ${worker_id}.` }],
        structuredContent: { worker_id, bytes: message.length },
      };
    },
  };
}
