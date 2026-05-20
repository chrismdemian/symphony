import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { makeGetProjectInfoTool } from '../../../src/orchestrator/tools/get-project-info.js';
import { DEFAULT_DISPATCH_CONTEXT } from '../../../src/orchestrator/capabilities.js';
import { WorkerRegistry } from '../../../src/orchestrator/worker-registry.js';
import type { DispatchContext } from '../../../src/orchestrator/types.js';
import type { ProjectRecord, ProjectStore } from '../../../src/projects/types.js';

function ctx(): DispatchContext {
  return { ...DEFAULT_DISPATCH_CONTEXT, mode: 'act' };
}

let sandbox: string;

beforeEach(() => {
  sandbox = mkdtempSync(path.join(tmpdir(), 'sym-4f3-gpi-'));
});
afterEach(() => {
  try {
    rmSync(sandbox, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function makeStore(rec: ProjectRecord): ProjectStore {
  return {
    snapshot: (key: string) => (key === rec.name || key === rec.id ? rec : undefined),
    list: () => [rec],
    get: () => rec,
    register: () => {
      throw new Error('not implemented');
    },
    update: () => {
      throw new Error('not implemented');
    },
    delete: () => false,
  } as unknown as ProjectStore;
}

function makeRec(p: string): ProjectRecord {
  return {
    id: 'proj-1',
    name: 'proj',
    path: p,
    createdAt: '2026-05-19T00:00:00.000Z',
  } as ProjectRecord;
}

describe('Phase 4F.3 — get_project_info hasUiStack / hasDesignMd enrichment', () => {
  it('reports uiStack: no, designMd: no for a bare project', async () => {
    const tool = makeGetProjectInfoTool({
      store: makeStore(makeRec(sandbox)),
      workerRegistry: new WorkerRegistry(),
    });
    const res = await tool.handler({ project_name: 'proj' } as never, ctx());
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('uiStack: no');
    expect(text).toContain('designMd: no');
    const struct = res.structuredContent as Record<string, unknown>;
    expect(struct.hasUiStack).toBe(false);
    expect(struct.hasDesignMd).toBe(false);
    expect(struct.uiFrameworks).toEqual([]);
  });

  it('reports the matched frameworks when package.json names them', async () => {
    writeFileSync(
      path.join(sandbox, 'package.json'),
      JSON.stringify({ dependencies: { next: '^15', react: '^19' } }),
    );
    const tool = makeGetProjectInfoTool({
      store: makeStore(makeRec(sandbox)),
      workerRegistry: new WorkerRegistry(),
    });
    const res = await tool.handler({ project_name: 'proj' } as never, ctx());
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('uiStack: yes');
    expect(text).toContain('next');
    expect(text).toContain('react');
    expect((res.structuredContent as { hasUiStack: boolean }).hasUiStack).toBe(true);
  });

  it('reports designMd: yes when DESIGN.md is present', async () => {
    writeFileSync(path.join(sandbox, 'DESIGN.md'), '# spec\n');
    const tool = makeGetProjectInfoTool({
      store: makeStore(makeRec(sandbox)),
      workerRegistry: new WorkerRegistry(),
    });
    const res = await tool.handler({ project_name: 'proj' } as never, ctx());
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('designMd: yes');
    expect((res.structuredContent as { hasDesignMd: boolean }).hasDesignMd).toBe(true);
  });

  it('returns the same unknown-project error shape (pre-4F.3 regression guard)', async () => {
    void mkdirSync; // helper imported for symmetry
    const tool = makeGetProjectInfoTool({
      store: makeStore(makeRec(sandbox)),
      workerRegistry: new WorkerRegistry(),
    });
    const res = await tool.handler({ project_name: 'nope' } as never, ctx());
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toContain(
      "Unknown project 'nope'",
    );
  });
});
