import { z } from 'zod';
import { toTaskSnapshot } from '../../state/task-registry.js';
import {
  InvalidTaskTransitionError,
  TASK_STATUSES,
  UnknownTaskError,
  type TaskStatus,
  type TaskStore,
} from '../../state/types.js';
import type { ToolRegistration } from '../registry.js';

const statusLiterals = TASK_STATUSES as readonly [TaskStatus, ...TaskStatus[]];

const shape = {
  task_id: z.string().min(1).describe('Task id to update.'),
  status: z.enum(statusLiterals).optional().describe('New status (validated against state machine).'),
  notes: z.string().optional().describe('Append-only note (ignored if blank after trim).'),
  worker_id: z
    .string()
    .optional()
    .describe('Associate/replace the worker id currently executing this task.'),
  result: z.string().optional().describe('Free-form result summary (usually terminal states).'),
};

export interface UpdateTaskDeps {
  readonly taskStore: TaskStore;
}

export function makeUpdateTaskTool(deps: UpdateTaskDeps): ToolRegistration<typeof shape> {
  return {
    name: 'update_task',
    description:
      'Update a task. Status transitions are validated: pending -> {in_progress, cancelled, failed}; in_progress -> {completed, failed, cancelled}; terminal states reject further status changes. Notes append; worker_id and result overwrite.',
    scope: 'both',
    capabilities: [],
    inputSchema: shape,
    handler: ({ task_id, status, notes, worker_id, result }) => {
      if (
        status === undefined &&
        notes === undefined &&
        worker_id === undefined &&
        result === undefined
      ) {
        return {
          content: [
            {
              type: 'text',
              text: 'update_task requires at least one of: status, notes, worker_id, result.',
            },
          ],
          isError: true,
        };
      }
      try {
        const updated = deps.taskStore.update(task_id, {
          ...(status !== undefined ? { status } : {}),
          ...(notes !== undefined ? { notes } : {}),
          ...(worker_id !== undefined ? { workerId: worker_id } : {}),
          ...(result !== undefined ? { result } : {}),
        });
        const snap = toTaskSnapshot(updated);
        return {
          content: [
            {
              type: 'text',
              text: `Task ${snap.id} updated → [${snap.status}]${snap.completedAt ? ` @ ${snap.completedAt}` : ''}.`,
            },
          ],
          structuredContent: snap as unknown as Record<string, unknown>,
        };
      } catch (err) {
        if (err instanceof UnknownTaskError) {
          return {
            content: [{ type: 'text', text: `Unknown task '${err.taskId}'.` }],
            isError: true,
          };
        }
        if (err instanceof InvalidTaskTransitionError) {
          return {
            content: [
              {
                type: 'text',
                text: `Invalid transition: ${err.from} → ${err.to}.`,
              },
            ],
            isError: true,
          };
        }
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text', text: `update_task failed: ${msg}` }],
          isError: true,
        };
      }
    },
  };
}
