import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startOrchestratorServer } from '../../src/orchestrator/index.js';
import type { OrchestratorServerHandle } from '../../src/orchestrator/index.js';

interface ToolSummary {
  name: string;
}

async function makePair(
  opts: Parameters<typeof startOrchestratorServer>[0] = {},
): Promise<{ client: Client; server: OrchestratorServerHandle }> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = await startOrchestratorServer({ ...opts, transport: serverTransport });
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(clientTransport);
  return { client, server };
}

describe('orchestrator MCP server (integration)', () => {
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

  async function connect(
    opts: Parameters<typeof startOrchestratorServer>[0] = {},
  ): Promise<{ client: Client; server: OrchestratorServerHandle }> {
    const pair = await makePair(opts);
    handles.push(pair.server);
    clients.push(pair.client);
    return pair;
  }

  it('completes initialize handshake and advertises tool capability', async () => {
    const { client } = await connect();
    const caps = client.getServerCapabilities();
    expect(caps?.tools).toBeDefined();
  });

  it('lists plan-scoped + both-scoped tools in plan mode', async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    const names = (tools as ToolSummary[]).map((t) => t.name).sort();
    expect(names).toContain('think');
    expect(names).toContain('propose_plan');
  });

  it('drops propose_plan from the list after switching to act mode', async () => {
    const { client, server } = await connect();

    const listChanged = new Promise<void>((resolve) => {
      client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
        resolve();
      });
    });

    server.mode.setMode('act', 'user approved plan');
    await listChanged;

    const { tools } = await client.listTools();
    const names = (tools as ToolSummary[]).map((t) => t.name).sort();
    expect(names).toContain('think');
    expect(names).not.toContain('propose_plan');
  });

  it('calls the think tool with a valid ledger and records structured output', async () => {
    const { client } = await connect();
    const result = await client.callTool({
      name: 'think',
      arguments: {
        ledger: {
          is_plan_complete: false,
          is_in_loop: false,
          is_making_progress: true,
          workers_in_flight: [],
          blockers: [],
          next_action: 'dispatch a research wave',
          reason: 'scope unclear',
        },
      },
    });
    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as { recorded: Record<string, unknown> } | undefined;
    expect(structured?.recorded).toMatchObject({ next_action: 'dispatch a research wave' });
  });

  it('returns isError when a plan-only tool is invoked in act mode', async () => {
    const { client, server } = await connect();
    server.mode.setMode('act');
    const result = await client.callTool({
      name: 'propose_plan',
      arguments: { plan: '# foo', autonomy_tier: 2 },
    });
    expect(result.isError).toBe(true);
  });

  it('enforces safety tool-cap via isError across repeated calls', async () => {
    const { client } = await connect({ safety: { maxToolCalls: 3 } });
    const distinct = async (i: number) =>
      client.callTool({
        name: 'think',
        arguments: { ledger: { next_action: `step ${i}`, reason: `r${i}` } },
      });
    for (let i = 0; i < 3; i += 1) {
      const r = await distinct(i);
      expect(r.isError).toBeFalsy();
    }
    const fourth = await distinct(3);
    expect(fourth.isError).toBe(true);
    const firstText = (fourth.content as Array<{ text?: string }>)[0]?.text ?? '';
    expect(firstText).toMatch(/simpler/i);
  });

  it('enforces loop detection via isError after 3 identical prior calls plus a 4th', async () => {
    const { client } = await connect();
    const sameArgs = { ledger: { next_action: 'same', reason: 'same' } };
    for (let i = 0; i < 3; i += 1) {
      const r = await client.callTool({ name: 'think', arguments: sameArgs });
      expect(r.isError).toBeFalsy();
    }
    const fourth = await client.callTool({ name: 'think', arguments: sameArgs });
    expect(fourth.isError).toBe(true);
    const firstText = (fourth.content as Array<{ text?: string }>)[0]?.text ?? '';
    expect(firstText).toMatch(/stuck/i);
  });

  it('rejects malformed input schema via isError with a zod-reported reason', async () => {
    const { client } = await connect();
    const result = await client.callTool({
      name: 'think',
      // `ledger` is required and must be an object — pass a string to trigger validation failure
      arguments: { ledger: 'not-an-object' },
    });
    expect(result.isError).toBe(true);
    const firstText = (result.content as Array<{ text?: string }>)[0]?.text ?? '';
    expect(firstText.toLowerCase()).toContain('expected object');
  });

  it('proposes a plan, stores it, and returns structured metadata', async () => {
    const { client, server } = await connect();
    const before = server.planStore.getLastPlan();
    expect(before).toBeNull();
    const result = await client.callTool({
      name: 'propose_plan',
      arguments: { plan: '# plan\n- step 1', autonomy_tier: 2 },
    });
    expect(result.isError).toBeFalsy();
    const stored = server.planStore.getLastPlan();
    expect(stored?.plan).toContain('# plan');
    expect(stored?.autonomyTier).toBe(2);
  });
});
