import { appendFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createPlugin } from '@symphony/plugin-sdk';
import { z } from 'zod';

/**
 * Notifier — the reference Symphony plugin.
 *
 * It does two things, one per SDK capability:
 *   1. Subscribes to `onTaskCompleted` / `onTaskFailed` and appends a line
 *      to a log file (the event-handler path — the part of the SDK most
 *      worth exercising end-to-end).
 *   2. Exposes a `notifier_status` tool returning the most recent
 *      notifications it has seen this session (the tool path).
 *
 * The log file is `$SYMPHONY_NOTIFIER_LOG` if set, else
 * `<tmpdir>/symphony-notifier.log`. Everything diagnostic goes to stderr —
 * stdout is the MCP channel and MUST NOT be written to directly.
 */

const LOG_PATH =
  process.env['SYMPHONY_NOTIFIER_LOG']?.trim() ||
  path.join(os.tmpdir(), 'symphony-notifier.log');

interface Notification {
  readonly at: string;
  readonly kind: 'completed' | 'failed';
  readonly taskId: string;
  readonly projectId: string | null;
}

const recent: Notification[] = [];
const MAX_RECENT = 50;

function record(kind: 'completed' | 'failed', taskId: string, projectId: string | null): void {
  // ISO timestamp without Date.now()/argless new Date() concerns — this is
  // a standalone plugin process, not a Symphony workflow script.
  const at = new Date().toISOString();
  const entry: Notification = { at, kind, taskId, projectId };
  recent.push(entry);
  if (recent.length > MAX_RECENT) recent.shift();
  const line = `${at}\t${kind}\ttask=${taskId}\tproject=${projectId ?? '(none)'}\n`;
  try {
    appendFileSync(LOG_PATH, line, 'utf8');
  } catch (err) {
    process.stderr.write(`[notifier] failed to append to ${LOG_PATH}: ${String(err)}\n`);
  }
}

await createPlugin({ id: 'notifier-example', name: 'Notifier (example)', version: '0.1.0' })
  .tool({
    name: 'notifier_status',
    description:
      'Return the most recent task-completion notifications this plugin has observed this session, newest last.',
    inputSchema: {
      limit: z
        .number()
        .int()
        .min(1)
        .max(MAX_RECENT)
        .optional()
        .describe('How many recent notifications to return (default 10).'),
    },
    handler: ({ limit }) => {
      const n = limit ?? 10;
      const slice = recent.slice(-n);
      return {
        text:
          slice.length === 0
            ? 'No task notifications yet.'
            : slice.map((e) => `${e.at}  ${e.kind}  task ${e.taskId}`).join('\n'),
        structuredContent: { count: slice.length, notifications: slice, logPath: LOG_PATH },
      };
    },
  })
  .onTaskCompleted((e) => {
    record('completed', e.taskId, e.projectId);
  })
  .onTaskFailed((e) => {
    record('failed', e.taskId, e.projectId);
  })
  .serve();

process.stderr.write(`[notifier] serving — logging task notifications to ${LOG_PATH}\n`);
