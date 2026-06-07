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
import { PlainConnector } from '../../src/integrations/plain.js';
import { defaultPlainConfig } from '../../src/integrations/plain-config.js';
import type { PlainClientLike, PlainThreadNode } from '../../src/integrations/plain-client.js';
import { ForgejoConnector } from '../../src/integrations/forgejo.js';
import { defaultForgejoConfig } from '../../src/integrations/forgejo-config.js';
import type { ForgejoClientLike, ForgejoIssueNode } from '../../src/integrations/forgejo-client.js';

// The scenarios config does not load tests/setup.ts — guard the keychain anyway
// (this test injects both connectors + fake clients and never reads tokens).
process.env.SYMPHONY_DISABLE_KEYRING = '1';

/**
 * Phase 8C.4 production scenario — see 8c4.md. Real server + temp-file SQLite +
 * REAL Plain AND Forgejo connectors over injected fake clients, wired into ONE
 * server. Proves both connectors coexist: each sync routes + dedups + persists,
 * and each terminal task transition fires ONLY its own writeback (Plain: note +
 * mark done; Forgejo: comment + close) with no cross-talk.
 */

function plainNode(over: Partial<PlainThreadNode>): PlainThreadNode {
  return {
    id: 't_1',
    ref: 'T-1',
    title: 'Thread',
    previewText: null,
    status: 'TODO',
    priority: null,
    customerId: 'c_1',
    labels: [],
    updatedAt: '2026-06-10T09:00:00Z',
    url: 'https://app.plain.com/workspace/ws_1/thread/t_1',
    ...over,
  };
}

function forgejoNode(over: Partial<ForgejoIssueNode>): ForgejoIssueNode {
  return {
    repo: 'acme/app',
    id: 1000,
    number: 1,
    title: 'Issue',
    body: null,
    state: 'open',
    htmlUrl: 'https://code.acme.com/acme/app/issues/1',
    updatedAt: '2026-06-10T09:00:00Z',
    labels: [],
    assignee: null,
    ...over,
  };
}

interface FakePlain extends PlainClientLike {
  readonly noteCalls: { threadId: string; customerId: string; body: string }[];
  readonly doneCalls: string[];
}

function fakePlain(threads: PlainThreadNode[]): FakePlain {
  const noteCalls: FakePlain['noteCalls'] = [];
  const doneCalls: FakePlain['doneCalls'] = [];
  const byId = new Map(threads.map((t) => [t.id, t]));
  return {
    noteCalls,
    doneCalls,
    listOpenThreads: async () => threads,
    searchThreads: async () => [],
    getThreadCustomerId: async (threadId) => byId.get(threadId)?.customerId ?? null,
    addNote: async (threadId, customerId, body) => {
      noteCalls.push({ threadId, customerId, body });
    },
    markThreadDone: async (threadId) => {
      doneCalls.push(threadId);
    },
    getWorkspace: async () => ({ id: 'ws_1', name: 'Acme Support' }),
  };
}

interface FakeForgejo extends ForgejoClientLike {
  readonly commentCalls: { repo: string; number: number; body: string }[];
  readonly closeCalls: { repo: string; number: number }[];
}

function fakeForgejo(issuesByRepo: Record<string, ForgejoIssueNode[]>): FakeForgejo {
  const commentCalls: FakeForgejo['commentCalls'] = [];
  const closeCalls: FakeForgejo['closeCalls'] = [];
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
  plain: FakePlain;
  forgejo: FakeForgejo;
  db: SymphonyDatabase;
  tmpRoot: string;
}

