import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  startOrchestratorServer,
  type OrchestratorServerHandle,
} from '../../src/orchestrator/index.js';
import { SymphonyDatabase } from '../../src/state/db.js';
import type {
  NotionConnectorHandle,
  NotionTaskCandidate,
  NotionWritebackResult,
} from '../../src/integrations/notion.js';

/**
 * Phase 8A integration — real SQLite + a real orchestrator server + MCP
 * client, with a FAKE Notion connector injected (no live API). Proves the
 * full wire: sync_notion creates tasks + links idempotently, and a terminal
 * task transition pushes status back to the connector.
 */

interface FakeConnector extends NotionConnectorHandle {
  readonly writebackCalls: { pageId: string; status: 'completed' | 'failed' }[];
}

function fakeConnector(candidates: NotionTaskCandidate[]): FakeConnector {
  const writebackCalls: { pageId: string; status: 'completed' | 'failed' }[] = [];
  return {
    writebackCalls,
    fetchOpenPages: async () => candidates,
    writeBackStatus: async (pageId, status): Promise<NotionWritebackResult> => {
      writebackCalls.push({ pageId, status });
      return { written: true, value: status === 'completed' ? 'Done' : 'Blocked' };
    },
  };
}

function candidate(over: Partial<NotionTaskCandidate>): NotionTaskCandidate {
  return {
    pageId: 'pg-1',
    url: 'https://notion.so/pg-1',
    title: 'Imported task',
    status: 'pending',
    priority: 0,
    projectValue: 'main',
    ...over,
  };
}

interface Harness {
  client: Client;
  server: OrchestratorServerHandle;
  connector: FakeConnector;
  db: SymphonyDatabase;
}

async function setup(candidates: NotionTaskCandidate[]): Promise<Harness> {
  const db = SymphonyDatabase.open({ filePath: ':memory:' });
  const connector = fakeConnector(candidates);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = await startOrchestratorServer({
    transport: serverTransport,
    initialMode: 'act',
    // sync_notion declares requires-secrets-read / network-egress /
    // external-visible — all require autonomy tier >= 2.
    initialTier: 2,
    database: db,
    projects: { main: '/tmp/8a-main', other: '/tmp/8a-other' },
    notionConnector: connector,
  });
  const client = new Client({ name: '8a-integration', version: '0.0.0' });
  await client.connect(clientTransport);
  return { client, server, connector, db };
}

async function flush(): Promise<void> {
  // Let the fire-and-forget writeback promise settle.
  await new Promise((r) => setImmediate(r));
  await Promise.resolve();
}

describe('Phase 8A — Notion sync (integration)', () => {
  let h: Harness | null = null;
  afterEach(async () => {
    if (!h) return;
    await h.client.close().catch(() => {});
    await h.server.close().catch(() => {});
    h.db.close();
    h = null;
  });

  it('sync_notion creates a task + link per page, idempotently', async () => {
    h = await setup([
      candidate({ pageId: 'pg-1', title: 'First', projectValue: 'main', priority: 2 }),
      candidate({ pageId: 'pg-2', title: 'Second', projectValue: 'other' }),
      candidate({ pageId: 'pg-done', title: 'Done already', status: 'completed' }),
    ]);

    const res = await h.client.callTool({ name: 'sync_notion', arguments: {} });
    expect(res.isError).toBeFalsy();
    const sc = res.structuredContent as {
      createdCount: number;
      skippedDone: number;
      created: string[];
    };
    expect(sc.createdCount).toBe(2);
    expect(sc.skippedDone).toBe(1);

    // Tasks landed in SQLite.
    expect(h.server.taskStore.size()).toBe(2);
    // Links persisted + routed correctly.
    expect(h.server.externalLinkStore.getByExternal('notion', 'pg-1')).toBeDefined();
    expect(h.server.externalLinkStore.getByExternal('notion', 'pg-2')).toBeDefined();
    expect(h.server.externalLinkStore.getByExternal('notion', 'pg-done')).toBeUndefined();

    // Re-sync creates nothing.
    const res2 = await h.client.callTool({ name: 'sync_notion', arguments: {} });
    const sc2 = res2.structuredContent as { createdCount: number; skippedExisting: number };
    expect(sc2.createdCount).toBe(0);
    expect(sc2.skippedExisting).toBe(2);
    expect(h.server.taskStore.size()).toBe(2);
  });

  it('pushes a terminal task status back to Notion via the writeback hook', async () => {
    h = await setup([candidate({ pageId: 'pg-77', title: 'Closeable', projectValue: 'main' })]);
    const res = await h.client.callTool({ name: 'sync_notion', arguments: {} });
    const taskId = (res.structuredContent as { created: string[] }).created[0]!;

    // Drive the task to completion via the store (pending → in_progress →
    // completed) — the onTaskStatusChange fan-out fires the writeback.
    h.server.taskStore.update(taskId, { status: 'in_progress' });
    h.server.taskStore.update(taskId, { status: 'completed' });
    await flush();

    expect(h.connector.writebackCalls).toEqual([{ pageId: 'pg-77', status: 'completed' }]);
  });

  it('does not write back for a task with no Notion link', async () => {
    h = await setup([]);
    // A task created directly (not from Notion) has no external link.
    const projId = h.server.projectStore.get('main')!.id;
    const task = h.server.taskStore.create({ projectId: projId, description: 'local task' });
    h.server.taskStore.update(task.id, { status: 'in_progress' });
    h.server.taskStore.update(task.id, { status: 'completed' });
    await flush();
    expect(h.connector.writebackCalls).toEqual([]);
  });
});
