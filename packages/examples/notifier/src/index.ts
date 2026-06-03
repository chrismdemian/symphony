import { appendFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createPlugin } from '@symphony/plugin-sdk';
import { z } from 'zod';

/**
 * Notifier — the reference Symphony plugin.
 *
 * It does two things, one per SDK capability:
 *   1. Subscribes to `onTaskCreated` / `onTaskCompleted` / `onTaskFailed` /
 *      `onWorkerSpawned` and appends a line to a log file (the event-handler
 *      path — the part of the SDK most worth exercising end-to-end, and the
 *      one that dogfoods the Phase 7B.3 create/spawn event sources).
 *   2. Exposes a `notifier_status` tool returning the most recent
 *      notifications it has seen this session. The tool declares a
 *      `task:read` permission (a subset of the manifest's grant), so it
 *      also dogfoods Phase 7B.3's per-tool permission enforcement.
 *
 * The log file is `$SYMPHONY_NOTIFIER_LOG` if set, else
 * `<tmpdir>/symphony-notifier.log`. Everything diagnostic goes to stderr —
 * stdout is the MCP channel and MUST NOT be written to directly.
 */

const LOG_PATH =
  process.env['SYMPHONY_NOTIFIER_LOG']?.trim() ||
  path.join(os.tmpdir(), 'symphony-notifier.log');

type NotificationKind = 'created' | 'completed' | 'failed' | 'spawned';

interface Notification {
  readonly at: string;
  readonly kind: NotificationKind;
  /** Task id (task events) or worker id (worker events). */
  readonly subject: string;
  readonly projectId: string | null;
}

const recent: Notification[] = [];
const MAX_RECENT = 50;

function record(kind: NotificationKind, subject: string, projectId: string | null): void {
  // ISO timestamp without Date.now()/argless new Date() concerns — this is
  // a standalone plugin process, not a Symphony workflow script.
  const at = new Date().toISOString();
  const entry: Notification = { at, kind, subject, projectId };
  recent.push(entry);
  if (recent.length > MAX_RECENT) recent.shift();
  const line = `${at}\t${kind}\tsubject=${subject}\tproject=${projectId ?? '(none)'}\n`;
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
      'Return the most recent task/worker notifications this plugin has observed this session, newest last.',
    // Phase 7B.3 — declares the manifest permission this tool needs. A
    // subset of the plugin's granted permissions, so the host registers it.
    permissions: ['task:read'],
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
            ? 'No notifications yet.'
            : slice.map((e) => `${e.at}  ${e.kind}  ${e.subject}`).join('\n'),
        structuredContent: { count: slice.length, notifications: slice, logPath: LOG_PATH },
      };
    },
  })
  .onTaskCreated((e) => {
    record('created', e.taskId, e.projectId);
  })
  .onTaskCompleted((e) => {
    record('completed', e.taskId, e.projectId);
  })
  .onTaskFailed((e) => {
    record('failed', e.taskId, e.projectId);
  })
  .onWorkerSpawned((e) => {
    record('spawned', e.workerId, e.projectId);
  })
  .serve();

process.stderr.write(`[notifier] serving — logging task notifications to ${LOG_PATH}\n`);
