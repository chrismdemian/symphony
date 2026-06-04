import { beforeEach, describe, expect, it } from 'vitest';
import { makeSyncIssuesTool } from '../../../src/orchestrator/tools/make-sync-issues.js';
import { ProjectRegistry } from '../../../src/projects/registry.js';
import { TaskRegistry } from '../../../src/state/task-registry.js';
import { MemoryExternalLinkStore } from '../../../src/state/external-link-store.js';
import type {
  IssueConnectorHandle,
  NormalizedIssue,
} from '../../../src/integrations/issue-connector.js';
import type { DispatchContext } from '../../../src/orchestrator/types.js';

function fakeCtx(): DispatchContext {
  return { mode: 'act', tier: 2 } as unknown as DispatchContext;
}

function issue(over: Partial<NormalizedIssue>): NormalizedIssue {
  return {
    externalId: 'iss-1',
    title: 'Task one',
    url: 'https://linear.app/iss-1',
    state: 'Todo',
    isTerminal: false,
    body: null,
    assignee: null,
    labels: [],
    projectValue: null,
    priority: 0,
    updatedAt: null,
    ...over,
  };
}

function fakeConnector(issues: NormalizedIssue[], over: Partial<IssueConnectorHandle> = {}): IssueConnectorHandle {
  return {
    source: 'linear',
    fetchOpenIssues: async () => issues,
    writeBackStatus: async () => ({ written: false, code: 'skipped' }),
    checkConnection: async () => ({ ok: true }),
    ...over,
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
  const tasks = new TaskRegistry({ projectStore: projects });
  const links = new MemoryExternalLinkStore();
  return { projects, tasks, links };
}

function runSync(h: Harness, connector: IssueConnectorHandle, args: { limit?: number; project?: string } = {}) {
  const tool = makeSyncIssuesTool({
    connector,
    name: 'sync_linear',
    description: 'desc',
    taskStore: h.tasks,
    projectStore: h.projects,
    externalLinkStore: h.links,
  });
  const handlerArgs = { limit: args.limit, project: args.project };
  return tool.handler(handlerArgs as Parameters<typeof tool.handler>[0], fakeCtx());
}

describe('makeSyncIssuesTool', () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it('declares the secrets/network/external-visible capabilities + given name', () => {
    const tool = makeSyncIssuesTool({
      connector: fakeConnector([]),
      name: 'sync_linear',
      description: 'd',
      taskStore: h.tasks,
      projectStore: h.projects,
      externalLinkStore: h.links,
    });
    expect(tool.name).toBe('sync_linear');
    expect(tool.scope).toBe('both');
    expect(tool.capabilities).toEqual([
      'requires-secrets-read',
      'requires-network-egress-uncontrolled',
      'external-visible',
    ]);
  });

  it('creates a task per new issue keyed by the connector source', async () => {
    const res = await runSync(h, fakeConnector([issue({ externalId: 'a', title: 'Fix', projectValue: 'symphony' })]));
    const sc = res.structuredContent as { createdCount: number; created: string[] };
    expect(sc.createdCount).toBe(1);
    expect(h.links.getByExternal('linear', 'a')).toBeDefined();
    expect(res.content[0]?.text).toContain('Synced Linear');
  });

  it('passes the limit through to the connector', async () => {
    let seenLimit: number | undefined;
    const connector = fakeConnector([], {
      fetchOpenIssues: async (opts) => {
        seenLimit = opts?.limit;
        return [];
      },
    });
    await runSync(h, connector, { limit: 7 });
    expect(seenLimit).toBe(7);
  });

  it('surfaces a connector fetch error as isError', async () => {
    const connector = fakeConnector([], {
      fetchOpenIssues: async () => {
        throw new Error('Linear API 401 unauthorized');
      },
    });
    const res = await runSync(h, connector);
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain('sync_linear failed');
    expect(res.content[0]?.text).toContain('401');
  });
});
