import { z } from 'zod';
import type { ToolRegistration } from '../registry.js';
import type { WorkerLifecycleHandle } from '../worker-lifecycle.js';
import { toSnapshot, type WorkerRegistry } from '../worker-registry.js';

const shape = {
  worker_id: z.string().min(1).describe('Terminal worker id to resume.'),
  message: z.string().min(1).describe('New user message to start the resumed turn.'),
};

export interface ResumeWorkerDeps {
  readonly registry: WorkerRegistry;
  readonly lifecycle: WorkerLifecycleHandle;
}

export function makeResumeWorkerTool(deps: ResumeWorkerDeps): ToolRegistration<typeof shape> {
  return {
    name: 'resume_worker',
    description:
      'Re-spawn a terminal worker in its existing worktree with its prior session id. Fails if the worker is still running — use send_to_worker instead.',
    scope: 'act',
    capabilities: [],
    inputSchema: shape,
    handler: async ({ worker_id, message }) => {
      const record = deps.registry.get(worker_id);
      if (!record) {
        return {
          content: [{ type: 'text', text: `Unknown worker '${worker_id}'.` }],
          isError: true,
        };
      }
      if (record.status === 'running' || record.status === 'spawning') {
        return {
          content: [
            {
              type: 'text',
              text: `Worker '${worker_id}' is ${record.status}; use send_to_worker for live workers.`,
            },
          ],
          isError: true,
        };
      }
      try {
        const resumed = await deps.lifecycle.resume({ recordId: worker_id, message });
        const snap = toSnapshot(resumed);
        return {
          content: [
            {
              type: 'text',
              text: `Resumed worker ${worker_id} (prior session ${snap.sessionId ?? 'fresh'}).`,
            },
          ],
          structuredContent: snap as unknown as Record<string, unknown>,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text', text: `resume_worker failed: ${msg}` }],
          isError: true,
        };
      }
    },
  };
}
