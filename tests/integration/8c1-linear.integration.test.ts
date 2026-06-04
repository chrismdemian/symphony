import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  startOrchestratorServer,
  type OrchestratorServerHandle,
} from '../../src/orchestrator/index.js';
import { SymphonyDatabase } from '../../src/state/db.js';
import type {
  IssueConnectorHandle,
  IssueWritebackResult,
  NormalizedIssue,
} from '../../src/integrations/issue-connector.js';

/**
 * Phase 8C.1 integration — real SQLite + a real orchestrator server + MCP
 * client, with a FAKE Linear connector injected (no live API). Proves the full
 * wire: sync_linear creates tasks + links idempotently, terminal issues are
 * skipped, and a terminal task transition pushes status back to the connector.
 */

interface FakeConnector extends IssueConnectorHandle {
  readonly writebackCalls: { externalId: string; status: 'completed' | 'failed' }[];
}

function fakeConnector(issues: NormalizedIssue[]): FakeConnector {
  const writebackCalls: { externalId: string; status: 'completed' | 'failed' }[] = [];
  return {
    source: 'linear',
    writebackCalls,
    fetchOpenIssues: async () => issues,
    writeBackStatus: async (externalId, status): Promise<IssueWritebackResult> => {
      writebackCalls.push({ externalId, status });
      return { written: true, code: 'written', value: status === 'completed' ? 'Done' : 'Canceled' };
    },
    checkConnection: async () => ({ ok: true }),
  };
}

function issue(over: Partial<NormalizedIssue>): NormalizedIssue {
  return {
    externalId: 'iss-1',
    title: 'Imported issue',
    url: 'https://linear.app/iss-1',
    state: 'Todo',
    isTerminal: false,
    body: null,
    assignee: null,
    labels: [],
    projectValue: 'main',
    priority: 0,
    updatedAt: null,
    ...over,
  };
}

interface Harness {
  client: Client;
  server: OrchestratorServerHandle;
  connector: FakeConnector;
  db: SymphonyDatabase;
}

async function setup(issues: NormalizedIssue[]): Promise<Harness> {
  const db = SymphonyDatabase.open({ filePath: ':memory:' });
  const connector = fakeConnector(issues);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = await startOrchestratorServer({
    transport: serverTransport,
    initialMode: 'act',
    // sync_linear declares requires-secrets-read / network-egress /
    // external-visible — all require autonomy tier >= 2.
    initialTier: 2,
    database: db,
    projects: { main: '/tmp/8c1-main', other: '/tmp/8c1-other' },
    linearConnector: connector,
  });
  const client = new Client({ name: '8c1-integration', version: '0.0.0' });
  await client.connect(clientTransport);
  return { client, server, connector, db };
}

async function flush(): Promise<void> {
  await new Promise((r) => setImmediate(r));
  await Promise.resolve();
}

describe('Phase 8C.1 — Linear sync (integration)', () => {
  let h: Harness | null = null;
  afterEach(async () => {
    if (!h) return;
    await h.client.close().catch(() => {});
    await h.server.close().catch(() => {});
    h.db.close();
    h = null;
  });

  it('sync_linear creates a task + link per open issue, skips terminal, idempotently', async () => {
    h = await setup([
      issue({ externalId: 'a', title: 'First', projectValue: 'main', priority: 2 }),
      issue({ externalId: 'b', title: 'Second', projectValue: 'other' }),
      issue({ externalId: 'closed', title: 'Already done', isTerminal: true, projectValue: 'main' }),
    ]);

    const res = await h.client.callTool({ name: 'sync_linear', arguments: {} });
    expect(res.isError).toBeFalsy();
    const sc = res.structuredContent as { createdCount: number; skippedDone: number; created: string[] };
    expect(sc.createdCount).toBe(2);
    expect(sc.skippedDone).toBe(1);

    expect(h.server.taskStore.size()).toBe(2);
    expect(h.server.externalLinkStore.getByExternal('linear', 'a')).toBeDefined();
    expect(h.server.externalLinkStore.getByExternal('linear', 'b')).toBeDefined();
    expect(h.server.externalLinkStore.getByExternal('linear', 'closed')).toBeUndefined();

    const res2 = await h.client.callTool({ name: 'sync_linear', arguments: {} });
    const sc2 = res2.structuredContent as { createdCount: number; skippedExisting: number };
    expect(sc2.createdCount).toBe(0);
    expect(sc2.skippedExisting).toBe(2);
    expect(h.server.taskStore.size()).toBe(2);
  });

  it('pushes a terminal task status back to Linear via the writeback hook', async () => {
    h = await setup([issue({ externalId: 'iss-77', title: 'Closeable', projectValue: 'main' })]);
    const res = await h.client.callTool({ name: 'sync_linear', arguments: {} });
    const taskId = (res.structuredContent as { created: string[] }).created[0]!;

    h.server.taskStore.update(taskId, { status: 'in_progress' });
    h.server.taskStore.update(taskId, { status: 'completed' });
    await flush();

    expect(h.connector.writebackCalls).toEqual([{ externalId: 'iss-77', status: 'completed' }]);
  });

  it('does not write back for a task with no Linear link', async () => {
    h = await setup([]);
    const projId = h.server.projectStore.get('main')!.id;
    const task = h.server.taskStore.create({ projectId: projId, description: 'local task' });
    h.server.taskStore.update(task.id, { status: 'in_progress' });
    h.server.taskStore.update(task.id, { status: 'completed' });
    await flush();
    expect(h.connector.writebackCalls).toEqual([]);
  });
});
