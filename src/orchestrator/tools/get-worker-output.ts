import { z } from 'zod';
import type { ToolRegistration } from '../registry.js';
import type { StreamEvent } from '../../workers/types.js';
import type { WorkerRegistry } from '../worker-registry.js';

const shape = {
  worker_id: z.string().min(1).describe('Worker id returned by spawn_worker.'),
  lines: z
    .number()
    .int()
    .min(1)
    .max(500)
    .optional()
    .describe('Tail the most recent N stream events (default 50, max 500).'),
};

export interface GetWorkerOutputDeps {
  readonly registry: WorkerRegistry;
}

function formatEvent(ev: StreamEvent): string {
  switch (ev.type) {
    case 'system_init':
      return `[system_init] session=${ev.sessionId}${ev.model ? ` model=${ev.model}` : ''}`;
    case 'assistant_text':
      return `[assistant] ${ev.text}`;
    case 'assistant_thinking':
      return `[thinking] ${ev.text}`;
    case 'tool_use':
      return `[tool_use] ${ev.name} (${ev.callId})`;
    case 'tool_result':
      return `[tool_result] ${ev.callId} ${ev.isError ? '(error) ' : ''}${ev.content}`;
    case 'result':
      return `[result] isError=${ev.isError} turns=${ev.numTurns} duration=${ev.durationMs}ms`;
    case 'log':
      return `[log:${ev.level}] ${ev.message}`;
    case 'structured_completion':
      return `[completion] audit=${ev.report.audit} did=${ev.report.did.length}`;
    case 'parse_error':
      return `[parse_error] ${ev.reason}`;
    case 'system_api_retry':
      return `[api_retry] attempt=${ev.attempt ?? '?'} delay=${ev.delayMs ?? '?'}ms`;
    case 'system':
      return `[system:${ev.subtype}]`;
    case 'control_request':
      return `[control_request] ${ev.subtype} ${ev.toolName}`;
  }
}

export function makeGetWorkerOutputTool(
  deps: GetWorkerOutputDeps,
): ToolRegistration<typeof shape> {
  return {
    name: 'get_worker_output',
    description:
      'Return the most recent stream events (tool calls, assistant text, results) from a worker. Use to monitor progress without resuming the worker.',
    scope: 'act',
    capabilities: [],
    inputSchema: shape,
    handler: ({ worker_id, lines }) => {
      const record = deps.registry.get(worker_id);
      if (!record) {
        return {
          content: [{ type: 'text', text: `Unknown worker '${worker_id}'.` }],
          isError: true,
        };
      }
      const n = lines ?? 50;
      const events = record.buffer.tail(n);
      const formatted = events.map(formatEvent).join('\n');
      const header = `Worker ${worker_id} [${record.status}] — ${events.length}/${record.buffer.total()} events\n`;
      return {
        content: [{ type: 'text', text: header + formatted }],
        structuredContent: {
          worker_id,
          status: record.status,
          returned: events.length,
          total: record.buffer.total(),
          events: events as unknown as Record<string, unknown>[],
        },
      };
    },
  };
}
