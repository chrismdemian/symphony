/**
 * Phase 5C — `task_notes` MCP tool.
 *
 * Maestro reads/writes task progress notes through this tool instead of
 * the bulky `update_task(notes:)` + `list_tasks` flow. Goals:
 *
 *  - `append(task_id, text)` — same effect as `update_task notes:` but
 *    explicit + tightly scoped. `task-registry.ts` / `sqlite-task-store.ts`
 *    fire `onNotesAppended` which the server wires to the disk mirror
 *    (`task-notes-mirror.ts`). 64 KB cap (2B.2 audit-m7 parity) enforced
 *    here BEFORE SQL.
 *  - `read(task_id, since?, limit?)` — returns ONE task's notes as a
 *    single markdown blob (matches the disk mirror's format). Caller
 *    pulls per-task context without flooding via `list_tasks`.
 *  - `list(project?)` — per-task summary `{task_id, count, firstAt, lastAt}`
 *    so Maestro can decide WHICH tasks to read without payload bloat.
 *
 * Source of truth: SQL `tasks.notes` JSON column. Disk mirror is a
 * one-way fan-out from the store's `onNotesAppended` callback.
 */
import { z } from 'zod';

import type { ProjectStore } from '../../projects/types.js';
import {
  filterNotesSince,
  formatNotesAsMarkdown,
} from '../../state/task-notes-format.js';
import type { TaskNote, TaskStore } from '../../state/types.js';
import {
  UnknownTaskError,
} from '../../state/types.js';
import type { ToolRegistration } from '../registry.js';

/** 64 KB cap — parity with `tasks.update.patch.notes` (2B.2 audit-m7). */
const NOTE_BYTE_CAP = 64 * 1024;
const DEFAULT_LIST_PROJECT_CAP = 500;

const shape = {
  action: z
    .enum(['append', 'read', 'list'])
    .describe(
      'append: write a new progress note. read: return one task\'s notes as a markdown blob. list: summary of which tasks have notes.',
    ),
  task_id: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Required for append + read; ignored for list. Identifies the task whose notes are being mutated/read.',
    ),
  text: z
    .string()
    .optional()
    .describe(
      'Required for append. The progress note body (trimmed). Blank/whitespace-only text is rejected (mirrors update_task notes:). 64 KB max.',
    ),
  since: z
    .string()
    .optional()
    .describe(
      'read only. ISO-8601 timestamp; only notes with `at >= since` are returned. Bad timestamps fall through and return the full set (drop-philosophy).',
    ),
  limit: z
    .number()
    .int()
    .positive()
    .max(10000)
    .optional()
    .describe(
      'read only. Cap on number of notes returned (most recent N). Default: all matching notes.',
    ),
  project: z
    .string()
    .min(1)
    .optional()
    .describe(
      'list only. Filter summary by project name or id. Omit to summarize across every project.',
    ),
};

export interface TaskNotesDeps {
  readonly taskStore: TaskStore;
  readonly projectStore: ProjectStore;
}

export function makeTaskNotesTool(deps: TaskNotesDeps): ToolRegistration<typeof shape> {
  return {
    name: 'task_notes',
    description:
      'Append/read/list progress notes for tasks. Externalizes context out of Maestro\'s window — write notes here instead of carrying them in conversation. Source of truth: SQLite. Disk mirror at <project>/.symphony/tasks/<task-id>/notes.md so workers in worktrees can Read prior context. Read returns ONE task as a single markdown blob (vs list_tasks which lists every task).',
    scope: 'both',
    capabilities: [],
    inputSchema: shape,
    handler: ({ action, task_id, text, since, limit, project }) => {
      if (action === 'append') {
        return handleAppend(deps, task_id, text);
      }
      if (action === 'read') {
        return handleRead(deps, task_id, since, limit);
      }
      return handleList(deps, project);
    },
  };
}

