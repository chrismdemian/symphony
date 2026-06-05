import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  startOrchestratorServer,
  type OrchestratorServerHandle,
} from '../../src/orchestrator/index.js';
import { SymphonyDatabase } from '../../src/state/db.js';
import { SqliteExternalLinkStore } from '../../src/state/sqlite-external-link-store.js';
import { GitLabConnector } from '../../src/integrations/gitlab.js';
import { defaultGitLabConfig } from '../../src/integrations/gitlab-config.js';
import type { GitLabClientLike, GitLabIssueNode } from '../../src/integrations/gitlab-client.js';

/**
 * Phase 8C.3 integration — real SQLite + a real orchestrator server + MCP
 * client + a REAL `GitLabConnector` over an injected `GitLabClientLike` fake (no
 * live API). Proves the full wire: sync_gitlab creates tasks + links idempotently
 * across projects, skips terminal issues, persists external links across a fresh
 * store, and a terminal task transition pushes status back (note + close) using
 * the issue `iid`.
 */

interface FakeClient extends GitLabClientLike {
  readonly noteCalls: { projectPath: string; iid: number; body: string }[];
  readonly closeCalls: { projectPath: string; iid: number }[];
}

function node(over: Partial<GitLabIssueNode>): GitLabIssueNode {
  return {
    projectPath: 'acme/app',
    id: 1000,
    iid: 1,
    title: 'Issue',
    body: null,
    state: 'opened',
    webUrl: 'https://gitlab.com/acme/app/-/issues/1',
    updatedAt: '2026-06-01T00:00:00Z',
    labels: [],
    assignee: null,
    ...over,
  };
}

function fakeClient(issuesByProject: Record<string, GitLabIssueNode[]>): FakeClient {
  const noteCalls: FakeClient['noteCalls'] = [];
  const closeCalls: FakeClient['closeCalls'] = [];
  return {
    noteCalls,
    closeCalls,
    listOpenIssues: async (projectPath) => issuesByProject[projectPath] ?? [],
    searchIssues: async () => [],
    addNote: async (projectPath, iid, body) => {
      noteCalls.push({ projectPath, iid, body });
    },
    closeIssue: async (projectPath, iid) => {
      closeCalls.push({ projectPath, iid });
    },
    getViewer: async () => ({ username: 'gitlab-user' }),
  };
}

interface Harness {
  client: Client;
  server: OrchestratorServerHandle;
  gl: FakeClient;
  db: SymphonyDatabase;
}

async function setup(
  issuesByProject: Record<string, GitLabIssueNode[]>,
  projects: string[],
): Promise<Harness> {
  const db = SymphonyDatabase.open({ filePath: ':memory:' });
  const gl = fakeClient(issuesByProject);
  const connector = new GitLabConnector({
    client: gl,
    config: { ...defaultGitLabConfig(), projects },
    sleep: () => Promise.resolve(),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const projectPaths: Record<string, string> = {};
  for (const p of projects) projectPaths[p] = `/tmp/8c3gl-${p.replace(/\//g, '-')}`;
  const server = await startOrchestratorServer({
    transport: serverTransport,
    initialMode: 'act',
    initialTier: 2,
    database: db,
    projects: projectPaths,
    gitlabConnector: connector,
  });
  const client = new Client({ name: '8c3-gitlab-integration', version: '0.0.0' });
  await client.connect(clientTransport);
  return { client, server, gl, db };
}

async function flush(): Promise<void> {
  await new Promise((r) => setImmediate(r));
  await Promise.resolve();
}

describe('Phase 8C.3 — GitLab sync (integration)', () => {
  let h: Harness | null = null;
  afterEach(async () => {
    if (!h) return;
    await h.client.close().catch(() => {});
    await h.server.close().catch(() => {});
    h.db.close();
    h = null;
  });

  it('sync_gitlab creates a task + link per open issue across projects, skips terminal, idempotently', async () => {
    h = await setup(
      {
        'acme/app': [
          node({ projectPath: 'acme/app', iid: 1, title: 'First', labels: ['priority::high'] }),
          node({ projectPath: 'acme/app', iid: 2, title: 'Closed', state: 'closed' }),
        ],
        'acme/api': [node({ projectPath: 'acme/api', iid: 9, title: 'Second' })],
      },
      ['acme/app', 'acme/api'],
    );

    const res = await h.client.callTool({ name: 'sync_gitlab', arguments: {} });
    expect(res.isError).toBeFalsy();
    const sc = res.structuredContent as { createdCount: number; skippedDone: number };
    expect(sc.createdCount).toBe(2);
    expect(sc.skippedDone).toBe(1);

    expect(h.server.taskStore.size()).toBe(2);
    expect(h.server.externalLinkStore.getByExternal('gitlab', 'acme/app#1')).toBeDefined();
    expect(h.server.externalLinkStore.getByExternal('gitlab', 'acme/api#9')).toBeDefined();
    expect(h.server.externalLinkStore.getByExternal('gitlab', 'acme/app#2')).toBeUndefined();

    const res2 = await h.client.callTool({ name: 'sync_gitlab', arguments: {} });
    const sc2 = res2.structuredContent as { createdCount: number; skippedExisting: number };
    expect(sc2.createdCount).toBe(0);
    expect(sc2.skippedExisting).toBe(2);
  });

  it('persists external links to SQLite (visible from a fresh store over the same db)', async () => {
    h = await setup({ 'acme/app': [node({ projectPath: 'acme/app', iid: 5 })] }, ['acme/app']);
    await h.client.callTool({ name: 'sync_gitlab', arguments: {} });
    const fresh = new SqliteExternalLinkStore(h.db.db);
    expect(fresh.listExternalIds('gitlab')).toEqual(new Set(['acme/app#5']));
  });

  it('completion fires the writeback hook → real connector notes then closes (by iid)', async () => {
    h = await setup({ 'acme/app': [node({ projectPath: 'acme/app', iid: 77, id: 5000, title: 'Closeable' })] }, [
      'acme/app',
    ]);
    const res = await h.client.callTool({ name: 'sync_gitlab', arguments: {} });
    const taskId = (res.structuredContent as { created: string[] }).created[0]!;

    h.server.taskStore.update(taskId, { status: 'in_progress' });
    h.server.taskStore.update(taskId, { status: 'completed' });
    await flush();
    await flush();

    expect(h.gl.noteCalls).toEqual([{ projectPath: 'acme/app', iid: 77, body: 'Completed by Symphony.' }]);
    expect(h.gl.closeCalls).toEqual([{ projectPath: 'acme/app', iid: 77 }]);
  });

  it('does not write back for a task with no GitLab link', async () => {
    h = await setup({}, ['acme/app']);
    const projId = h.server.projectStore.get('acme/app')!.id;
    const task = h.server.taskStore.create({ projectId: projId, description: 'local task' });
    h.server.taskStore.update(task.id, { status: 'in_progress' });
    h.server.taskStore.update(task.id, { status: 'completed' });
    await flush();
    expect(h.gl.noteCalls).toEqual([]);
    expect(h.gl.closeCalls).toEqual([]);
  });
});
