import { beforeEach, describe, expect, it } from 'vitest';
import { makeSyncNotionTool } from '../../../src/orchestrator/tools/sync-notion.js';
import { ProjectRegistry } from '../../../src/projects/registry.js';
import { TaskRegistry } from '../../../src/state/task-registry.js';
import { MemoryExternalLinkStore } from '../../../src/state/external-link-store.js';
import type {
  NotionConnectorHandle,
  NotionTaskCandidate,
  NotionWritebackResult,
} from '../../../src/integrations/notion.js';
import type { DispatchContext } from '../../../src/orchestrator/types.js';

function fakeCtx(): DispatchContext {
  return { mode: 'act', tier: 1 } as unknown as DispatchContext;
}

function fakeConnector(candidates: NotionTaskCandidate[]): NotionConnectorHandle {
  return {
    fetchOpenPages: async () => candidates,
    writeBackStatus: async (): Promise<NotionWritebackResult> => ({ written: false }),
  };
}

function cand(overrides: Partial<NotionTaskCandidate>): NotionTaskCandidate {
  return {
    pageId: 'p1',
    url: 'https://notion.so/p1',
    title: 'Task one',
    status: 'pending',
    priority: 0,
    projectValue: null,
    ...overrides,
  };
}

interface Harness {
  projects: ProjectRegistry;
  tasks: TaskRegistry;
  links: MemoryExternalLinkStore;
}

function harness(): Harness {
  const projects = new ProjectRegistry();
  projects.register({ id: 'proj', name: 'symphony', path: '/tmp/symphony', createdAt: '' });
  projects.register({ id: 'other', name: 'other', path: '/tmp/other', createdAt: '' });
  const tasks = new TaskRegistry({ projectStore: projects });
  const links = new MemoryExternalLinkStore();
  return { projects, tasks, links };
}

async function runSync(
  h: Harness,
  connector: NotionConnectorHandle,
  args: { limit?: number; project?: string } = {},
  resolveProjectPath?: (p?: string) => string,
) {
  const tool = makeSyncNotionTool({
    connector,
    taskStore: h.tasks,
    projectStore: h.projects,
    externalLinkStore: h.links,
    ...(resolveProjectPath !== undefined ? { resolveProjectPath } : {}),
  });
  // z.infer collapses `.optional()` to required-but-undefined; pass both
  // keys explicitly (2A.4a gotcha).
  const handlerArgs = { limit: args.limit, project: args.project };
  return tool.handler(handlerArgs as Parameters<typeof tool.handler>[0], fakeCtx());
}

describe('sync_notion tool', () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it('creates a task + link per new page (routing by Notion project value)', async () => {
    const connector = fakeConnector([
      cand({ pageId: 'p1', title: 'Fix bug', projectValue: 'symphony', priority: 2 }),
    ]);
    const result = await runSync(h, connector);
    const sc = result.structuredContent as { createdCount: number; created: string[] };
    expect(sc.createdCount).toBe(1);
    const task = h.tasks.get(sc.created[0]!)!;
    expect(task.description).toBe('Fix bug');
    expect(task.projectId).toBe('proj');
    expect(task.priority).toBe(2);
    const link = h.links.getByExternal('notion', 'p1');
    expect(link?.taskId).toBe(task.id);
    expect(link?.url).toBe('https://notion.so/p1');
  });

  it('is idempotent — a second sync of the same page creates nothing', async () => {
    const connector = fakeConnector([cand({ pageId: 'p1', projectValue: 'symphony' })]);
    await runSync(h, connector);
    const second = await runSync(h, connector);
    const sc = second.structuredContent as { createdCount: number; skippedExisting: number };
    expect(sc.createdCount).toBe(0);
    expect(sc.skippedExisting).toBe(1);
    expect(h.tasks.size()).toBe(1);
  });

  it('skips pages already in a terminal Notion status', async () => {
    const connector = fakeConnector([
      cand({ pageId: 'done-1', status: 'completed', projectValue: 'symphony' }),
    ]);
    const result = await runSync(h, connector);
    const sc = result.structuredContent as { createdCount: number; skippedDone: number };
    expect(sc.createdCount).toBe(0);
    expect(sc.skippedDone).toBe(1);
    expect(h.tasks.size()).toBe(0);
  });

  it('falls back to the explicit project arg when the Notion value is unknown', async () => {
    const connector = fakeConnector([cand({ pageId: 'p1', projectValue: 'NotARegisteredName' })]);
    const result = await runSync(h, connector, { project: 'other' });
    const sc = result.structuredContent as { created: string[] };
    expect(h.tasks.get(sc.created[0]!)?.projectId).toBe('other');
  });

  it('falls back to resolveProjectPath when no project value or arg routes', async () => {
    const connector = fakeConnector([cand({ pageId: 'p1', projectValue: null })]);
    // resolveProjectPath returns an absolute path; the registry stores
    // path.resolve'd paths, so return the stored path to match (the real
    // server's resolver is already absolute).
    const symphonyPath = h.projects.get('symphony')!.path;
    const result = await runSync(h, connector, {}, () => symphonyPath);
    const sc = result.structuredContent as { created: string[] };
    expect(h.tasks.get(sc.created[0]!)?.projectId).toBe('proj');
  });

  it('reports unroutable pages without creating a task', async () => {
    const connector = fakeConnector([cand({ pageId: 'p1', projectValue: null })]);
    const result = await runSync(h, connector);
    const sc = result.structuredContent as { createdCount: number; skippedNoProject: number; errors: string[] };
    expect(sc.createdCount).toBe(0);
    expect(sc.skippedNoProject).toBe(1);
    expect(sc.errors.length).toBe(1);
    expect(h.tasks.size()).toBe(0);
  });

  it('audit M2 — a throwing resolveProjectPath routes the page to unroutable, not a crash', async () => {
    const connector = fakeConnector([
      cand({ pageId: 'p1', title: 'Routable', projectValue: 'symphony' }),
      cand({ pageId: 'p2', title: 'Bad arg', projectValue: null }),
    ]);
    // Mirror the server resolver: throws for an unknown non-absolute name.
    const throwingResolver = (p?: string): string => {
      if (p === undefined) return h.projects.get('symphony')!.path;
      throw new Error(`Unknown project '${p}'`);
    };
    const result = await runSync(h, connector, { project: 'nope' }, throwingResolver);
    const sc = result.structuredContent as {
      createdCount: number;
      skippedNoProject: number;
    };
    // The good page still imports; the bad one is reported, not fatal.
    expect(result.isError).toBeFalsy();
    expect(sc.createdCount).toBe(1);
    expect(sc.skippedNoProject).toBe(1);
  });

  it('surfaces a connector fetch error as an isError result', async () => {
    const connector: NotionConnectorHandle = {
      fetchOpenPages: async () => {
        throw new Error('Notion API 401 unauthorized');
      },
      writeBackStatus: async () => ({ written: false }),
    };
    const result = await runSync(h, connector);
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('401');
  });
});
