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
import { LinearConnector } from '../../src/integrations/linear.js';
import { defaultLinearConfig } from '../../src/integrations/linear-config.js';
import type {
  LinearClientLike,
  LinearIssueNode,
  LinearWorkflowState,
} from '../../src/integrations/linear-client.js';

// The scenarios config does not load tests/setup.ts — guard the keychain anyway
// (this test injects the connector + a fake client and never reads tokens).
process.env.SYMPHONY_DISABLE_KEYRING = '1';

/**
 * Phase 8C.1 production scenario — see 8c1.md. Real server + temp-file SQLite +
 * a REAL LinearConnector over an injected fake LinearClientLike. Adds the
 * persistence-across-fresh-store leg + the on-the-wire writeback (real connector
 * resolves the completed state and calls updateIssueState).
 */

function node(over: Partial<LinearIssueNode>): LinearIssueNode {
  return {
    id: 'iss',
    identifier: 'X-0',
    title: 'Issue',
    description: null,
    url: 'https://linear.app/x',
    priority: 0,
    updatedAt: '2026-06-10T09:00:00Z',
    state: { name: 'Todo', type: 'unstarted' },
    team: { id: 'team-a', key: 'alpha', name: 'Alpha' },
    project: null,
    assignee: null,
    ...over,
  };
}

const STATES: LinearWorkflowState[] = [
  { id: 'st-todo', name: 'Todo', type: 'unstarted', position: 0 },
  { id: 'st-done', name: 'Done', type: 'completed', position: 1 },
];

interface FakeClient extends LinearClientLike {
  readonly updateCalls: { issueId: string; stateId: string }[];
}

function fakeClient(issues: LinearIssueNode[]): FakeClient {
  const updateCalls: { issueId: string; stateId: string }[] = [];
  return {
    updateCalls,
    listRecentIssues: async () => issues,
    searchIssues: async () => [],
    getIssueWithStates: async (issueId) => ({ id: issueId, teamId: 'team-a', states: STATES }),
    updateIssueState: async (issueId, stateId) => {
      updateCalls.push({ issueId, stateId });
      return true;
    },
    viewer: async () => ({ name: 'Chris' }),
  };
}

interface Harness {
  client: Client;
  server: OrchestratorServerHandle;
  connector: LinearConnector;
  fake: FakeClient;
  db: SymphonyDatabase;
  tmpRoot: string;
}

async function setup(): Promise<Harness> {
  const tmpRoot = mkdtempSync(path.join(tmpdir(), 'symphony-8c1-'));
  const dbFile = path.join(tmpRoot, 'symphony.db');
  const db = SymphonyDatabase.open({ filePath: dbFile });

  const fake = fakeClient([
    node({ id: 'a', title: 'Open alpha', team: { id: 'team-a', key: 'alpha', name: 'Alpha' } }),
    node({
      id: 'b',
      title: 'Open beta',
      team: { id: 'team-b', key: 'beta', name: 'Beta' },
      state: { name: 'In Progress', type: 'started' },
    }),
    node({ id: 'c', title: 'Done alpha', state: { name: 'Done', type: 'completed' } }),
  ]);
  const connector = new LinearConnector({
    client: fake,
    config: defaultLinearConfig(),
    sleep: () => Promise.resolve(),
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = await startOrchestratorServer({
    transport: serverTransport,
    initialMode: 'act',
    initialTier: 2, // sync_linear is secrets/network/external-visible → tier >= 2
    database: db,
    projects: { alpha: path.join(tmpRoot, 'alpha'), beta: path.join(tmpRoot, 'beta') },
    linearConnector: connector,
  });
  const client = new Client({ name: '8c1-scenario', version: '0.0.0' });
  await client.connect(clientTransport);
  return { client, server, connector, fake, db, tmpRoot };
}

async function flush(): Promise<void> {
  await new Promise((r) => setImmediate(r));
  await Promise.resolve();
}

describe('Phase 8C.1 — production scenario (real server, real connector, temp-file SQLite)', () => {
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

  it('syncs, skips terminal, dedups, persists links, and writes back on completion', async () => {
    const cur = h!;

    // (1) create + route by team; skip the done issue
    const res = await cur.client.callTool({ name: 'sync_linear', arguments: {} });
    expect(res.isError).toBeFalsy();
    const sc = res.structuredContent as { createdCount: number; skippedDone: number; created: string[] };
    expect(sc.createdCount).toBe(2); // alpha + beta open
    expect(sc.skippedDone).toBe(1);
    expect(cur.server.taskStore.size()).toBe(2);

    // (2) idempotent re-sync
    const res2 = await cur.client.callTool({ name: 'sync_linear', arguments: {} });
    const sc2 = res2.structuredContent as { createdCount: number; skippedExisting: number };
    expect(sc2.createdCount).toBe(0);
    expect(sc2.skippedExisting).toBe(2);

    // (3) persistence across a fresh store over the SAME db file
    const fresh = new SqliteExternalLinkStore(cur.db.db);
    expect(fresh.listExternalIds('linear').size).toBe(2);

    // (4) writeback on completion → real connector resolves the completed state
    const closeable = cur.server.taskStore.list().find((t) => t.description === 'Open alpha');
    expect(closeable).toBeDefined();
    cur.server.taskStore.update(closeable!.id, { status: 'in_progress' });
    cur.server.taskStore.update(closeable!.id, { status: 'completed' });
    await flush();
    await new Promise((r) => setTimeout(r, 30)); // throttle + fire-and-forget settle

    expect(cur.fake.updateCalls).toEqual([{ issueId: 'a', stateId: 'st-done' }]);
  });
});
