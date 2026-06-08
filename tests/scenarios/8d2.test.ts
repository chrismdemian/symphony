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
 * Phase 8D.2 production scenario — the FULL trigger loop with real components
 * (real SQLite, real trigger engine, real broker, real WS-RPC, real injector);
 * a fake trigger source feeds events and a fake Maestro receives turns. Asserts:
 * seed (no fire) → new event → claimTrigger → wake hint → injector pull →
 * ENRICHED delivery → idle → completeRun → run-log success. Plus
 * one-event-per-cycle serialization and disabled-never-fires.
 */

function ev(id: string, title: string): RawTriggerEvent {
  return { id, title, url: `https://x/${id}`, type: 'GitHub issue', extra: id, labels: [], assignee: null };
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

describe('Phase 8D.2 scenario — trigger automation fires into Maestro', () => {
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
    dir = mkdtempSync(path.join(tmpdir(), '8d2-scn-'));
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
    mcpClient = new Client({ name: '8d2-scn', version: '0.0.0' });
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

  it('a new issue fires an ENRICHED turn into Maestro and records success', async () => {
    const a = server.automationStore.create({
      name: 'gh-triage',
      prompt: 'Triage the new issue and propose a fix.',
      triggerType: 'github_issue',
    });

    // First poll seeds the pre-existing issue (does NOT fire).
    fake.set([ev('github:o/r#1', 'Pre-existing')]);
    await server.automationTriggerEngine!.executeTriggerPoll();
    expect(server.automationStore.listPending()).toHaveLength(0);

    // A new issue appears → engine claims it BEFORE the injector connects, so
    // the on-connect poll is the sole deterministic delivery path.
    fake.set([ev('github:o/r#2', 'Login is broken'), ev('github:o/r#1', 'Pre-existing')]);
    const claimed = await server.automationTriggerEngine!.executeTriggerPoll();
    expect(claimed).toHaveLength(1);

    injector.start();
    await waitFor(() => mock.sent.length === 1);
    // The delivered turn carries the event context + the base prompt.
    expect(mock.sent[0]).toContain('[Automation "gh-triage" triggered by GitHub issue: "Login is broken"]');
    expect(mock.sent[0]).toContain('URL: https://x/github:o/r#2');
    expect(mock.sent[0]).toContain('Triage the new issue and propose a fix.');
    expect(server.getContext().automationContext).toBe(true);

    // Maestro finishes → run recorded success, context cleared.
    mock.pushIdle();
    await waitFor(() => server.automationStore.get(a.id)!.inFlight === false);
    expect(server.automationStore.listRunLogs(a.id)[0]!.status).toBe('success');
    await waitFor(() => server.getContext().automationContext === false);
    expect(server.getContext().automationContext).toBe(false);
  });

  it('fires one event per cycle; a second new event fires after the first completes', async () => {
    server.automationStore.create({ name: 't', prompt: 'handle it', triggerType: 'github_issue' });
    fake.set([ev('github:o/r#1', 'seed')]);
    await server.automationTriggerEngine!.executeTriggerPoll(); // seed

    // Two new events at once.
    fake.set([ev('github:o/r#3', 'Third'), ev('github:o/r#2', 'Second'), ev('github:o/r#1', 'seed')]);
    const first = await server.automationTriggerEngine!.executeTriggerPoll();
    expect(first).toHaveLength(1);

    injector.start();
    await waitFor(() => mock.sent.length === 1);
    mock.pushIdle(); // complete the first run
    await waitFor(() => server.automationStore.listPending().length === 0);

    // The other event fires on the next poll (not lost).
    const second = await server.automationTriggerEngine!.executeTriggerPoll();
    expect(second).toHaveLength(1);
    await waitFor(() => mock.sent.length === 2);
    expect(mock.sent[1]).not.toBe(mock.sent[0]);
  });

  it('does not fire a disabled trigger automation', async () => {
    server.automationStore.create({
      name: 'off',
      prompt: 'should not run',
      triggerType: 'github_issue',
      enabled: false,
    });
    fake.set([ev('github:o/r#1', 'a'), ev('github:o/r#2', 'b')]);
    const claimed = await server.automationTriggerEngine!.executeTriggerPoll();
    expect(claimed).toEqual([]);
    injector.start();
    await settle();
    expect(mock.sent).toHaveLength(0);
    expect(server.automationStore.listPending()).toHaveLength(0);
  });
});
