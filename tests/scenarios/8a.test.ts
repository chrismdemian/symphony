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
import type {
  NotionConnectorHandle,
  NotionTaskCandidate,
  NotionWritebackResult,
} from '../../src/integrations/notion.js';

/**
 * Phase 8A production scenario — see 8a.md. Real server + temp-FILE SQLite,
 * fake Notion connector. Adds the persistence-across-fresh-store leg on top
 * of the :memory: integration test.
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
      return { written: true, value: 'Done' };
    },
  };
}

function cand(over: Partial<NotionTaskCandidate>): NotionTaskCandidate {
  return {
    pageId: 'pg',
    url: 'https://notion.so/pg',
    title: 'task',
    status: 'pending',
    priority: 0,
    projectValue: 'alpha',
    ...over,
  };
}

interface Harness {
  client: Client;
  server: OrchestratorServerHandle;
  connector: FakeConnector;
  db: SymphonyDatabase;
  dbFile: string;
  tmpRoot: string;
}

async function setup(candidates: NotionTaskCandidate[]): Promise<Harness> {
  const tmpRoot = mkdtempSync(path.join(tmpdir(), 'symphony-8a-'));
  const dbFile = path.join(tmpRoot, 'symphony.db');
  const db = SymphonyDatabase.open({ filePath: dbFile });
  const connector = fakeConnector(candidates);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = await startOrchestratorServer({
    transport: serverTransport,
    initialMode: 'act',
    initialTier: 2,
    database: db,
    projects: { alpha: path.join(tmpRoot, 'alpha'), beta: path.join(tmpRoot, 'beta') },
    notionConnector: connector,
  });
  const client = new Client({ name: '8a-scenario', version: '0.0.0' });
  await client.connect(clientTransport);
  return { client, server, connector, db, dbFile, tmpRoot };
}

async function flush(): Promise<void> {
  await new Promise((r) => setImmediate(r));
  await Promise.resolve();
}

describe('Phase 8A — production scenario (real server, temp-file SQLite)', () => {
  let h: Harness | null = null;

  beforeEach(async () => {
    h = await setup([
      cand({ pageId: 'pg-1', title: 'Open alpha', projectValue: 'alpha', priority: 1 }),
      cand({ pageId: 'pg-2', title: 'Open beta', projectValue: 'beta' }),
      cand({ pageId: 'pg-3', title: 'Already done', status: 'completed' }),
    ]);
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

  it('syncs, dedups, persists links across a fresh store, and writes back on completion', async () => {
    const cur = h!;

    // (2) create + route + link; (skip the done page)
    const res = await cur.client.callTool({ name: 'sync_notion', arguments: {} });
    expect(res.isError).toBeFalsy();
    const sc = res.structuredContent as {
      createdCount: number;
      skippedDone: number;
      created: string[];
    };
    expect(sc.createdCount).toBe(2);
    expect(sc.skippedDone).toBe(1);
    expect(cur.server.taskStore.size()).toBe(2);

    // (3) idempotent re-sync
    const res2 = await cur.client.callTool({ name: 'sync_notion', arguments: {} });
    const sc2 = res2.structuredContent as { createdCount: number; skippedExisting: number };
    expect(sc2.createdCount).toBe(0);
    expect(sc2.skippedExisting).toBe(2);

    // (5) writeback on completion
    const taskId = sc.created[0]!;
    cur.server.taskStore.update(taskId, { status: 'in_progress' });
    cur.server.taskStore.update(taskId, { status: 'completed' });
    await flush();
    expect(cur.connector.writebackCalls).toContainEqual({ pageId: 'pg-1', status: 'completed' });

    // (4) persistence across a fresh store over the SAME db file
    const fresh = new SqliteExternalLinkStore(cur.db.db);
    expect(fresh.getByExternal('notion', 'pg-1')).toBeDefined();
    expect(fresh.getByExternal('notion', 'pg-2')).toBeDefined();
    expect(fresh.listExternalIds('notion')).toEqual(new Set(['pg-1', 'pg-2']));
  });
});
