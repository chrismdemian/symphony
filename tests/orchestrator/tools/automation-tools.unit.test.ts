import { beforeEach, describe, expect, it } from 'vitest';
import {
  makeCreateAutomationTool,
  makeListAutomationsTool,
  makeRemoveAutomationTool,
  makeRunAutomationTool,
  makeSetAutomationEnabledTool,
} from '../../../src/orchestrator/tools/automation-tools.js';
import { InMemoryAutomationStore } from '../../../src/state/automation-store.js';
import { DEFAULT_DISPATCH_CONTEXT } from '../../../src/orchestrator/capabilities.js';
import type { DispatchContext } from '../../../src/orchestrator/types.js';
import type { ProjectRecord, ProjectStore } from '../../../src/projects/types.js';

/**
 * Phase 8D.1 — agent-native automation MCP tools. Verifies parity with the
 * CLI runners against the in-memory store + a fake ProjectStore.
 */

function ctx(): DispatchContext {
  return { ...DEFAULT_DISPATCH_CONTEXT, mode: 'act' };
}

const REC: ProjectRecord = {
  id: 'proj-1',
  name: 'alpha',
  path: '/repos/alpha',
  createdAt: '2026-06-08T00:00:00.000Z',
} as ProjectRecord;

function fakeProjectStore(): ProjectStore {
  return {
    snapshot: (k: string) => (k === REC.name || k === REC.id ? REC : undefined),
    list: () => [REC],
    get: (k: string) => (k === REC.name || k === REC.id ? REC : undefined),
    register: () => {
      throw new Error('not implemented');
    },
    update: () => {
      throw new Error('not implemented');
    },
    delete: () => false,
  } as unknown as ProjectStore;
}

