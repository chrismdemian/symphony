/**
 * Phase 5C — verify `list_tasks` strips embedded notes by default and
 * surfaces them when `include_notes: true`.
 */
import { describe, expect, it } from 'vitest';

import { DEFAULT_DISPATCH_CONTEXT } from '../../../src/orchestrator/capabilities.js';
import type { ToolHandlerReturn } from '../../../src/orchestrator/registry.js';
import { makeListTasksTool } from '../../../src/orchestrator/tools/list-tasks.js';
import type { DispatchContext } from '../../../src/orchestrator/types.js';
import { ProjectRegistry } from '../../../src/projects/registry.js';
import { TaskRegistry } from '../../../src/state/task-registry.js';

function ctx(overrides: Partial<DispatchContext> = {}): DispatchContext {
  return { ...DEFAULT_DISPATCH_CONTEXT, mode: 'act', ...overrides };
}

function asText(res: ToolHandlerReturn): string {
  return res.content.map((c) => c.text).join('\n');
}

function listArgs(overrides: {
  project?: string;
  status?: 'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled';
  limit?: number;
  ready_only?: boolean;
  include_notes?: boolean;
} = {}): {
  project: string | undefined;
  status: undefined;
  limit: number | undefined;
  ready_only: boolean | undefined;
  include_notes: boolean | undefined;
} {
  return {
    project: overrides.project,
    status: undefined,
    limit: overrides.limit,
    ready_only: overrides.ready_only,
    include_notes: overrides.include_notes,
  };
}

function seedWithNotes(): { projectStore: ProjectRegistry; taskStore: TaskRegistry } {
  const projectStore = new ProjectRegistry();
  projectStore.register({ id: 'p1', name: 'p1', path: '/tmp/p1', createdAt: '' });
  const taskStore = new TaskRegistry({ now: () => Date.parse('2026-05-21T10:00:00.000Z') });
  const a = taskStore.create({ projectId: 'p1', description: 'a' });
  const b = taskStore.create({ projectId: 'p1', description: 'b' });
  taskStore.update(a.id, { notes: 'note on a' });
  taskStore.update(a.id, { notes: 'second on a' });
  taskStore.update(b.id, { notes: 'note on b' });
  return { projectStore, taskStore };
}

describe('list_tasks — Phase 5C notes projection', () => {
  it('strips notes from structuredContent by default', async () => {
    const { projectStore, taskStore } = seedWithNotes();
    const tool = makeListTasksTool({ taskStore, projectStore });
    const res = await tool.handler(listArgs(), ctx());
    expect(res.isError).toBeFalsy();
    const sc = res.structuredContent as {
      tasks: Array<{ id: string; notes?: unknown }>;
      notesIncluded: boolean;
    };
    expect(sc.notesIncluded).toBe(false);
    expect(sc.tasks).toHaveLength(2);
    for (const t of sc.tasks) {
      expect(t.notes).toBeUndefined();
      expect('notes' in t).toBe(false);
    }
  });

  it('text output never includes notes (unchanged from pre-5C)', async () => {
    const { projectStore, taskStore } = seedWithNotes();
    const tool = makeListTasksTool({ taskStore, projectStore });
    const res = await tool.handler(listArgs(), ctx());
    expect(asText(res)).not.toContain('note on a');
    expect(asText(res)).not.toContain('note on b');
  });

  it('preserves notes when include_notes: true', async () => {
    const { projectStore, taskStore } = seedWithNotes();
    const tool = makeListTasksTool({ taskStore, projectStore });
    const res = await tool.handler(listArgs({ include_notes: true }), ctx());
    const sc = res.structuredContent as {
      tasks: Array<{ id: string; notes: Array<{ at: string; text: string }> }>;
      notesIncluded: boolean;
    };
    expect(sc.notesIncluded).toBe(true);
    expect(sc.tasks).toHaveLength(2);
    const taskA = sc.tasks.find((t) => t.notes && t.notes.length === 2);
    expect(taskA).toBeDefined();
    expect(taskA!.notes.map((n) => n.text)).toEqual(['note on a', 'second on a']);
  });

  it('keeps other task fields intact when stripping notes', async () => {
    const { projectStore, taskStore } = seedWithNotes();
    const tool = makeListTasksTool({ taskStore, projectStore });
    const res = await tool.handler(listArgs(), ctx());
    const sc = res.structuredContent as {
      tasks: Array<{
        id: string;
        projectId: string;
        description: string;
        status: string;
        priority: number;
        dependsOn: string[];
      }>;
    };
    const first = sc.tasks[0]!;
    expect(first.id).toMatch(/^tk-/);
    expect(first.projectId).toBe('p1');
    expect(first.description).toBeDefined();
    expect(first.status).toBe('pending');
    expect(first.priority).toBe(0);
    expect(first.dependsOn).toEqual([]);
  });

  it('strip works alongside ready_only filter', async () => {
    const { projectStore, taskStore } = seedWithNotes();
    const tool = makeListTasksTool({ taskStore, projectStore });
    const res = await tool.handler(listArgs({ ready_only: true }), ctx());
    const sc = res.structuredContent as {
      tasks: Array<{ notes?: unknown }>;
      notesIncluded: boolean;
    };
    expect(sc.notesIncluded).toBe(false);
    for (const t of sc.tasks) expect(t.notes).toBeUndefined();
  });
});
