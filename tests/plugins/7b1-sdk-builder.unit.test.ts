/**
 * Phase 7B.1 — `@symphony/plugin-sdk` builder behavior, exercised over a
 * REAL in-memory MCP transport (linked client/server pair). Asserts:
 *   - declared tools are discoverable + callable, with the right result shape
 *   - event handlers register as `on_<event>` tools carrying the
 *     `symphony/eventHandler` _meta marker (so 7B.3 can hide them)
 *   - per-tool `permissions` ride on `_meta` (so 7B.3 can enforce them)
 *   - the typed payload reaches the handler when the host "fires" an event
 *     by calling the handler tool
 *
 * `_meta` round-trip through `listTools()` is verified here on purpose:
 * 7B.3's hide-handlers + per-tool-permission features depend on it.
 */
import { describe, expect, it } from 'vitest';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import {
  createPlugin,
  SYMPHONY_META_EVENT_HANDLER,
  SYMPHONY_META_PERMISSIONS,
} from '../../packages/plugin-sdk/src/plugin.js';

async function connect(builder: ReturnType<typeof createPlugin>): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await builder.serve(serverTransport);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

describe('7B.1 plugin SDK builder', () => {
  it('exposes a declared tool with the right name + result', async () => {
    const plugin = createPlugin({ id: 'demo', name: 'Demo', version: '0.1.0' }).tool({
      name: 'greet',
      description: 'greet someone',
      inputSchema: { who: z.string() },
      handler: ({ who }) => `hi ${who}`,
    });
    const client = await connect(plugin);
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((t) => t.name)).toContain('greet');

      const res = await client.callTool({ name: 'greet', arguments: { who: 'sym' } }, CallToolResultSchema);
      expect((res.content as Array<{ text?: string }>)[0]?.text).toBe('hi sym');
    } finally {
      await client.close();
    }
  });

  it('marks event handlers with the eventHandler _meta and routes the payload', async () => {
    let seen: unknown;
    const plugin = createPlugin({ id: 'demo', name: 'Demo', version: '0.1.0' })
      .tool({ name: 'noop', description: 'noop', handler: () => 'ok' })
      .onTaskCompleted((e) => {
        seen = e;
      });
    const client = await connect(plugin);
    try {
      const tools = await client.listTools();
      const handler = tools.tools.find((t) => t.name === 'on_task_completed');
      expect(handler).toBeDefined();
      // _meta round-trips through listTools and carries the marker.
      expect((handler?._meta as Record<string, unknown> | undefined)?.[SYMPHONY_META_EVENT_HANDLER]).toBe(true);

      // "Fire" the event the way the host does — call the handler tool.
      await client.callTool(
        { name: 'on_task_completed', arguments: { taskId: 't1', projectId: 'p1', status: 'completed' } },
        CallToolResultSchema,
      );
      expect(seen).toEqual({ taskId: 't1', projectId: 'p1', status: 'completed' });
    } finally {
      await client.close();
    }
  });

  it('attaches per-tool permissions via _meta', async () => {
    const plugin = createPlugin({ id: 'demo', name: 'Demo', version: '0.1.0' }).tool({
      name: 'read_tasks',
      description: 'read tasks',
      permissions: ['task:read'],
      handler: () => 'ok',
    });
    const client = await connect(plugin);
    try {
      const tools = await client.listTools();
      const tool = tools.tools.find((t) => t.name === 'read_tasks');
      expect((tool?._meta as Record<string, unknown> | undefined)?.[SYMPHONY_META_PERMISSIONS]).toEqual([
        'task:read',
      ]);
    } finally {
      await client.close();
    }
  });

  it('rejects a duplicate event handler registration', () => {
    const plugin = createPlugin({ id: 'demo', name: 'Demo', version: '0.1.0' }).onTaskCompleted(() => {});
    expect(() => plugin.onTaskCompleted(() => {})).toThrow(/already has a handler/);
  });
});
