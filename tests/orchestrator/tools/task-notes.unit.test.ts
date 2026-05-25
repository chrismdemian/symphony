/**
 * Phase 5C — unit coverage for the `task_notes` MCP tool.
 */
import { describe, expect, it } from 'vitest';

import { DEFAULT_DISPATCH_CONTEXT } from '../../../src/orchestrator/capabilities.js';
import type { ToolHandlerReturn } from '../../../src/orchestrator/registry.js';
import { makeTaskNotesTool } from '../../../src/orchestrator/tools/task-notes.js';
import type { DispatchContext } from '../../../src/orchestrator/types.js';
import { ProjectRegistry } from '../../../src/projects/registry.js';
import { TaskRegistry } from '../../../src/state/task-registry.js';

function ctx(overrides: Partial<DispatchContext> = {}): DispatchContext {
  return { ...DEFAULT_DISPATCH_CONTEXT, mode: 'act', ...overrides };
}

function asText(res: ToolHandlerReturn): string {
  return res.content.map((c) => c.text).join('\n');
}

interface TaskNotesArgs {
  action: 'append' | 'read' | 'list';
  task_id?: string;
  text?: string;
  since?: string;
  limit?: number;
  project?: string;
}
type ResolvedArgs = {
  action: 'append' | 'read' | 'list';
  task_id: string | undefined;
  text: string | undefined;
  since: string | undefined;
  limit: number | undefined;
  project: string | undefined;
};
function args(input: TaskNotesArgs): ResolvedArgs {
  return {
    action: input.action,
    task_id: input.task_id,
    text: input.text,
    since: input.since,
    limit: input.limit,
    project: input.project,
  };
}

function seed(): { projectStore: ProjectRegistry; taskStore: TaskRegistry; taskId: string } {
  const projectStore = new ProjectRegistry();
  projectStore.register({
    id: 'p1',
    name: 'demo',
    path: '/tmp/demo',
    createdAt: '',
  });
  let calls = 0;
  const taskStore = new TaskRegistry({
    now: () => Date.parse(`2026-05-21T10:0${calls++}:00.000Z`),
    idGenerator: () => 'tk-aa11bb22',
  });
  const rec = taskStore.create({ projectId: 'p1', description: 'do thing' });
  return { projectStore, taskStore, taskId: rec.id };
}

describe('task_notes — append', () => {
  it('appends a note and returns the entry + total count', async () => {
    const { projectStore, taskStore, taskId } = seed();
    const tool = makeTaskNotesTool({ taskStore, projectStore });
    const res = await tool.handler(
      args({ action: 'append', task_id: taskId, text: 'first note' }),
      ctx(),
    );
    expect(res.isError).toBeFalsy();
    expect(asText(res)).toContain(`Appended note to ${taskId}`);
    expect(asText(res)).toContain('1 total');
    const sc = res.structuredContent as { taskId: string; total: number; note: { text: string } };
    expect(sc.taskId).toBe(taskId);
    expect(sc.total).toBe(1);
    expect(sc.note.text).toBe('first note');
  });

  it('rejects missing task_id', async () => {
    const { projectStore, taskStore } = seed();
    const tool = makeTaskNotesTool({ taskStore, projectStore });
    const res = await tool.handler(args({ action: 'append', text: 'x' }), ctx());
    expect(res.isError).toBe(true);
    expect(asText(res)).toContain('task_notes append requires task_id.');
  });

  it('rejects missing text', async () => {
    const { projectStore, taskStore, taskId } = seed();
    const tool = makeTaskNotesTool({ taskStore, projectStore });
    const res = await tool.handler(args({ action: 'append', task_id: taskId }), ctx());
    expect(res.isError).toBe(true);
    expect(asText(res)).toContain('task_notes append requires text.');
  });

  it('rejects whitespace-only text', async () => {
    const { projectStore, taskStore, taskId } = seed();
    const tool = makeTaskNotesTool({ taskStore, projectStore });
    const res = await tool.handler(
      args({ action: 'append', task_id: taskId, text: '    \n\t' }),
      ctx(),
    );
    expect(res.isError).toBe(true);
    expect(asText(res)).toContain('non-empty after trim');
  });

  it('rejects oversize text (>64 KB)', async () => {
    const { projectStore, taskStore, taskId } = seed();
    const tool = makeTaskNotesTool({ taskStore, projectStore });
    const text = 'a'.repeat(64 * 1024 + 1);
    const res = await tool.handler(
      args({ action: 'append', task_id: taskId, text }),
      ctx(),
    );
    expect(res.isError).toBe(true);
    expect(asText(res)).toContain('64 KB cap');
  });

  it('accepts text at exactly the 64 KB cap (audit m3 boundary)', async () => {
    const { projectStore, taskStore, taskId } = seed();
    const tool = makeTaskNotesTool({ taskStore, projectStore });
    const text = 'a'.repeat(64 * 1024);
    const res = await tool.handler(
      args({ action: 'append', task_id: taskId, text }),
      ctx(),
    );
    expect(res.isError).toBeFalsy();
    const sc = res.structuredContent as { total: number };
    expect(sc.total).toBe(1);
  });

  it('rejects unknown task_id', async () => {
    const { projectStore, taskStore } = seed();
    const tool = makeTaskNotesTool({ taskStore, projectStore });
    const res = await tool.handler(
      args({ action: 'append', task_id: 'tk-deadbeef', text: 'x' }),
      ctx(),
    );
    expect(res.isError).toBe(true);
    expect(asText(res)).toContain("Unknown task 'tk-deadbeef'");
  });
});