describe('automation MCP tools', () => {
  let store: InMemoryAutomationStore;
  let projectStore: ProjectStore;

  beforeEach(() => {
    store = new InMemoryAutomationStore({ now: () => Date.parse('2026-06-08T06:00:00.000Z') });
    projectStore = fakeProjectStore();
  });

  describe('create_automation', () => {
    const tool = () => makeCreateAutomationTool({ automationStore: store, projectStore });

    it('creates a daily automation and returns a snapshot', async () => {
      const res = await tool().handler(
        { name: 'nightly', prompt: 'run tests', every: 'daily', at: '02:00' } as never,
        ctx(),
      );
      expect(res.isError).toBeFalsy();
      expect(res.structuredContent?.['name']).toBe('nightly');
      expect(res.structuredContent?.['schedule']).toEqual({ type: 'daily', hour: 2, minute: 0 });
      expect(res.structuredContent?.['scheduleText']).toBe('daily at 02:00');
      expect(store.list()).toHaveLength(1);
    });

    it('rejects an invalid interval', async () => {
      const res = await tool().handler(
        { name: 'x', prompt: 'p', every: 'yearly' } as never,
        ctx(),
      );
      expect(res.isError).toBe(true);
      expect(store.list()).toHaveLength(0);
    });

    it('rejects an unknown project', async () => {
      const res = await tool().handler(
        { name: 'x', prompt: 'p', every: 'hourly', project: 'ghost' } as never,
        ctx(),
      );
      expect(res.isError).toBe(true);
      expect((res.content[0] as { text: string }).text).toContain("Unknown project 'ghost'");
    });

    it('resolves a named project to its id', async () => {
      const res = await tool().handler(
        { name: 'x', prompt: 'p', every: 'weekly', on: 'mon', at: '09:00', project: 'alpha' } as never,
        ctx(),
      );
      expect(res.isError).toBeFalsy();
      expect(res.structuredContent?.['projectId']).toBe('proj-1');
    });

    it('honors enabled:false', async () => {
      const res = await tool().handler(
        { name: 'off', prompt: 'p', every: 'hourly', enabled: false } as never,
        ctx(),
      );
      expect(res.structuredContent?.['enabled']).toBe(false);
    });

    it('creates a trigger automation from triggerType (no schedule)', async () => {
      const res = await tool().handler(
        { name: 'gh', prompt: 'triage', triggerType: 'github_issue' } as never,
        ctx(),
      );
      expect(res.isError).toBeFalsy();
      expect(res.structuredContent?.['triggerType']).toBe('github_issue');
      expect(res.structuredContent?.['schedule']).toBeNull();
      expect(res.structuredContent?.['nextRunAt']).toBeNull();
      expect((res.content[0] as { text: string }).text).toContain('on new github_issue');
    });

    it('rejects both every and triggerType', async () => {
      const res = await tool().handler(
        { name: 'x', prompt: 'p', every: 'daily', triggerType: 'github_issue' } as never,
        ctx(),
      );
      expect(res.isError).toBe(true);
      expect(store.list()).toHaveLength(0);
    });

    it('rejects neither every nor triggerType', async () => {
      const res = await tool().handler({ name: 'x', prompt: 'p' } as never, ctx());
      expect(res.isError).toBe(true);
      expect(store.list()).toHaveLength(0);
    });

    // ── Phase 8D.4 — trigger filters ─────────────────────────────────────────

    it('creates a trigger automation with filters and reports them', async () => {
      const res = await tool().handler(
        {
          name: 'gh-bugs',
          prompt: 'triage',
          triggerType: 'github_issue',
          labelFilter: ['bug', 'urgent'],
          assigneeFilter: 'chris',
        } as never,
        ctx(),
      );
      expect(res.isError).toBeFalsy();
      expect(res.structuredContent?.['triggerConfig']).toEqual({
        labelFilter: ['bug', 'urgent'],
        assigneeFilter: 'chris',
      });
      expect((res.content[0] as { text: string }).text).toContain('label:bug,urgent assignee:chris');
    });

    it('rejects filters on a SCHEDULE automation', async () => {
      const res = await tool().handler(
        { name: 'x', prompt: 'p', every: 'daily', at: '09:00', labelFilter: ['bug'] } as never,
        ctx(),
      );
      expect(res.isError).toBe(true);
      expect((res.content[0] as { text: string }).text).toContain('only valid with `triggerType`');
      expect(store.list()).toHaveLength(0);
    });

    it('a trigger with no filters has a null triggerConfig', async () => {
      const res = await tool().handler(
        { name: 'gh', prompt: 'p', triggerType: 'github_issue' } as never,
        ctx(),
      );
      expect(res.structuredContent?.['triggerConfig']).toBeNull();
    });
  });

  it('list_automations renders rows + a structured array', async () => {
    const empty = await makeListAutomationsTool({ automationStore: store }).handler({} as never, ctx());
    expect((empty.content[0] as { text: string }).text).toContain('No automations defined');

    store.create({ name: 'a', prompt: 'p', schedule: { type: 'hourly', minute: 0 } });
    const res = await makeListAutomationsTool({ automationStore: store }).handler({} as never, ctx());
    expect((res.content[0] as { text: string }).text).toContain('a — hourly');
    expect((res.structuredContent?.['automations'] as unknown[]).length).toBe(1);
  });

  it('remove_automation deletes / errors on missing', async () => {
    const a = store.create({ name: 'a', prompt: 'p', schedule: { type: 'hourly', minute: 0 } });
    const tool = makeRemoveAutomationTool({ automationStore: store });
    expect((await tool.handler({ id: a.id } as never, ctx())).isError).toBeFalsy();
    expect(store.get(a.id)).toBeUndefined();
    expect((await tool.handler({ id: a.id } as never, ctx())).isError).toBe(true);
  });

  it('set_automation_enabled toggles / errors on missing', async () => {
    const a = store.create({ name: 'a', prompt: 'p', schedule: { type: 'hourly', minute: 0 } });
    const tool = makeSetAutomationEnabledTool({ automationStore: store });
    await tool.handler({ id: a.id, enabled: false } as never, ctx());
    expect(store.get(a.id)!.enabled).toBe(false);
    expect((await tool.handler({ id: 'nope', enabled: true } as never, ctx())).isError).toBe(true);
  });

  it('run_automation forces due / rejects disabled + missing', async () => {
    const a = store.create({ name: 'a', prompt: 'p', schedule: { type: 'daily', hour: 9, minute: 0 } });
    const nowIso = '2026-06-08T07:30:00.000Z';
    const tool = makeRunAutomationTool({
      automationStore: store,
      now: () => Date.parse(nowIso),
    });
    const res = await tool.handler({ id: a.id } as never, ctx());
    expect(res.isError).toBeFalsy();
    expect(store.get(a.id)!.nextRunAt).toBe(nowIso); // forced due to the injected now

    store.setEnabled(a.id, false);
    expect((await tool.handler({ id: a.id } as never, ctx())).isError).toBe(true); // disabled
    expect((await tool.handler({ id: 'nope' } as never, ctx())).isError).toBe(true); // missing
  });
});
