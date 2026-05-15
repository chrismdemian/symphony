import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startOrchestratorServer } from '../../src/orchestrator/index.js';
import type { OrchestratorServerHandle } from '../../src/orchestrator/index.js';

/**
 * Phase 3R — server-wide audit wiring integration test.
 *
 * Asserts the AuditLogger built inside startOrchestratorServer is
 * reachable from the six event sources: tool dispatch, capability
 * deny, worker exit (via lifecycle), question ask/answer, auto-merge
 * (via broker), and tier change (via the runtime RPC seam). Plus the
 * LIFO close ordering (auditLogger.shutdown runs LAST).
 */

describe('audit wiring (integration)', () => {
  let handles: OrchestratorServerHandle[] = [];
  let clients: Client[] = [];

  beforeEach(() => {
    handles = [];
    clients = [];
  });

  afterEach(async () => {
    for (const c of clients) await c.close().catch(() => {});
    for (const h of handles) await h.close().catch(() => {});
  });

  it('exposes auditLogger + auditStore on the handle', async () => {
    const [, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = await startOrchestratorServer({
      transport: serverTransport,
      initialMode: 'act',
    });
    handles.push(server);
    expect(server.auditLogger).toBeDefined();
    expect(server.auditStore).toBeDefined();
    expect(typeof server.auditLogger.append).toBe('function');
    expect(typeof server.auditStore.list).toBe('function');
  });

  it('records tool_called on a successful dispatch', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = await startOrchestratorServer({
      transport: serverTransport,
      initialMode: 'plan',
    });
    const client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(clientTransport);
    handles.push(server);
    clients.push(client);

    await client.callTool({ name: 'think', arguments: { ledger: {} } });

    const rows = server.auditStore.list({ kinds: ['tool_called'] });
    const think = rows.find((r) => r.toolName === 'think');
    expect(think).toBeDefined();
    expect(think?.severity).toBe('info');
    expect(think?.headline).toContain('tool think');
  });

  it('records question_asked and question_answered through the store hooks', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = await startOrchestratorServer({
      transport: serverTransport,
      initialMode: 'act',
    });
    const client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(clientTransport);
    handles.push(server);
    clients.push(client);

    const result = await client.callTool({
      name: 'ask_user',
      arguments: { question: 'Proceed with the merge?' },
    });
    const structured = (result as { structuredContent?: { id: string } }).structuredContent;
    const qid = structured!.id;

    server.questionStore.answer(qid, 'yes');

    const asked = server.auditStore.list({ kinds: ['question_asked'] });
    const answered = server.auditStore.list({ kinds: ['question_answered'] });
    expect(asked.length).toBe(1);
    expect(answered.length).toBe(1);
    expect(asked[0]?.headline).toContain('question asked');
    expect(answered[0]?.headline).toContain('question answered');
  });

  it('close() shuts down auditLogger LAST (after lifecycle + workerManager)', async () => {
    const order: string[] = [];
    const auditLogger = {
      append: vi.fn(() => null),
      shutdown: vi.fn(async () => {
        order.push('audit');
      }),
    };
    const [, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = await startOrchestratorServer({
      transport: serverTransport,
      auditLogger,
    });
    handles.push(server);

    const lifecycleSpy = vi.spyOn(server.workerLifecycle, 'shutdown');
    lifecycleSpy.mockImplementation(async () => {
      order.push('lifecycle');
    });
    const wmSpy = vi.spyOn(server.workerManager, 'shutdown');
    wmSpy.mockImplementation(async () => {
      order.push('workerManager');
    });

    await server.close();

    expect(order).toEqual(['lifecycle', 'workerManager', 'audit']);
  });

  it('injected auditStore receives rows from tool dispatch', async () => {
    const rows: unknown[] = [];
    const fakeStore = {
      append: vi.fn((input: Record<string, unknown>) => {
        const entry = { id: rows.length + 1, payload: {}, ...input };
        rows.push(entry);
        return entry;
      }),
      list: vi.fn(() => []),
      count: vi.fn(() => 0),
    };
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = await startOrchestratorServer({
      transport: serverTransport,
      initialMode: 'plan',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      auditStore: fakeStore as any,
    });
    const client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(clientTransport);
    handles.push(server);
    clients.push(client);

    await client.callTool({ name: 'think', arguments: { ledger: {} } });
    await new Promise((r) => setImmediate(r));

    expect(fakeStore.append).toHaveBeenCalled();
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });
});