describe('task_notes — read', () => {
  it('returns markdown blob with section headers', async () => {
    const { projectStore, taskStore, taskId } = seed();
    taskStore.update(taskId, { notes: 'progress: started' });
    taskStore.update(taskId, { notes: 'progress: midway' });
    const tool = makeTaskNotesTool({ taskStore, projectStore });
    const res = await tool.handler(args({ action: 'read', task_id: taskId }), ctx());
    expect(res.isError).toBeFalsy();
    expect(asText(res)).toContain('## 2026-05-21 10:01:00 UTC');
    expect(asText(res)).toContain('progress: started');
    expect(asText(res)).toContain('progress: midway');
    const sc = res.structuredContent as {
      total: number;
      returned: number;
      truncated: boolean;
      notes: { at: string; text: string }[];
    };
    expect(sc.total).toBe(2);
    expect(sc.returned).toBe(2);
    expect(sc.truncated).toBe(false);
  });

  it('returns placeholder text when task has no notes', async () => {
    const { projectStore, taskStore, taskId } = seed();
    const tool = makeTaskNotesTool({ taskStore, projectStore });
    const res = await tool.handler(args({ action: 'read', task_id: taskId }), ctx());
    expect(res.isError).toBeFalsy();
    expect(asText(res)).toContain(`(no notes for ${taskId})`);
    const sc = res.structuredContent as { total: number; returned: number };
    expect(sc.total).toBe(0);
    expect(sc.returned).toBe(0);
  });

  it('filters by since', async () => {
    const { projectStore, taskStore, taskId } = seed();
    taskStore.update(taskId, { notes: 'a' });
    taskStore.update(taskId, { notes: 'b' });
    taskStore.update(taskId, { notes: 'c' });
    const tool = makeTaskNotesTool({ taskStore, projectStore });
    const res = await tool.handler(
      args({ action: 'read', task_id: taskId, since: '2026-05-21T10:02:00.000Z' }),
      ctx(),
    );
    const sc = res.structuredContent as { total: number; returned: number };
    expect(sc.total).toBe(3);
    expect(sc.returned).toBe(2);
    expect(asText(res)).toContain('b');
    expect(asText(res)).toContain('c');
    expect(asText(res)).not.toContain('## 2026-05-21 10:01:00 UTC');
  });

  it('caps with limit (returns last N matching)', async () => {
    const { projectStore, taskStore, taskId } = seed();
    taskStore.update(taskId, { notes: 'a' });
    taskStore.update(taskId, { notes: 'b' });
    taskStore.update(taskId, { notes: 'c' });
    const tool = makeTaskNotesTool({ taskStore, projectStore });
    const res = await tool.handler(
      args({ action: 'read', task_id: taskId, limit: 2 }),
      ctx(),
    );
    const sc = res.structuredContent as {
      total: number;
      returned: number;
      truncated: boolean;
    };
    expect(sc.total).toBe(3);
    expect(sc.returned).toBe(2);
    expect(sc.truncated).toBe(true);
    expect(asText(res)).toContain('b');
    expect(asText(res)).toContain('c');
    expect(asText(res)).not.toContain('## 2026-05-21 10:01:00 UTC');
  });

  it('rejects missing task_id', async () => {
    const { projectStore, taskStore } = seed();
    const tool = makeTaskNotesTool({ taskStore, projectStore });
    const res = await tool.handler(args({ action: 'read' }), ctx());
    expect(res.isError).toBe(true);
    expect(asText(res)).toContain('requires task_id');
  });

  it('rejects unknown task_id', async () => {
    const { projectStore, taskStore } = seed();
    const tool = makeTaskNotesTool({ taskStore, projectStore });
    const res = await tool.handler(
      args({ action: 'read', task_id: 'tk-deadbeef' }),
      ctx(),
    );
    expect(res.isError).toBe(true);
    expect(asText(res)).toContain("Unknown task 'tk-deadbeef'");
  });

  it('drops bad since input (returns full list)', async () => {
    const { projectStore, taskStore, taskId } = seed();
    taskStore.update(taskId, { notes: 'a' });
    taskStore.update(taskId, { notes: 'b' });
    const tool = makeTaskNotesTool({ taskStore, projectStore });
    const res = await tool.handler(
      args({ action: 'read', task_id: taskId, since: 'not-a-date' }),
      ctx(),
    );
    const sc = res.structuredContent as { returned: number };
    expect(sc.returned).toBe(2);
  });
});

