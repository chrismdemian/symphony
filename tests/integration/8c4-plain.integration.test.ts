import { afterEach, describe, expect, it } from 'vitest';
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

process.env.SYMPHONY_DISABLE_KEYRING = '1';

/**
 * Phase 8C.4 integration — real SQLite + a real orchestrator server + MCP client
 * + a REAL `PlainConnector` over an injected `PlainClientLike` fake (no live
 * API). Plain has no Symphony-project concept, so sync_plain routes via the
 * `project:` arg. Proves: tasks + links created idempotently, DONE threads
 * skipped, links persisted, and a terminal task transition pushes status back
 * (internal note + mark done).
 */

interface FakeClient extends PlainClientLike {
  readonly noteCalls: { threadId: string; customerId: string; body: string }[];
  readonly doneCalls: string[];
}

function node(over: Partial<PlainThreadNode>): PlainThreadNode {
  return {
    id: 't_1',
    ref: 'T-1',
    title: 'Thread',
    previewText: null,
    status: 'TODO',
    priority: null,
    customerId: 'c_1',
    labels: [],
    updatedAt: '2026-06-01T00:00:00Z',
    url: 'https://app.plain.com/workspace/ws_1/thread/t_1',
    ...over,
  };
}

function fakeClient(threads: PlainThreadNode[]): FakeClient {
  const noteCalls: FakeClient['noteCalls'] = [];
  const doneCalls: FakeClient['doneCalls'] = [];
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

interface Harness {
  client: Client;
  server: OrchestratorServerHandle;
  plain: FakeClient;
  db: SymphonyDatabase;
}

async function setup(threads: PlainThreadNode[]): Promise<Harness> {
  const db = SymphonyDatabase.open({ filePath: ':memory:' });
  const plain = fakeClient(threads);
  const connector = new PlainConnector({
    client: plain,
    config: defaultPlainConfig(),
    sleep: () => Promise.resolve(),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = await startOrchestratorServer({
    transport: serverTransport,
    initialMode: 'act',
    initialTier: 2,
    database: db,
    projects: { support: '/tmp/8c4-plain-support' },
    plainConnector: connector,
  });
  const client = new Client({ name: '8c4-plain-integration', version: '0.0.0' });
  await client.connect(clientTransport);
  return { client, server, plain, db };
}

async function flush(): Promise<void> {
  await new Promise((r) => setImmediate(r));
  await Promise.resolve();
}

describe('Phase 8C.4 — Plain sync (integration)', () => {
  let h: Harness | null = null;
  afterEach(async () => {
    if (!h) return;
    await h.client.close().catch(() => {});
    await h.server.close().catch(() => {});
    h.db.close();
    h = null;
  });

  it('sync_plain creates a task + link per open thread (routed by project:), skips DONE, idempotently', async () => {
    h = await setup([
      node({ id: 't_1', title: 'First' }),
      node({ id: 't_2', title: 'Done one', status: 'DONE' }),
      node({ id: 't_3', title: 'Second' }),
    ]);

    const res = await h.client.callTool({ name: 'sync_plain', arguments: { project: 'support' } });
    expect(res.isError).toBeFalsy();
    const sc = res.structuredContent as { createdCount: number; skippedDone: number };
    expect(sc.createdCount).toBe(2);
    expect(sc.skippedDone).toBe(1);

    expect(h.server.taskStore.size()).toBe(2);
    expect(h.server.externalLinkStore.getByExternal('plain', 't_1')).toBeDefined();
    expect(h.server.externalLinkStore.getByExternal('plain', 't_3')).toBeDefined();
    expect(h.server.externalLinkStore.getByExternal('plain', 't_2')).toBeUndefined();

    const res2 = await h.client.callTool({ name: 'sync_plain', arguments: { project: 'support' } });
    const sc2 = res2.structuredContent as { createdCount: number; skippedExisting: number };
    expect(sc2.createdCount).toBe(0);
    expect(sc2.skippedExisting).toBe(2);
  });

  it('persists external links to SQLite (visible from a fresh store over the same db)', async () => {
    h = await setup([node({ id: 't_5' })]);
    await h.client.callTool({ name: 'sync_plain', arguments: { project: 'support' } });
    const fresh = new SqliteExternalLinkStore(h.db.db);
    expect(fresh.listExternalIds('plain')).toEqual(new Set(['t_5']));
  });

  it('completion fires the writeback hook → real connector notes then marks done', async () => {
    h = await setup([node({ id: 't_77', customerId: 'c_77', title: 'Resolvable' })]);
    const res = await h.client.callTool({ name: 'sync_plain', arguments: { project: 'support' } });
    const taskId = (res.structuredContent as { created: string[] }).created[0]!;

    h.server.taskStore.update(taskId, { status: 'in_progress' });
    h.server.taskStore.update(taskId, { status: 'completed' });
    await flush();
    await flush();

    expect(h.plain.noteCalls).toEqual([
      { threadId: 't_77', customerId: 'c_77', body: 'Completed by Symphony.' },
    ]);
    expect(h.plain.doneCalls).toEqual(['t_77']);
  });

  it('does not write back for a task with no Plain link', async () => {
    h = await setup([]);
    const projId = h.server.projectStore.get('support')!.id;
    const task = h.server.taskStore.create({ projectId: projId, description: 'local task' });
    h.server.taskStore.update(task.id, { status: 'in_progress' });
    h.server.taskStore.update(task.id, { status: 'completed' });
    await flush();
    expect(h.plain.noteCalls).toEqual([]);
    expect(h.plain.doneCalls).toEqual([]);
  });
});
