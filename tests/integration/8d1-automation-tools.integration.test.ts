import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  startOrchestratorServer,
  type OrchestratorServerHandle,
} from '../../src/orchestrator/index.js';
import { SymphonyDatabase } from '../../src/state/db.js';

/**
 * Phase 8D.1 — agent-native end-to-end: Maestro creates/manages an
 * automation via MCP tools, and the (same-process, shared-DB) scheduler
 * claims it. Proves parity with the CLI path through the real MCP client →
 * registry → store → scheduler.
 */

describe('Phase 8D.1 — automation MCP tools (integration)', () => {
  let dir: string;
  let prevConfig: string | undefined;
  let db: SymphonyDatabase;
  let server: OrchestratorServerHandle;
  let client: Client;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), '8d1-tools-'));
    prevConfig = process.env['SYMPHONY_CONFIG_FILE'];
    process.env['SYMPHONY_CONFIG_FILE'] = path.join(dir, 'config.json');
    db = SymphonyDatabase.open({ filePath: ':memory:' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    server = await startOrchestratorServer({
      transport: serverTransport,
      initialMode: 'act',
      database: db,
      projects: { alpha: '/repos/alpha' },
      automations: { enabled: true },
      automationTickIntervalMs: 1_000_000,
      rpc: { enabled: false },
    });
    client = new Client({ name: '8d1-tools', version: '0.0.0' });
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
    db.close();
    rmSync(dir, { recursive: true, force: true });
    if (prevConfig === undefined) delete process.env['SYMPHONY_CONFIG_FILE'];
    else process.env['SYMPHONY_CONFIG_FILE'] = prevConfig;
  });

  it('create_automation → list → run → scheduler claims it', async () => {
    const created = await client.callTool({
      name: 'create_automation',
      arguments: {
        name: 'nightly',
        prompt: 'run the test suite and report failures',
        every: 'daily',
        at: '02:00',
        project: 'alpha',
      },
    });
    expect(created.isError).toBeFalsy();
    const sc = created.structuredContent as { id: string; projectId: string; enabled: boolean };
    expect(sc.projectId).toBe(server.projectStore.get('alpha')!.id);
    expect(sc.enabled).toBe(true);

    // It landed in the shared store the scheduler reads.
    expect(server.automationStore.list()).toHaveLength(1);

    const listed = await client.callTool({ name: 'list_automations', arguments: {} });
    expect((listed.structuredContent as { automations: unknown[] }).automations).toHaveLength(1);

    // Force it due via the tool, then tick the scheduler.
    const ran = await client.callTool({ name: 'run_automation', arguments: { id: sc.id } });
    expect(ran.isError).toBeFalsy();
    const claimed = await server.automationScheduler!.executeTick();
    expect(claimed).toHaveLength(1);
    expect(server.automationStore.listPending()[0]!.automationName).toBe('nightly');
  });

  it('set_automation_enabled + remove_automation behave + error on missing id', async () => {
    const created = await client.callTool({
      name: 'create_automation',
      arguments: { name: 'a', prompt: 'p', every: 'hourly' },
    });
    const id = (created.structuredContent as { id: string }).id;

    await client.callTool({ name: 'set_automation_enabled', arguments: { id, enabled: false } });
    expect(server.automationStore.get(id)!.enabled).toBe(false);

    // run on a disabled automation is rejected by the tool.
    const ranDisabled = await client.callTool({ name: 'run_automation', arguments: { id } });
    expect(ranDisabled.isError).toBe(true);

    const removed = await client.callTool({ name: 'remove_automation', arguments: { id } });
    expect(removed.isError).toBeFalsy();
    expect(server.automationStore.get(id)).toBeUndefined();

    const missing = await client.callTool({ name: 'remove_automation', arguments: { id } });
    expect(missing.isError).toBe(true);
  });

  it('create_automation rejects an invalid interval', async () => {
    const res = await client.callTool({
      name: 'create_automation',
      arguments: { name: 'x', prompt: 'p', every: 'fortnightly' },
    });
    expect(res.isError).toBe(true);
    expect(server.automationStore.list()).toHaveLength(0);
  });
});
