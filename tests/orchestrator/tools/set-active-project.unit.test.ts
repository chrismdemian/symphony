/**
 * Phase 5D — unit coverage for the `set_active_project` MCP tool.
 *
 * The handler is responsible for:
 *   - Validating `project_name` against `projectStore` (rejects unknown).
 *   - Calling `persist` BEFORE `setDispatchActiveProject` so a persist
 *     failure leaves the in-memory cursor untouched.
 *   - The `"(none)"` sentinel clears the cursor (persists null).
 *   - Returning a structured payload with the resolved project snapshot
 *     (or `null` for the clear path).
 */
import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_DISPATCH_CONTEXT } from '../../../src/orchestrator/capabilities.js';
import type { ToolHandlerReturn } from '../../../src/orchestrator/registry.js';
import {
  SET_ACTIVE_PROJECT_CLEAR_SENTINEL,
  makeSetActiveProjectTool,
  type SetActiveProjectDeps,
} from '../../../src/orchestrator/tools/set-active-project.js';
import type { DispatchContext } from '../../../src/orchestrator/types.js';
import { ProjectRegistry } from '../../../src/projects/registry.js';

function ctx(overrides: Partial<DispatchContext> = {}): DispatchContext {
  return { ...DEFAULT_DISPATCH_CONTEXT, mode: 'act', ...overrides };
}

function asText(res: ToolHandlerReturn): string {
  return res.content.map((c) => c.text).join('\n');
}

function seedStore(): ProjectRegistry {
  const store = new ProjectRegistry();
  store.register({ id: 'p1', name: 'demo', path: '/tmp/demo', createdAt: '' });
  store.register({ id: 'p2', name: 'second', path: '/tmp/second', createdAt: '' });
  return store;
}

function deps(
  store: ProjectRegistry,
  overrides: Partial<SetActiveProjectDeps> = {},
): SetActiveProjectDeps {
  return {
    projectStore: store,
    setDispatchActiveProject: vi.fn(),
    persist: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe('set_active_project — validation', () => {
  it('rejects unknown project names with a helpful hint', async () => {
    const store = seedStore();
    const setter = vi.fn();
    const persist = vi.fn();
    const tool = makeSetActiveProjectTool(deps(store, { setDispatchActiveProject: setter, persist }));

    const res = await tool.handler({ project_name: 'ghost' }, ctx());

    expect(res.isError).toBe(true);
    expect(asText(res)).toContain("Unknown project 'ghost'");
    expect(asText(res)).toContain('Known: demo, second');
    expect(setter).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
  });

  it('surfaces the empty-registry hint when no projects are registered', async () => {
    const store = new ProjectRegistry();
    const tool = makeSetActiveProjectTool(deps(store));

    const res = await tool.handler({ project_name: 'anything' }, ctx());

    expect(res.isError).toBe(true);
    expect(asText(res)).toContain('No projects registered');
    expect(asText(res)).toContain('symphony add <path>');
  });
});

describe('set_active_project — set', () => {
  it('persists FIRST then updates the dispatch cursor with the snapshot name', async () => {
    const store = seedStore();
    const calls: string[] = [];
    const setter = vi.fn((value: string | null) => {
      calls.push(`setter:${value ?? '<null>'}`);
    });
    const persist = vi.fn(async (value: string | null) => {
      calls.push(`persist:${value ?? '<null>'}`);
    });
    const tool = makeSetActiveProjectTool(
      deps(store, { setDispatchActiveProject: setter, persist }),
    );

    const res = await tool.handler({ project_name: 'demo' }, ctx());

    expect(res.isError).toBeFalsy();
    expect(calls).toEqual(['persist:demo', 'setter:demo']);
    const sc = res.structuredContent as { active: { name: string; path: string } };
    expect(sc.active.name).toBe('demo');
    // ProjectRegistry resolves the input path through `path.resolve`,
    // which is platform-aware (Win32 `/tmp/demo` → `C:\tmp\demo`).
    // Assert against the resolved snapshot, not a hardcoded POSIX form.
    expect(sc.active.path.endsWith('demo')).toBe(true);
    expect(asText(res)).toContain('Active project → demo');
    expect(asText(res)).toContain(sc.active.path);
  });

  it('resolves project lookup by ID as well as by name', async () => {
    const store = seedStore();
    const setter = vi.fn();
    const tool = makeSetActiveProjectTool(
      deps(store, { setDispatchActiveProject: setter }),
    );

    const res = await tool.handler({ project_name: 'p2' }, ctx());

    expect(res.isError).toBeFalsy();
    expect(setter).toHaveBeenCalledWith('second'); // name, not id
  });

  it('persist failure leaves the cursor untouched', async () => {
    const store = seedStore();
    const setter = vi.fn();
    const persist = vi.fn(async () => {
      throw new Error('disk full');
    });
    const tool = makeSetActiveProjectTool(
      deps(store, { setDispatchActiveProject: setter, persist }),
    );

    const res = await tool.handler({ project_name: 'demo' }, ctx());

    expect(res.isError).toBe(true);
    expect(asText(res)).toContain("set_active_project failed to persist 'demo'");
    expect(asText(res)).toContain('disk full');
    expect(setter).not.toHaveBeenCalled();
  });
});

describe('set_active_project — clear sentinel', () => {
  it('clears the cursor when project_name is the clear sentinel', async () => {
    const store = seedStore();
    const calls: string[] = [];
    const setter = vi.fn((value: string | null) => {
      calls.push(`setter:${value ?? '<null>'}`);
    });
    const persist = vi.fn(async (value: string | null) => {
      calls.push(`persist:${value ?? '<null>'}`);
    });
    const tool = makeSetActiveProjectTool(
      deps(store, { setDispatchActiveProject: setter, persist }),
    );

    const res = await tool.handler(
      { project_name: SET_ACTIVE_PROJECT_CLEAR_SENTINEL },
      ctx(),
    );

    expect(res.isError).toBeFalsy();
    expect(calls).toEqual(['persist:<null>', 'setter:<null>']);
    const sc = res.structuredContent as { active: null };
    expect(sc.active).toBeNull();
    expect(asText(res)).toContain('Active project cleared');
  });

  it('persist failure on clear leaves the cursor untouched', async () => {
    const store = seedStore();
    const setter = vi.fn();
    const persist = vi.fn(async () => {
      throw new Error('ENOSPC');
    });
    const tool = makeSetActiveProjectTool(
      deps(store, { setDispatchActiveProject: setter, persist }),
    );

    const res = await tool.handler(
      { project_name: SET_ACTIVE_PROJECT_CLEAR_SENTINEL },
      ctx(),
    );

    expect(res.isError).toBe(true);
    expect(asText(res)).toContain('set_active_project failed to persist clear');
    expect(setter).not.toHaveBeenCalled();
  });
});

describe('set_active_project — registration metadata', () => {
  it('declares scope=both and zero capabilities (no irreversible flag)', () => {
    const store = seedStore();
    const tool = makeSetActiveProjectTool(deps(store));
    expect(tool.name).toBe('set_active_project');
    expect(tool.scope).toBe('both');
    expect(tool.capabilities).toEqual([]);
  });
});
