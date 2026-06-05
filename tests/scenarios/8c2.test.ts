import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

// The scenarios config does not load tests/setup.ts — guard the keychain anyway
// (this test injects the connector + a fake client and never reads tokens).
process.env.SYMPHONY_DISABLE_KEYRING = '1';

/**
 * Phase 8C.2 production scenario — see 8c2.md. Real server + temp-file SQLite +
 * a REAL GitHubConnector over an injected fake GitHubClientLike. Adds the
 * persistence-across-fresh-store leg + the on-the-wire writeback (real connector
 * posts a comment then closes the issue).
 */

function node(over: Partial<GitHubIssueNode>): GitHubIssueNode {
  return {
    repo: 'acme/app',
    id: 1,
    number: 1,
    title: 'Issue',
    body: null,
    state: 'open',
    htmlUrl: 'https://github.com/acme/app/issues/1',
    updatedAt: '2026-06-10T09:00:00Z',
    labels: [],
    assignee: null,
    ...over,
  };
}

interface FakeClient extends GitHubClientLike {
  readonly commentCalls: { repo: string; number: number; body: string }[];
  readonly closeCalls: { repo: string; number: number }[];
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
    getViewer: async () => ({ login: 'chris' }),
  };
}

interface Harness {
  client: Client;
  server: OrchestratorServerHandle;
  fake: FakeClient;
  db: SymphonyDatabase;
  tmpRoot: string;
}

async function setup(): Promise<Harness> {
  const tmpRoot = mkdtempSync(path.join(tmpdir(), 'symphony-8c2-'));
  const dbFile = path.join(tmpRoot, 'symphony.db');
  const db = SymphonyDatabase.open({ filePath: dbFile });

  const fake = fakeClient({
    'acme/app': [
      node({ repo: 'acme/app', number: 1, title: 'Open app', labels: ['high'] }),
      node({ repo: 'acme/app', number: 2, title: 'Closed app', state: 'closed' }),
    ],
    'acme/api': [node({ repo: 'acme/api', number: 9, title: 'Open api' })],
  });
  const connector = new GitHubConnector({
    client: fake,
    config: { ...defaultGitHubConfig(), repos: ['acme/app', 'acme/api'] },
    sleep: () => Promise.resolve(),
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = await startOrchestratorServer({
    transport: serverTransport,
    initialMode: 'act',
    initialTier: 2, // sync_github is secrets/network/external-visible → tier >= 2
    database: db,
    projects: {
      'acme/app': path.join(tmpRoot, 'app'),
      'acme/api': path.join(tmpRoot, 'api'),
    },
    githubConnector: connector,
  });
  const client = new Client({ name: '8c2-scenario', version: '0.0.0' });
  await client.connect(clientTransport);
  return { client, server, fake, db, tmpRoot };
}

async function flush(): Promise<void> {
  await new Promise((r) => setImmediate(r));
  await Promise.resolve();
}

describe('Phase 8C.2 — production scenario (real server, real connector, temp-file SQLite)', () => {
  let h: Harness | null = null;

  beforeEach(async () => {
    h = await setup();
  });

  afterEach(async () => {
    if (!h) return;
    await h.client.close().catch(() => {});
    await h.server.close().catch(() => {});
    h.db.close();
    try {
      rmSync(h.tmpRoot, { recursive: true, force: true, maxRetries: 5 });
    } catch {
      /* windows file-lock retry — best effort */
    }
    h = null;
  });

  it('syncs across repos, skips closed, dedups, persists links, and writes back on completion', async () => {
    const cur = h!;

    // (1) create + route by repo; skip the closed issue
    const res = await cur.client.callTool({ name: 'sync_github', arguments: {} });
    expect(res.isError).toBeFalsy();
    const sc = res.structuredContent as { createdCount: number; skippedDone: number };
    expect(sc.createdCount).toBe(2); // app#1 + api#9 open
    expect(sc.skippedDone).toBe(1); // app#2 closed
    expect(cur.server.taskStore.size()).toBe(2);

    // (2) idempotent re-sync
    const res2 = await cur.client.callTool({ name: 'sync_github', arguments: {} });
    const sc2 = res2.structuredContent as { createdCount: number; skippedExisting: number };
    expect(sc2.createdCount).toBe(0);
    expect(sc2.skippedExisting).toBe(2);

    // (3) persistence across a fresh store over the SAME db file
    const fresh = new SqliteExternalLinkStore(cur.db.db);
    expect(fresh.listExternalIds('github')).toEqual(new Set(['acme/app#1', 'acme/api#9']));

    // (4) writeback on completion → real connector comments then closes
    const closeable = cur.server.taskStore.list().find((t) => t.description === 'Open app');
    expect(closeable).toBeDefined();
    cur.server.taskStore.update(closeable!.id, { status: 'in_progress' });
    cur.server.taskStore.update(closeable!.id, { status: 'completed' });
    await flush();
    await new Promise((r) => setTimeout(r, 30)); // throttle + fire-and-forget settle

    expect(cur.fake.commentCalls).toEqual([
      { repo: 'acme/app', number: 1, body: 'Completed by Symphony.' },
    ]);
    expect(cur.fake.closeCalls).toEqual([{ repo: 'acme/app', number: 1 }]);
  });
});
