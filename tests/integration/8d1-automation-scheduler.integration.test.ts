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
import type { AutomationSchedule } from '../../src/orchestrator/automation-schedule.js';

/**
 * Phase 8D.1 — scheduler ↔ store ↔ RPC wiring against real SQLite. The
 * tick interval is huge so the auto-timer never fires; ticks are driven
 * manually via the handle.
 */

const DAILY: AutomationSchedule = { type: 'daily', hour: 9, minute: 0 };
const HOURLY: AutomationSchedule = { type: 'hourly', minute: 0 };

async function waitFor(predicate: () => boolean, tries = 50): Promise<void> {
  for (let i = 0; i < tries; i += 1) {
    if (predicate()) return;
    await new Promise((r) => setImmediate(r));
  }
}

describe('Phase 8D.1 — automation scheduler (integration)', () => {
  let dir: string;
  let prevConfig: string | undefined;
  let db: SymphonyDatabase;
  let server: OrchestratorServerHandle;
  let rpc: RpcClient<SymphonyRouter>;
  let mcpClient: Client;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), '8d1-int-'));
    prevConfig = process.env['SYMPHONY_CONFIG_FILE'];
    // Point config at a missing file → loadConfig returns defaults
    // (automationsEnabled = true) without reading the user's real config.
    process.env['SYMPHONY_CONFIG_FILE'] = path.join(dir, 'config.json');
    db = SymphonyDatabase.open({ filePath: ':memory:' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    server = await startOrchestratorServer({
      transport: serverTransport,
      initialMode: 'act',
      database: db,
      automations: { enabled: true },
      automationTickIntervalMs: 1_000_000,
      rpc: { enabled: true, port: 0, skipDescriptorFile: true },
    });
    mcpClient = new Client({ name: '8d1-int', version: '0.0.0' });
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

  it('claims a due automation → wake hint + takePending over RPC → completeRun clears it', async () => {
    expect(server.automationScheduler).toBeDefined();
    const a = server.automationStore.create({ name: 'nightly', prompt: 'run tests', schedule: DAILY });
    server.automationStore.forceDue(a.id, new Date().toISOString());

    const wakes: unknown[] = [];
    const sub = await rpc.subscribe('automations.events', {}, (p) => wakes.push(p));

    const claimed = await server.automationScheduler!.executeTick();
    expect(claimed).toHaveLength(1);

    await waitFor(() => wakes.length > 0);
    expect(wakes).toHaveLength(1);
    expect((wakes[0] as { runLogId: number }).runLogId).toBe(claimed[0]);

    const pending = await rpc.call.automations.takePending();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.runLogId).toBe(claimed[0]);
    expect(pending[0]!.prompt).toBe('run tests');

    const res = await rpc.call.automations.completeRun({ runLogId: claimed[0]!, status: 'success' });
    expect(res.completed).toBe(true);
    expect(server.automationStore.get(a.id)!.inFlight).toBe(false);
    expect(server.automationStore.get(a.id)!.lastRunResult).toBe('success');
    expect(await rpc.call.automations.takePending()).toHaveLength(0);

    await sub.unsubscribe();
  });

  it('runtime.setAutomationContext flips the dispatch cursor', async () => {
    expect(server.getContext().automationContext).toBe(false);
    await rpc.call.runtime.setAutomationContext({ active: true });
    expect(server.getContext().automationContext).toBe(true);
    await rpc.call.runtime.setAutomationContext({ active: false });
    expect(server.getContext().automationContext).toBe(false);
  });

  it('completeRun rejects a bad runLogId and bad status', async () => {
    await expect(
      rpc.call.automations.completeRun({ runLogId: 1.5, status: 'success' }),
    ).rejects.toThrow();
    await expect(
      rpc.call.automations.completeRun({
        runLogId: 1,
        status: 'bogus' as 'success',
      }),
    ).rejects.toThrow();
  });

  it('a fresh server reconciles orphaned runs left by a prior session', async () => {
    const file = path.join(dir, 'reconcile.db');
    // Session 1: claim a run, then "crash" (close without completing it).
    const db1 = SymphonyDatabase.open({ filePath: file });
    const [, st1] = InMemoryTransport.createLinkedPair();
    const s1 = await startOrchestratorServer({
      transport: st1,
      database: db1,
      automations: { enabled: true },
      automationTickIntervalMs: 1_000_000,
      rpc: { enabled: false },
    });
    const a = s1.automationStore.create({ name: 'x', prompt: 'p', schedule: HOURLY });
    s1.automationStore.forceDue(a.id, new Date().toISOString());
    await s1.automationScheduler!.executeTick();
    expect(s1.automationStore.listPending()).toHaveLength(1);
    await s1.close();
    db1.close();

    // Session 2: a fresh server on the same DB file reconciles on boot.
    const db2 = SymphonyDatabase.open({ filePath: file });
    const [, st2] = InMemoryTransport.createLinkedPair();
    const s2 = await startOrchestratorServer({
      transport: st2,
      database: db2,
      automations: { enabled: true },
      automationTickIntervalMs: 1_000_000,
      rpc: { enabled: false },
    });
    await waitFor(() => s2.automationStore.listPending().length === 0);
    expect(s2.automationStore.listPending()).toHaveLength(0);
    expect(s2.automationStore.get(a.id)!.inFlight).toBe(false);
    expect(s2.automationStore.get(a.id)!.lastRunResult).toBe('failure');
    await s2.close();
    db2.close();
  });
});