async function setup(): Promise<Harness> {
  const tmpRoot = mkdtempSync(path.join(tmpdir(), 'symphony-8c4-'));
  const db = SymphonyDatabase.open({ filePath: path.join(tmpRoot, 'symphony.db') });

  const plain = fakePlain([
    plainNode({ id: 't_1', title: 'Open thread' }),
    plainNode({ id: 't_2', title: 'Done thread', status: 'DONE' }),
  ]);
  const plainConnector = new PlainConnector({
    client: plain,
    config: defaultPlainConfig(),
    sleep: () => Promise.resolve(),
  });

  const forgejo = fakeForgejo({
    'acme/app': [
      forgejoNode({ repo: 'acme/app', number: 1, title: 'Open forgejo', labels: ['priority/high'] }),
      forgejoNode({ repo: 'acme/app', number: 2, title: 'Closed forgejo', state: 'closed' }),
    ],
  });
  const forgejoConnector = new ForgejoConnector({
    client: forgejo,
    config: { ...defaultForgejoConfig(), siteUrl: 'https://code.acme.com', repos: ['acme/app'] },
    sleep: () => Promise.resolve(),
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = await startOrchestratorServer({
    transport: serverTransport,
    initialMode: 'act',
    initialTier: 2, // sync_* are secrets/network/external-visible → tier >= 2
    database: db,
    projects: {
      support: path.join(tmpRoot, 'support'),
      'acme/app': path.join(tmpRoot, 'app'),
    },
    plainConnector,
    forgejoConnector,
  });
  const client = new Client({ name: '8c4-scenario', version: '0.0.0' });
  await client.connect(clientTransport);
  return { client, server, plain, forgejo, db, tmpRoot };
}

async function flush(): Promise<void> {
  await new Promise((r) => setImmediate(r));
  await Promise.resolve();
}

describe('Phase 8C.4 — production scenario (real server, Plain + Forgejo, temp-file SQLite)', () => {
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

  it('syncs Plain + Forgejo, skips done/closed, dedups, persists links, writes back independently', async () => {
    const cur = h!;

    // (1) Plain sync — routed by project: support; creates t_1, skips DONE t_2
    const pres = await cur.client.callTool({ name: 'sync_plain', arguments: { project: 'support' } });
    expect(pres.isError).toBeFalsy();
    const psc = pres.structuredContent as { createdCount: number; skippedDone: number };
    expect(psc.createdCount).toBe(1);
    expect(psc.skippedDone).toBe(1);

    // (2) Forgejo sync — routed by owner/repo; creates app#1, skips closed app#2
    const fres = await cur.client.callTool({ name: 'sync_forgejo', arguments: {} });
    expect(fres.isError).toBeFalsy();
    const fsc = fres.structuredContent as { createdCount: number; skippedDone: number };
    expect(fsc.createdCount).toBe(1);
    expect(fsc.skippedDone).toBe(1);

    expect(cur.server.taskStore.size()).toBe(2);

    // (3) idempotent re-sync of both
    const pres2 = await cur.client.callTool({ name: 'sync_plain', arguments: { project: 'support' } });
    expect((pres2.structuredContent as { createdCount: number }).createdCount).toBe(0);
    const fres2 = await cur.client.callTool({ name: 'sync_forgejo', arguments: {} });
    expect((fres2.structuredContent as { createdCount: number }).createdCount).toBe(0);

    // (4) persistence across a fresh store over the SAME db file
    const fresh = new SqliteExternalLinkStore(cur.db.db);
    expect(fresh.listExternalIds('plain')).toEqual(new Set(['t_1']));
    expect(fresh.listExternalIds('forgejo')).toEqual(new Set(['acme/app#1']));

    // (5) completing the Plain task fires ONLY the Plain writeback (note + done)
    const plainTask = cur.server.taskStore.list().find((t) => t.description === 'Open thread')!;
    cur.server.taskStore.update(plainTask.id, { status: 'in_progress' });
    cur.server.taskStore.update(plainTask.id, { status: 'completed' });
    await flush();
    await new Promise((r) => setTimeout(r, 30));

    expect(cur.plain.noteCalls).toEqual([
      { threadId: 't_1', customerId: 'c_1', body: 'Completed by Symphony.' },
    ]);
    expect(cur.plain.doneCalls).toEqual(['t_1']);
    expect(cur.forgejo.commentCalls).toEqual([]); // no cross-talk

    // (6) completing the Forgejo task fires ONLY the Forgejo writeback (comment + close)
    const forgejoTask = cur.server.taskStore.list().find((t) => t.description === 'Open forgejo')!;
    cur.server.taskStore.update(forgejoTask.id, { status: 'in_progress' });
    cur.server.taskStore.update(forgejoTask.id, { status: 'completed' });
    await flush();
    await new Promise((r) => setTimeout(r, 30));

    expect(cur.forgejo.commentCalls).toEqual([
      { repo: 'acme/app', number: 1, body: 'Completed by Symphony.' },
    ]);
    expect(cur.forgejo.closeCalls).toEqual([{ repo: 'acme/app', number: 1 }]);
    // Plain writeback did not fire a second time.
    expect(cur.plain.noteCalls).toHaveLength(1);
  });
});
