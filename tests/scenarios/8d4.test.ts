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
import { RpcClient } from '../../src/rpc/client.js';
import type { SymphonyRouter } from '../../src/rpc/router-impl.js';
import {
  AutomationInjector,
  type InjectorMaestro,
  type InjectorRpc,
} from '../../src/orchestrator/maestro/automation-injector.js';
import type { RawTriggerEvent, TriggerSource } from '../../src/orchestrator/automation-trigger-source.js';

/**
 * Phase 8D.4 production scenario — the FULL filtered trigger loop with real
 * components (real SQLite, real trigger engine, real broker, real WS-RPC, real
 * injector); a fake source feeds labeled events and a fake Maestro receives
 * turns. Asserts: a label-scoped trigger created via the agent-native MCP tool
 * fires into Maestro ONLY for events matching the filter; non-matching events
 * are marked known and never delivered.
 */

function ev(id: string, title: string, labels: string[] = []): RawTriggerEvent {
  return { id, title, url: `https://x/${id}`, type: 'GitHub issue', extra: id, labels, assignee: null };
}

function fakeSource(): { source: TriggerSource; set: (e: RawTriggerEvent[]) => void } {
  let events: RawTriggerEvent[] = [];
  return {
    source: { triggerType: 'github_issue', fetchEvents: async () => events },
    set: (e) => {
      events = e;
    },
  };
}

async function waitFor(predicate: () => boolean, tries = 80): Promise<void> {
  for (let i = 0; i < tries; i += 1) {
    if (predicate()) return;
    await new Promise((r) => setImmediate(r));
  }
}

async function settle(hops = 20): Promise<void> {
  for (let i = 0; i < hops; i += 1) await new Promise((r) => setImmediate(r));
}

type Ev = { type: 'idle'; payload: unknown } | { type: 'error'; reason: string };

function fakeMaestro() {
  const sent: string[] = [];
  const queue: Ev[] = [];
  let waiter: ((r: IteratorResult<Ev>) => void) | null = null;
  return {
    sent,
    pushIdle: () => push({ type: 'idle', payload: {} }),
    maestro: {
      sendUserMessage(text: string): void {
        sent.push(text);
      },
      events(): AsyncIterableIterator<Ev> {
        return {
          [Symbol.asyncIterator]() {
            return this;
          },
          next(): Promise<IteratorResult<Ev>> {
            if (queue.length > 0) return Promise.resolve({ value: queue.shift()!, done: false });
            return new Promise((res) => {
              waiter = res;
            });
          },
        };
      },
    },
  };
  function push(e: Ev): void {
    if (waiter) {
      const w = waiter;
      waiter = null;
      w({ value: e, done: false });
    } else {
      queue.push(e);
    }
  }
}

describe('Phase 8D.4 scenario — filtered trigger fires only on matching events', () => {
  let dir: string;
  let prevConfig: string | undefined;
  let db: SymphonyDatabase;
  let server: OrchestratorServerHandle;
  let rpc: RpcClient<SymphonyRouter>;
  let mcpClient: Client;
  let injector: AutomationInjector;
  let mock: ReturnType<typeof fakeMaestro>;
  let fake: ReturnType<typeof fakeSource>;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), '8d4-scn-'));
    prevConfig = process.env['SYMPHONY_CONFIG_FILE'];
    process.env['SYMPHONY_CONFIG_FILE'] = path.join(dir, 'config.json');
    db = SymphonyDatabase.open({ filePath: path.join(dir, 'symphony.db') });
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
    mcpClient = new Client({ name: '8d4-scn', version: '0.0.0' });
    await mcpClient.connect(clientTransport);
    if (server.rpc === undefined) throw new Error('rpc handle missing');
    rpc = await RpcClient.connect<SymphonyRouter>({
      url: `ws://${server.rpc.host}:${server.rpc.port}`,
      token: server.rpc.token,
    });
    mock = fakeMaestro();
    injector = new AutomationInjector({
      maestro: mock.maestro as unknown as InjectorMaestro,
      rpc: rpc as unknown as InjectorRpc,
      safetyPollMs: 1_000_000,
    });
  });

  afterEach(async () => {
    await injector.stop().catch(() => {});
    await rpc.close().catch(() => {});
    await mcpClient.close().catch(() => {});
    await server.close().catch(() => {});
    db.close();
    rmSync(dir, { recursive: true, force: true });
    if (prevConfig === undefined) delete process.env['SYMPHONY_CONFIG_FILE'];
    else process.env['SYMPHONY_CONFIG_FILE'] = prevConfig;
  });

  it('Maestro creates a label-scoped trigger; only the matching issue is delivered', async () => {
    // Maestro creates the filtered automation via the agent-native MCP tool.
    const created = await mcpClient.callTool({
      name: 'create_automation',
      arguments: {
        name: 'gh-bugs',
        prompt: 'Fix the reported bug.',
        triggerType: 'github_issue',
        labelFilter: ['bug'],
      },
    });
    expect((created as { isError?: boolean }).isError).toBeFalsy();
    const auto = server.automationStore.list()[0]!;
    expect(auto.triggerConfig).toBe(JSON.stringify({ labelFilter: ['bug'] }));

    // Seed a pre-existing (unlabeled) issue.
    fake.set([ev('github:o/r#1', 'Pre-existing', ['docs'])]);
    await server.automationTriggerEngine!.executeTriggerPoll();
    expect(server.automationStore.listPending()).toHaveLength(0);

    injector.start();

    // A non-matching issue (wrong label) appears → engine ignores it, nothing delivered.
    fake.set([ev('github:o/r#2', 'Wrong label', ['enhancement']), ev('github:o/r#1', 'Pre-existing', ['docs'])]);
    expect(await server.automationTriggerEngine!.executeTriggerPoll()).toEqual([]);
    await settle();
    expect(mock.sent).toHaveLength(0);

    // A matching issue (has 'bug') appears → claimed, enriched, delivered into Maestro.
    fake.set([
      ev('github:o/r#3', 'Login is broken', ['bug', 'p1']),
      ev('github:o/r#2', 'Wrong label', ['enhancement']),
    ]);
    const claimed = await server.automationTriggerEngine!.executeTriggerPoll();
    expect(claimed).toHaveLength(1);

    await waitFor(() => mock.sent.length === 1);
    expect(mock.sent[0]).toContain('[Automation "gh-bugs" triggered by GitHub issue: "Login is broken"]');
    expect(mock.sent[0]).toContain('Fix the reported bug.');

    // Maestro finishes → run recorded success.
    mock.pushIdle();
    await waitFor(() => server.automationStore.get(auto.id)!.inFlight === false);
    expect(server.automationStore.listRunLogs(auto.id)[0]!.status).toBe('success');

    // The non-matching issue was marked known — it never fires even later.
    fake.set([ev('github:o/r#2', 'Wrong label', ['enhancement'])]);
    expect(await server.automationTriggerEngine!.executeTriggerPoll()).toEqual([]);
    await settle();
    expect(mock.sent).toHaveLength(1);
  });
});
