import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  startOrchestratorServer,
  type OrchestratorServerHandle,
} from '../../src/orchestrator/index.js';
import { SymphonyDatabase } from '../../src/state/db.js';
import { SqliteExternalLinkStore } from '../../src/state/sqlite-external-link-store.js';
import { GitHubConnector } from '../../src/integrations/github.js';
import { defaultGitHubConfig } from '../../src/integrations/github-config.js';
import type { GitHubClientLike, GitHubIssueNode } from '../../src/integrations/github-client.js';

/**
 * Phase 8C.2 integration — real SQLite + a real orchestrator server + MCP
 * client + a REAL `GitHubConnector` over an injected `GitHubClientLike` fake
 * (no live API). Proves the full wire: sync_github creates tasks + links
 * idempotently across repos, excludes PRs / terminal issues, persists external
 * links across a fresh store, and a terminal task transition pushes status back
 * (comment + close) to the client.
 */

interface FakeClient extends GitHubClientLike {
  readonly commentCalls: { repo: string; number: number; body: string }[];
  readonly closeCalls: { repo: string; number: number }[];
}

function node(over: Partial<GitHubIssueNode>): GitHubIssueNode {
  return {
    repo: 'acme/app',
    id: 1,
    number: 1,
    title: 'Issue',
    body: null,
    state: 'open',
    htmlUrl: 'https://github.com/acme/app/issues/1',
    updatedAt: '2026-06-01T00:00:00Z',
    labels: [],
    assignee: null,
    ...over,
  };
}

function fakeClient(issuesByRepo: Record<string, GitHubIssueNode[]>): FakeClient {
  const commentCalls: FakeClient['commentCalls'] = [];
  const closeCalls: FakeClient['closeCalls'] = [];
  return {
    commentCalls,
    closeCalls,
    listOpenIssues: async (repo) => issuesByRepo[repo] ?? [],
    searchIssues: async () => [],
    addComment: async (repo, number, body) => {
      commentCalls.push({ repo, number, body });
    },
    closeIssue: async (repo, number) => {
      closeCalls.push({ repo, number });
    },
    getViewer: async () => ({ login: 'octocat' }),
  };
}

interface Harness {
  client: Client;
  server: OrchestratorServerHandle;
  gh: FakeClient;
  db: SymphonyDatabase;
  dbFile: string;
}

async function setup(
  issuesByRepo: Record<string, GitHubIssueNode[]>,
  repos: string[],
): Promise<Harness> {
  const dbFile = `:memory:`;
  const db = SymphonyDatabase.open({ filePath: dbFile });
  const gh = fakeClient(issuesByRepo);
  const connector = new GitHubConnector({
    client: gh,
    config: { ...defaultGitHubConfig(), repos },
    sleep: () => Promise.resolve(),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const projects: Record<string, string> = {};
  for (const r of repos) projects[r] = `/tmp/8c2-${r.replace(/\//g, '-')}`;
  const server = await startOrchestratorServer({
    transport: serverTransport,
    initialMode: 'act',
    // sync_github declares requires-secrets-read / network-egress /
    // external-visible — all require autonomy tier >= 2.
    initialTier: 2,
    database: db,
    projects,
    githubConnector: connector,
  });
  const client = new Client({ name: '8c2-integration', version: '0.0.0' });
  await client.connect(clientTransport);
  return { client, server, gh, db, dbFile };
}

async function flush(): Promise<void> {
  await new Promise((r) => setImmediate(r));
  await Promise.resolve();
}

describe('Phase 8C.2 — GitHub sync (integration)', () => {
  let h: Harness | null = null;
  afterEach(async () => {
    if (!h) return;
    await h.client.close().catch(() => {});
    await h.server.close().catch(() => {});
    h.db.close();
    h = null;
  });

  it('sync_github creates a task + link per open issue across repos, skips terminal, idempotently', async () => {
    h = await setup(
      {
        'acme/app': [
          node({ repo: 'acme/app', number: 1, title: 'First', labels: ['high'] }),
          node({ repo: 'acme/app', number: 2, title: 'Closed', state: 'closed' }),
        ],
        'acme/api': [node({ repo: 'acme/api', number: 9, title: 'Second' })],
      },
      ['acme/app', 'acme/api'],
    );

    const res = await h.client.callTool({ name: 'sync_github', arguments: {} });
    expect(res.isError).toBeFalsy();
    const sc = res.structuredContent as {
      createdCount: number;
      skippedDone: number;
      created: string[];
    };
    expect(sc.createdCount).toBe(2);
    expect(sc.skippedDone).toBe(1);

    expect(h.server.taskStore.size()).toBe(2);
    expect(h.server.externalLinkStore.getByExternal('github', 'acme/app#1')).toBeDefined();
    expect(h.server.externalLinkStore.getByExternal('github', 'acme/api#9')).toBeDefined();
    expect(h.server.externalLinkStore.getByExternal('github', 'acme/app#2')).toBeUndefined();

    const res2 = await h.client.callTool({ name: 'sync_github', arguments: {} });
    const sc2 = res2.structuredContent as { createdCount: number; skippedExisting: number };
    expect(sc2.createdCount).toBe(0);
    expect(sc2.skippedExisting).toBe(2);
    expect(h.server.taskStore.size()).toBe(2);
  });

  it('persists external links to SQLite (visible from a fresh store over the same db)', async () => {
    h = await setup({ 'acme/app': [node({ repo: 'acme/app', number: 5 })] }, ['acme/app']);
    await h.client.callTool({ name: 'sync_github', arguments: {} });
    const fresh = new SqliteExternalLinkStore(h.db.db);
    expect(fresh.listExternalIds('github')).toEqual(new Set(['acme/app#5']));
  });

  it('completion fires the writeback hook → real connector comments then closes', async () => {
    h = await setup({ 'acme/app': [node({ repo: 'acme/app', number: 77, title: 'Closeable' })] }, [
      'acme/app',
    ]);
    const res = await h.client.callTool({ name: 'sync_github', arguments: {} });
    const taskId = (res.structuredContent as { created: string[] }).created[0]!;

    h.server.taskStore.update(taskId, { status: 'in_progress' });
    h.server.taskStore.update(taskId, { status: 'completed' });
    await flush();
    await flush();

    expect(h.gh.commentCalls).toEqual([
      { repo: 'acme/app', number: 77, body: 'Completed by Symphony.' },
    ]);
    expect(h.gh.closeCalls).toEqual([{ repo: 'acme/app', number: 77 }]);
  });

  it('does not write back for a task with no GitHub link', async () => {
    h = await setup({}, ['acme/app']);
    const projId = h.server.projectStore.get('acme/app')!.id;
    const task = h.server.taskStore.create({ projectId: projId, description: 'local task' });
    h.server.taskStore.update(task.id, { status: 'in_progress' });
    h.server.taskStore.update(task.id, { status: 'completed' });
    await flush();
    expect(h.gh.commentCalls).toEqual([]);
    expect(h.gh.closeCalls).toEqual([]);
  });
});
