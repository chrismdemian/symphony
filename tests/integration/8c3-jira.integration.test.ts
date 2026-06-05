import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  startOrchestratorServer,
  type OrchestratorServerHandle,
} from '../../src/orchestrator/index.js';
import { SymphonyDatabase } from '../../src/state/db.js';
import { SqliteExternalLinkStore } from '../../src/state/sqlite-external-link-store.js';
import { JiraConnector } from '../../src/integrations/jira.js';
import { defaultJiraConfig } from '../../src/integrations/jira-config.js';
import type {
  JiraClientLike,
  JiraIssueNode,
  JiraTransition,
} from '../../src/integrations/jira-client.js';

/**
 * Phase 8C.3 integration — real SQLite + a real orchestrator server + MCP
 * client + a REAL `JiraConnector` over an injected `JiraClientLike` fake (no live
 * API). Proves the full wire: sync_jira creates tasks + links idempotently via
 * the JQL fallback chain, skips Done-category issues, persists external links
 * across a fresh store, and a terminal task transition pushes status back
 * (comment + transition to Done).
 */

interface FakeClient extends JiraClientLike {
  readonly commentCalls: { key: string; text: string }[];
  readonly transitionCalls: { key: string; transitionId: string }[];
}

function node(over: Partial<JiraIssueNode>): JiraIssueNode {
  return {
    key: 'ENG-1',
    summary: 'Issue',
    description: null,
    webUrl: 'https://acme.atlassian.net/browse/ENG-1',
    statusName: 'To Do',
    statusCategoryKey: 'new',
    priorityName: null,
    labels: [],
    assignee: null,
    projectKey: 'ENG',
    updatedAt: '2026-06-01T00:00:00Z',
    ...over,
  };
}

function fakeClient(issues: JiraIssueNode[], transitions: JiraTransition[]): FakeClient {
  const commentCalls: FakeClient['commentCalls'] = [];
  const transitionCalls: FakeClient['transitionCalls'] = [];
  return {
    commentCalls,
    transitionCalls,
    // The first JQL candidate (assignee, since no projectKeys) returns the set.
    searchByJql: async (jql) => (jql.startsWith('assignee') ? issues : []),
    getRecentIssueKeys: async () => [],
    getIssue: async () => null,
    getTransitions: async () => transitions,
    transitionIssue: async (key, transitionId) => {
      transitionCalls.push({ key, transitionId });
    },
    addComment: async (key, text) => {
      commentCalls.push({ key, text });
    },
    getMyself: async () => ({ displayName: 'jira-user' }),
  };
}

interface Harness {
  client: Client;
  server: OrchestratorServerHandle;
  jira: FakeClient;
  db: SymphonyDatabase;
}

async function setup(issues: JiraIssueNode[], transitions: JiraTransition[]): Promise<Harness> {
  const db = SymphonyDatabase.open({ filePath: ':memory:' });
  const jira = fakeClient(issues, transitions);
  const connector = new JiraConnector({
    client: jira,
    config: { ...defaultJiraConfig(), siteUrl: 'https://acme.atlassian.net', email: 'me@acme.io' },
    sleep: () => Promise.resolve(),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = await startOrchestratorServer({
    transport: serverTransport,
    initialMode: 'act',
    initialTier: 2,
    database: db,
    projects: { ENG: '/tmp/8c3jira-eng' },
    jiraConnector: connector,
  });
  const client = new Client({ name: '8c3-jira-integration', version: '0.0.0' });
  await client.connect(clientTransport);
  return { client, server, jira, db };
}

async function flush(): Promise<void> {
  await new Promise((r) => setImmediate(r));
  await Promise.resolve();
}

describe('Phase 8C.3 — Jira sync (integration)', () => {
  let h: Harness | null = null;
  afterEach(async () => {
    if (!h) return;
    await h.client.close().catch(() => {});
    await h.server.close().catch(() => {});
    h.db.close();
    h = null;
  });

  it('sync_jira creates a task + link per open issue, skips Done-category, idempotently', async () => {
    h = await setup(
      [
        node({ key: 'ENG-1', summary: 'First', priorityName: 'High' }),
        node({ key: 'ENG-2', summary: 'Done one', statusCategoryKey: 'done', statusName: 'Done' }),
      ],
      [],
    );

    const res = await h.client.callTool({ name: 'sync_jira', arguments: {} });
    expect(res.isError).toBeFalsy();
    const sc = res.structuredContent as { createdCount: number; skippedDone: number };
    expect(sc.createdCount).toBe(1);
    expect(sc.skippedDone).toBe(1);

    expect(h.server.taskStore.size()).toBe(1);
    expect(h.server.externalLinkStore.getByExternal('jira', 'ENG-1')).toBeDefined();
    expect(h.server.externalLinkStore.getByExternal('jira', 'ENG-2')).toBeUndefined();

    const res2 = await h.client.callTool({ name: 'sync_jira', arguments: {} });
    const sc2 = res2.structuredContent as { createdCount: number; skippedExisting: number };
    expect(sc2.createdCount).toBe(0);
    expect(sc2.skippedExisting).toBe(1);
  });

  it('persists external links to SQLite (visible from a fresh store over the same db)', async () => {
    h = await setup([node({ key: 'ENG-5' })], []);
    await h.client.callTool({ name: 'sync_jira', arguments: {} });
    const fresh = new SqliteExternalLinkStore(h.db.db);
    expect(fresh.listExternalIds('jira')).toEqual(new Set(['ENG-5']));
  });

  it('completion fires the writeback hook → real connector comments then transitions to Done', async () => {
    h = await setup(
      [node({ key: 'ENG-77', summary: 'Closeable' })],
      [
        { id: '11', name: 'In Progress', toStatusCategoryKey: 'indeterminate' },
        { id: '31', name: 'Done', toStatusCategoryKey: 'done' },
      ],
    );
    const res = await h.client.callTool({ name: 'sync_jira', arguments: {} });
    const taskId = (res.structuredContent as { created: string[] }).created[0]!;

    h.server.taskStore.update(taskId, { status: 'in_progress' });
    h.server.taskStore.update(taskId, { status: 'completed' });
    await flush();
    await flush();

    expect(h.jira.commentCalls).toEqual([{ key: 'ENG-77', text: 'Completed by Symphony.' }]);
    expect(h.jira.transitionCalls).toEqual([{ key: 'ENG-77', transitionId: '31' }]);
  });

  it('does not write back for a task with no Jira link', async () => {
    h = await setup([], []);
    const projId = h.server.projectStore.get('ENG')!.id;
    const task = h.server.taskStore.create({ projectId: projId, description: 'local task' });
    h.server.taskStore.update(task.id, { status: 'in_progress' });
    h.server.taskStore.update(task.id, { status: 'completed' });
    await flush();
    expect(h.jira.commentCalls).toEqual([]);
    expect(h.jira.transitionCalls).toEqual([]);
  });
});
