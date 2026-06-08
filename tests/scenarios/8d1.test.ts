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
import { MaestroTurnInFlightError } from '../../src/orchestrator/maestro/process.js';
import type { AutomationSchedule } from '../../src/orchestrator/automation-schedule.js';

/**
 * Phase 8D.1 production scenario — the FULL delivery loop with real
 * components (real SQLite, real scheduler, real broker, real WS-RPC, real
 * injector); only Maestro is faked (we can't run claude -p here). Asserts:
 * scheduler claim → wake hint → injector pull → Maestro delivery → idle →
 * completeRun → run-log success. Plus busy-retry and disabled-never-fires.
 */

const DAILY: AutomationSchedule = { type: 'daily', hour: 9, minute: 0 };

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

/** A fake Maestro: records delivered prompts; emits idle/error on demand. */
function fakeMaestro() {
  const sent: string[] = [];
  let busyOnce = false;
  const queue: Ev[] = [];
  let waiter: ((r: IteratorResult<Ev>) => void) | null = null;
  return {
    sent,
    setBusyOnce: () => {
      busyOnce = true;
    },
    pushIdle: () => push({ type: 'idle', payload: {} }),
    pushError: (reason: string) => push({ type: 'error', reason }),
    maestro: {
      sendUserMessage(text: string): void {
        if (busyOnce) {
          busyOnce = false;
          throw new MaestroTurnInFlightError();
        }
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
  function push(ev: Ev): void {
    if (waiter) {
      const w = waiter;
      waiter = null;
      w({ value: ev, done: false });
    } else {
      queue.push(ev);
    }
  }
}

describe('Phase 8D.1 scenario — scheduled automation fires into Maestro', () => {
  let dir: string;
  let prevConfig: string | undefined;
  let db: SymphonyDatabase;
  let server: OrchestratorServerHandle;
  let rpc: RpcClient<SymphonyRouter>;
  let mcpClient: Client;
  let injector: AutomationInjector;
  let mock: ReturnType<typeof fakeMaestro>;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), '8d1-scn-'));
    prevConfig = process.env['SYMPHONY_CONFIG_FILE'];
    process.env['SYMPHONY_CONFIG_FILE'] = path.join(dir, 'config.json');
    db = SymphonyDatabase.open({ filePath: path.join(dir, 'symphony.db') });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    server = await startOrchestratorServer({
      transport: serverTransport,
      initialMode: 'act',
      database: db,
      automations: { enabled: true },
      automationTickIntervalMs: 1_000_000,
      rpc: { enabled: true, port: 0, skipDescriptorFile: true },
    });
    mcpClient = new Client({ name: '8d1-scn', version: '0.0.0' });
    await mcpClient.connect(clientTransport);
    if (server.rpc === undefined) throw new Error('rpc handle missing');
    rpc = await RpcClient.connect<SymphonyRouter>({
      url: `ws://${server.rpc.host}:${server.rpc.port}`,
      token: server.rpc.token,
    });
    mock = fakeMaestro();
    injector = new AutomationInjector({
      maestro: mock.maestro as unknown as InjectorMaestro,
      // The real RpcClient structurally satisfies the injector's surface.
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

  it('fires a due automation into Maestro and records the run as success', async () => {
    const a = server.automationStore.create({
      name: 'nightly-tests',
      prompt: 'run the full test suite and report failures',
      schedule: DAILY,
    });
    server.automationStore.forceDue(a.id, new Date().toISOString());

    // Scheduler claims the due automation (publishes a wake hint) BEFORE the
    // injector connects, so the injector's on-connect poll is the sole,
    // deterministic delivery path (no second poll to race).
    await server.automationScheduler!.executeTick();
    injector.start();

    // Injector pulls + delivers the prompt to Maestro.
    await waitFor(() => mock.sent.length === 1);
    expect(mock.sent[0]).toContain('run the full test suite');
    expect(mock.sent[0]).toContain('[Scheduled automation: nightly-tests]');
    // Dispatch cursor flipped on while the turn is in flight.
    expect(server.getContext().automationContext).toBe(true);

    // Maestro finishes the turn → injector completes the run.
    mock.pushIdle();
    await waitFor(() => server.automationStore.get(a.id)!.inFlight === false);
    const logs = server.automationStore.listRunLogs(a.id);
    expect(logs[0]!.status).toBe('success');
    expect(server.automationStore.get(a.id)!.lastRunResult).toBe('success');
    // Context cleared after completion.
    await waitFor(() => server.getContext().automationContext === false);
    expect(server.getContext().automationContext).toBe(false);
  });

  it('queues when Maestro is busy and delivers on the next idle', async () => {
    const a = server.automationStore.create({ name: 'busy', prompt: 'do work', schedule: DAILY });
    server.automationStore.forceDue(a.id, new Date().toISOString());
    mock.setBusyOnce(); // first delivery attempt hits a busy Maestro

    await server.automationScheduler!.executeTick(); // claim before connect
    injector.start(); // on-connect poll attempts delivery → busy → caught
    await settle();

    // Busy → nothing delivered yet, but the run stays claimed.
    expect(mock.sent).toHaveLength(0);
    expect(server.automationStore.get(a.id)!.inFlight).toBe(true);

    // Maestro frees up → injector retries on idle.
    mock.pushIdle();
    await waitFor(() => mock.sent.length === 1);
    expect(mock.sent[0]).toContain('do work');
  });

  it('does not fire a disabled automation', async () => {
    const a = server.automationStore.create({
      name: 'off',
      prompt: 'should not run',
      schedule: DAILY,
      enabled: false,
    });
    server.automationStore.forceDue(a.id, new Date().toISOString()); // no-op (disabled)
    await server.automationScheduler!.executeTick();
    injector.start();
    await settle();
    expect(mock.sent).toHaveLength(0);
    expect(server.automationStore.listPending()).toHaveLength(0);
    expect(server.automationStore.get(a.id)!.inFlight).toBe(false);
  });
});