function handleAppend(
  deps: TaskNotesDeps,
  taskId: string | undefined,
  text: string | undefined,
): ReturnType<NonNullable<ToolRegistration<typeof shape>['handler']>> {
  if (taskId === undefined) {
    return errorResult('task_notes append requires task_id.');
  }
  if (text === undefined) {
    return errorResult('task_notes append requires text.');
  }
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return errorResult('task_notes append: text must be non-empty after trim.');
  }
  if (Buffer.byteLength(trimmed, 'utf8') > NOTE_BYTE_CAP) {
    return errorResult(
      `task_notes append: text exceeds 64 KB cap (got ${Buffer.byteLength(trimmed, 'utf8')} bytes).`,
    );
  }
  try {
    const updated = deps.taskStore.update(taskId, { notes: trimmed });
    const newNote = updated.notes[updated.notes.length - 1];
    if (newNote === undefined) {
      // Defensive: trim was non-empty above so this branch is
      // unreachable. Keep the typed error for noUncheckedIndexedAccess.
      return errorResult('task_notes append: post-update notes array empty.');
    }
    return {
      content: [
        {
          type: 'text',
          text: `Appended note to ${taskId} at ${newNote.at} (${updated.notes.length} total).`,
        },
      ],
      structuredContent: {
        taskId,
        note: { ...newNote } as Record<string, unknown>,
        total: updated.notes.length,
      },
    };
  } catch (err) {
    if (err instanceof UnknownTaskError) {
      return errorResult(`Unknown task '${err.taskId}'.`);
    }
    const msg = err instanceof Error ? err.message : String(err);
    return errorResult(`task_notes append failed: ${msg}`);
  }
}

function handleRead(
  deps: TaskNotesDeps,
  taskId: string | undefined,
  since: string | undefined,
  limit: number | undefined,
): ReturnType<NonNullable<ToolRegistration<typeof shape>['handler']>> {
  if (taskId === undefined) {
    return errorResult('task_notes read requires task_id.');
  }
  const snap = deps.taskStore.snapshot(taskId);
  if (snap === undefined) {
    return errorResult(`Unknown task '${taskId}'.`);
  }
  const filtered = filterNotesSince(snap.notes, since);
  // Apply limit AFTER since filter — caller's intent is "give me the
  // last N matching notes" not "the last N of all-time, then filter".
  const capped: TaskNote[] =
    limit !== undefined && limit < filtered.length
      ? filtered.slice(filtered.length - limit)
      : filtered.slice();
  const truncated = capped.length < filtered.length;
  const blob = formatNotesAsMarkdown(capped);
  const body = blob.length > 0 ? blob : `(no notes for ${taskId}${since !== undefined ? ` since ${since}` : ''})`;
  return {
    content: [{ type: 'text', text: body }],
    structuredContent: {
      taskId,
      total: snap.notes.length,
      returned: capped.length,
      truncated,
      ...(since !== undefined ? { since } : {}),
      notes: capped.map((n) => ({ at: n.at, text: n.text })) as unknown as Record<
        string,
        unknown
      >[],
    },
  };
}

function handleList(
  deps: TaskNotesDeps,
  project: string | undefined,
): ReturnType<NonNullable<ToolRegistration<typeof shape>['handler']>> {
  let projectId: string | undefined;
  if (project !== undefined) {
    const proj = deps.projectStore.get(project);
    if (!proj) {
      return errorResult(`Unknown project '${project}'.`);
    }
    projectId = proj.id;
  }
  const snapshots = deps.taskStore.snapshots(
    projectId !== undefined ? { projectId } : {},
  );
  type Summary = {
    readonly taskId: string;
    readonly projectId: string;
    readonly count: number;
    readonly firstAt: string | null;
    readonly lastAt: string | null;
  };
  const summaries: Summary[] = [];
  for (const snap of snapshots) {
    if (snap.notes.length === 0) continue;
    summaries.push({
      taskId: snap.id,
      projectId: snap.projectId,
      count: snap.notes.length,
      firstAt: snap.notes[0]!.at,
      lastAt: snap.notes[snap.notes.length - 1]!.at,
    });
    if (summaries.length >= DEFAULT_LIST_PROJECT_CAP) break;
  }
  const text =
    summaries.length === 0
      ? project !== undefined
        ? `No tasks with notes in project '${project}'.`
        : 'No tasks with notes.'
      : summaries
          .map(
            (s) =>
              `- ${s.taskId} (${s.projectId}) ${s.count} note${s.count === 1 ? '' : 's'} · last ${s.lastAt}`,
          )
          .join('\n');
  return {
    content: [{ type: 'text', text }],
    structuredContent: {
      summaries: summaries as unknown as Record<string, unknown>[],
      total: summaries.length,
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