describe('task_notes — list', () => {
  it('summarizes only tasks that have notes', async () => {
    const projectStore = new ProjectRegistry();
    projectStore.register({ id: 'p1', name: 'demo', path: '/tmp/demo', createdAt: '' });
    const taskStore = new TaskRegistry({
      now: () => Date.parse('2026-05-21T10:00:00.000Z'),
      idGenerator: ((): (() => string) => {
        let n = 0;
        return () => `tk-${String(++n).padStart(8, '0')}`;
      })(),
    });
    const a = taskStore.create({ projectId: 'p1', description: 'a' });
    const b = taskStore.create({ projectId: 'p1', description: 'b' });
    taskStore.create({ projectId: 'p1', description: 'c (no notes)' });
    taskStore.update(a.id, { notes: 'progress on a' });
    taskStore.update(b.id, { notes: 'progress on b' });

    const tool = makeTaskNotesTool({ taskStore, projectStore });
    const res = await tool.handler(args({ action: 'list' }), ctx());
    expect(res.isError).toBeFalsy();
    const sc = res.structuredContent as {
      total: number;
      summaries: { taskId: string; count: number }[];
    };
    expect(sc.total).toBe(2);
    expect(sc.summaries.map((s) => s.taskId).sort()).toEqual([a.id, b.id].sort());
    expect(asText(res)).toContain(a.id);
    expect(asText(res)).toContain(b.id);
  });

  it('filters by project', async () => {
    const projectStore = new ProjectRegistry();
    projectStore.register({ id: 'p1', name: 'p1', path: '/tmp/p1', createdAt: '' });
    projectStore.register({ id: 'p2', name: 'p2', path: '/tmp/p2', createdAt: '' });
    const taskStore = new TaskRegistry();
    const a = taskStore.create({ projectId: 'p1', description: 'a' });
    const b = taskStore.create({ projectId: 'p2', description: 'b' });
    taskStore.update(a.id, { notes: 'na' });
    taskStore.update(b.id, { notes: 'nb' });

    const tool = makeTaskNotesTool({ taskStore, projectStore });
    const res = await tool.handler(args({ action: 'list', project: 'p2' }), ctx());
    const sc = res.structuredContent as { total: number };
    expect(sc.total).toBe(1);
    expect(asText(res)).toContain(b.id);
    expect(asText(res)).not.toContain(a.id);
  });

  it('reports empty when no tasks have notes', async () => {
    const { projectStore, taskStore } = seed();
    const tool = makeTaskNotesTool({ taskStore, projectStore });
    const res = await tool.handler(args({ action: 'list' }), ctx());
    expect(res.isError).toBeFalsy();
    expect(asText(res)).toBe('No tasks with notes.');
    const sc = res.structuredContent as { total: number };
    expect(sc.total).toBe(0);
  });

  it('reports project-scoped empty', async () => {
    const { projectStore, taskStore } = seed();
    const tool = makeTaskNotesTool({ taskStore, projectStore });
    const res = await tool.handler(args({ action: 'list', project: 'demo' }), ctx());
    expect(asText(res)).toContain("No tasks with notes in project 'demo'");
  });

  it('rejects unknown project', async () => {
    const { projectStore, taskStore } = seed();
    const tool = makeTaskNotesTool({ taskStore, projectStore });
    const res = await tool.handler(args({ action: 'list', project: 'ghost' }), ctx());
    expect(res.isError).toBe(true);
    expect(asText(res)).toContain("Unknown project 'ghost'");
  });
});

describe('task_notes — schema', () => {
  it('rejects unknown action at the schema layer', () => {
    const { projectStore, taskStore } = seed();
    const tool = makeTaskNotesTool({ taskStore, projectStore });
    // Direct zod validation — the SDK validates against this schema
    // before calling our handler.
    const ZodObj = (
      tool as unknown as {
        inputSchema: Record<string, { safeParse(v: unknown): { success: boolean } }>;
      }
    ).inputSchema;
    expect(ZodObj.action!.safeParse('drop').success).toBe(false);
  });
});
