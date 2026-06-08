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
import { RpcClient } from '../../src/rpc/client.js';
import type { SymphonyRouter } from '../../src/rpc/router-impl.js';
import type { RawTriggerEvent, TriggerSource } from '../../src/orchestrator/automation-trigger-source.js';
import { formatAutomationPrompt } from '../../src/orchestrator/maestro/automation-injector.js';

/**
 * Phase 8D.2 — trigger engine ↔ store ↔ RPC wiring against real SQLite. A fake
 * trigger source (no network) feeds events; polls are driven manually via the
 * handle (poll interval set huge so the auto-timer never fires). Verifies the
 * full path: detect new → claimTrigger → wake hint + takePending carries the
 * trigger_event → the launcher's enrichment → completeRun clears it.
 */

function ev(id: string, title: string): RawTriggerEvent {
  return { id, title, url: `https://x/${id}`, type: 'GitHub issue', extra: id, labels: [], assignee: null };
}

/** A controllable fake source. */
function fakeSource(): { source: TriggerSource; set: (e: RawTriggerEvent[]) => void } {
  let events: RawTriggerEvent[] = [];
  return {
    source: { triggerType: 'github_issue', fetchEvents: async () => events },
    set: (e) => {
      events = e;
    },
  };
}

async function waitFor(predicate: () => boolean, tries = 50): Promise<void> {
  for (let i = 0; i < tries; i += 1) {
    if (predicate()) return;
    await new Promise((r) => setImmediate(r));
  }
}

describe('Phase 8D.2 — automation trigger engine (integration)', () => {
  let dir: string;
  let prevConfig: string | undefined;
  let db: SymphonyDatabase;
  let server: OrchestratorServerHandle;
  let rpc: RpcClient<SymphonyRouter>;
  let mcpClient: Client;
  let fake: ReturnType<typeof fakeSource>;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), '8d2-int-'));
    prevConfig = process.env['SYMPHONY_CONFIG_FILE'];
    process.env['SYMPHONY_CONFIG_FILE'] = path.join(dir, 'config.json');
    db = SymphonyDatabase.open({ filePath: ':memory:' });
    fake = fakeSource();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    server = await startOrchestratorServer({
      transport: serverTransport,
      initialMode: 'act',
      database: db,
      automations: { enabled: true },
      automationTickIntervalMs: 1_000_000,
      automationTriggerSources: new Map([['github_issue', fake.source]]),
      automationTriggerPollIntervalMs: 1_000_000,
      automationTriggerWarmupMs: 1_000_000,
      rpc: { enabled: true, port: 0, skipDescriptorFile: true },
    });
    mcpClient = new Client({ name: '8d2-int', version: '0.0.0' });
    await mcpClient.connect(clientTransport);
    if (server.rpc === undefined) throw new Error('rpc handle missing');
    rpc = await RpcClient.connect<SymphonyRouter>({
      url: `ws://${server.rpc.host}:${server.rpc.port}`,
      token: server.rpc.token,
    });
  });

  afterEach(async () => {
    await rpc.close().catch(() => {});
    await mcpClient.close().catch(() => {});
    await server.close().catch(() => {});
    db.close();
    rmSync(dir, { recursive: true, force: true });
    if (prevConfig === undefined) delete process.env['SYMPHONY_CONFIG_FILE'];
    else process.env['SYMPHONY_CONFIG_FILE'] = prevConfig;
  });

  it('new event → claimTrigger → wake hint + takePending carries the event → enrich → completeRun', async () => {
    expect(server.automationTriggerEngine).toBeDefined();
    const a = server.automationStore.create({
      name: 'gh-triage',
      prompt: 'Triage the issue.',
      triggerType: 'github_issue',
    });

    // First poll seeds {#1} without firing.
    fake.set([ev('github:o/r#1', 'Old issue')]);
    expect(await server.automationTriggerEngine!.executeTriggerPoll()).toEqual([]);
    expect(server.automationStore.listPending()).toHaveLength(0);

    // A new issue appears → fires.
    const wakes: unknown[] = [];
    const sub = await rpc.subscribe('automations.events', {}, (p) => wakes.push(p));
    fake.set([ev('github:o/r#2', 'Login broken'), ev('github:o/r#1', 'Old issue')]);
    const claimed = await server.automationTriggerEngine!.executeTriggerPoll();
    expect(claimed).toHaveLength(1);

    await waitFor(() => wakes.length > 0);
    expect((wakes[0] as { runLogId: number }).runLogId).toBe(claimed[0]);

    // The launcher PULLS the claimed run; it carries the firing event's JSON.
    const pending = await rpc.call.automations.takePending();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.runLogId).toBe(claimed[0]);
    expect(pending[0]!.triggerEvent).not.toBeNull();
    expect(JSON.parse(pending[0]!.triggerEvent!)).toMatchObject({ id: 'github:o/r#2', title: 'Login broken' });

    // The injector's formatter enriches the prompt with event context.
    const enriched = formatAutomationPrompt(pending[0]!);
    expect(enriched).toContain('[Automation "gh-triage" triggered by GitHub issue: "Login broken"]');
    expect(enriched).toContain('URL: https://x/github:o/r#2');
    expect(enriched).toContain('Triage the issue.');

    // Complete the run → in_flight clears → the automation polls again.
    const res = await rpc.call.automations.completeRun({ runLogId: claimed[0]!, status: 'success' });
    expect(res.completed).toBe(true);
    expect(server.automationStore.get(a.id)!.inFlight).toBe(false);
    expect(server.automationStore.get(a.id)!.lastRunResult).toBe('success');
    expect(await rpc.call.automations.takePending()).toHaveLength(0);

    await sub.unsubscribe();
  });

  it('create_automation MCP tool → trigger automation fires on the engine poll', async () => {
    // Maestro creates a trigger automation via the agent-native tool.
    const created = await mcpClient.callTool({
      name: 'create_automation',
      arguments: { name: 'from-maestro', prompt: 'handle it', triggerType: 'github_issue' },
    });
    expect((created as { isError?: boolean }).isError).toBeFalsy();

    // Seed then fire.
    fake.set([ev('github:o/r#10', 'Existing')]);
    await server.automationTriggerEngine!.executeTriggerPoll(); // seed
    fake.set([ev('github:o/r#11', 'Brand new'), ev('github:o/r#10', 'Existing')]);
    const claimed = await server.automationTriggerEngine!.executeTriggerPoll();
    expect(claimed).toHaveLength(1);

    const pending = await rpc.call.automations.takePending();
    expect(pending[0]!.prompt).toBe('handle it');
    expect(JSON.parse(pending[0]!.triggerEvent!)).toMatchObject({ id: 'github:o/r#11' });
  });
});
