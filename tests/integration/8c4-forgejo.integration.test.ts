import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  startOrchestratorServer,
  type OrchestratorServerHandle,
} from '../../src/orchestrator/index.js';
import { SymphonyDatabase } from '../../src/state/db.js';
import { SqliteExternalLinkStore } from '../../src/state/sqlite-external-link-store.js';
import { ForgejoConnector } from '../../src/integrations/forgejo.js';
import { defaultForgejoConfig } from '../../src/integrations/forgejo-config.js';
import type { ForgejoClientLike, ForgejoIssueNode } from '../../src/integrations/forgejo-client.js';

// The scenarios/integration configs don't load tests/setup.ts in every path;
// this test injects the connector + fake client and never reads tokens.
process.env.SYMPHONY_DISABLE_KEYRING = '1';

/**
 * Phase 8C.4 integration — real SQLite + a real orchestrator server + MCP client
 * + a REAL `ForgejoConnector` over an injected `ForgejoClientLike` fake (no live
 * API). Proves the full wire: sync_forgejo creates tasks + links idempotently
 * across repos, skips terminal issues, persists external links across a fresh
 * store, and a terminal task transition pushes status back (comment + close)
 * using the issue `number`.
 */

interface FakeClient extends ForgejoClientLike {
  readonly commentCalls: { repo: string; number: number; body: string }[];
  readonly closeCalls: { repo: string; number: number }[];
}

function node(over: Partial<ForgejoIssueNode>): ForgejoIssueNode {
  return {
    repo: 'acme/app',
    id: 1000,
    number: 1,
    title: 'Issue',
    body: null,
    state: 'open',
    htmlUrl: 'https://code.acme.com/acme/app/issues/1',
    updatedAt: '2026-06-01T00:00:00Z',
    labels: [],
    assignee: null,
    ...over,
  };
}

function fakeClient(issuesByRepo: Record<string, ForgejoIssueNode[]>): FakeClient {
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
    getViewer: async () => ({ login: 'forgejo-user' }),
  };
}

interface Harness {
  client: Client;
  server: OrchestratorServerHandle;
  fj: FakeClient;
  db: SymphonyDatabase;
}

async function setup(
  issuesByRepo: Record<string, ForgejoIssueNode[]>,
  repos: string[],
): Promise<Harness> {
  const db = SymphonyDatabase.open({ filePath: ':memory:' });
  const fj = fakeClient(issuesByRepo);
  const connector = new ForgejoConnector({
    client: fj,
    config: { ...defaultForgejoConfig(), siteUrl: 'https://code.acme.com', repos },
    sleep: () => Promise.resolve(),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const projectPaths: Record<string, string> = {};
  for (const r of repos) projectPaths[r] = `/tmp/8c4fj-${r.replace(/\//g, '-')}`;
  const server = await startOrchestratorServer({
    transport: serverTransport,
    initialMode: 'act',
    initialTier: 2,
    database: db,
    projects: projectPaths,
    forgejoConnector: connector,
  });
  const client = new Client({ name: '8c4-forgejo-integration', version: '0.0.0' });
  await client.connect(clientTransport);
  return { client, server, fj, db };
}

async function flush(): Promise<void> {
  await new Promise((r) => setImmediate(r));
  await Promise.resolve();
}

describe('Phase 8C.4 — Forgejo sync (integration)', () => {
  let h: Harness | null = null;
  afterEach(async () => {
    if (!h) return;
    await h.client.close().catch(() => {});
    await h.server.close().catch(() => {});
    h.db.close();
    h = null;
  });

  it('sync_forgejo creates a task + link per open issue across repos, skips terminal, idempotently', async () => {
    h = await setup(
      {
        'acme/app': [
          node({ repo: 'acme/app', number: 1, title: 'First', labels: ['priority/high'] }),
          node({ repo: 'acme/app', number: 2, title: 'Closed', state: 'closed' }),
        ],
        'acme/api': [node({ repo: 'acme/api', number: 9, title: 'Second' })],
      },
      ['acme/app', 'acme/api'],
    );

    const res = await h.client.callTool({ name: 'sync_forgejo', arguments: {} });
    expect(res.isError).toBeFalsy();
    const sc = res.structuredContent as { createdCount: number; skippedDone: number };
    expect(sc.createdCount).toBe(2);
    expect(sc.skippedDone).toBe(1);

    expect(h.server.taskStore.size()).toBe(2);
    expect(h.server.externalLinkStore.getByExternal('forgejo', 'acme/app#1')).toBeDefined();
    expect(h.server.externalLinkStore.getByExternal('forgejo', 'acme/api#9')).toBeDefined();
    expect(h.server.externalLinkStore.getByExternal('forgejo', 'acme/app#2')).toBeUndefined();

    const res2 = await h.client.callTool({ name: 'sync_forgejo', arguments: {} });
    const sc2 = res2.structuredContent as { createdCount: number; skippedExisting: number };
    expect(sc2.createdCount).toBe(0);
    expect(sc2.skippedExisting).toBe(2);
  });

  it('persists external links to SQLite (visible from a fresh store over the same db)', async () => {
    h = await setup({ 'acme/app': [node({ repo: 'acme/app', number: 5 })] }, ['acme/app']);
    await h.client.callTool({ name: 'sync_forgejo', arguments: {} });
    const fresh = new SqliteExternalLinkStore(h.db.db);
    expect(fresh.listExternalIds('forgejo')).toEqual(new Set(['acme/app#5']));
  });

  it('completion fires the writeback hook → real connector comments then closes (by number)', async () => {
    h = await setup({ 'acme/app': [node({ repo: 'acme/app', number: 77, id: 5000, title: 'Closeable' })] }, [
      'acme/app',
    ]);
    const res = await h.client.callTool({ name: 'sync_forgejo', arguments: {} });
    const taskId = (res.structuredContent as { created: string[] }).created[0]!;

    h.server.taskStore.update(taskId, { status: 'in_progress' });
    h.server.taskStore.update(taskId, { status: 'completed' });
    await flush();
    await flush();

    expect(h.fj.commentCalls).toEqual([{ repo: 'acme/app', number: 77, body: 'Completed by Symphony.' }]);
    expect(h.fj.closeCalls).toEqual([{ repo: 'acme/app', number: 77 }]);
  });

  it('does not write back for a task with no Forgejo link', async () => {
    h = await setup({}, ['acme/app']);
    const projId = h.server.projectStore.get('acme/app')!.id;
    const task = h.server.taskStore.create({ projectId: projId, description: 'local task' });
    h.server.taskStore.update(task.id, { status: 'in_progress' });
    h.server.taskStore.update(task.id, { status: 'completed' });
    await flush();
    expect(h.fj.commentCalls).toEqual([]);
    expect(h.fj.closeCalls).toEqual([]);
  });
});
