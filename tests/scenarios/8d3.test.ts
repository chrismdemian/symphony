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
import { SqliteAutomationStore } from '../../src/state/sqlite-automation-store.js';
import { RpcClient } from '../../src/rpc/client.js';
import type { SymphonyRouter } from '../../src/rpc/router-impl.js';
import {
  AutomationInjector,
  type InjectorMaestro,
  type InjectorRpc,
} from '../../src/orchestrator/maestro/automation-injector.js';
import type { AutomationSchedule } from '../../src/orchestrator/automation-schedule.js';

/**
 * Phase 8D.3 production scenario — the FULL cold-start catch-up loop with real
 * components (real SQLite FILE across a session boundary, real server boot
 * reconcile, real broker, real WS-RPC, real injector); a fake Maestro receives
 * the delivered turn. Asserts: a prior session leaves an ORPHAN (in_flight +
 * 'running' log + far-past next_run_at); the fresh server's boot-time
 * `reconcile('startup')` FAILS the orphan AND catches up the missed schedule
 * exactly once; the injector PULLS the caught-up run and delivers a scheduled
 * turn into Maestro; idle → completeRun records success.
 */

const HOURLY: AutomationSchedule = { type: 'hourly', minute: 0 };
// Far in the past so the orphan is unambiguously overdue regardless of the
// real system clock the booted server reconciles against.
const T_PRIOR = Date.parse('2020-01-01T00:00:00.000Z');
const T_PRIOR_NEXT = '2020-01-01T01:00:00.000Z';

async function waitFor(predicate: () => boolean, tries = 80): Promise<void> {
  for (let i = 0; i < tries; i += 1) {
    if (predicate()) return;
    await new Promise((r) => setImmediate(r));
  }
}

type Ev = { type: 'idle'; payload: unknown } | { type: 'error'; reason: string };

function fakeMaestro() {
  const sent: string[] = [];
  const queue: Ev[] = [];
  let waiter: ((r: IteratorResult<Ev>) => void) | null = null;
  function push(e: Ev): void {
    if (waiter) {
      const w = waiter;
      waiter = null;
      w({ value: e, done: false });
    } else {
      queue.push(e);
    }
  }
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
}

describe('Phase 8D.3 scenario — cold-start catch-up fires a missed schedule into Maestro', () => {
  let dir: string;
  let dbFile: string;
  let prevConfig: string | undefined;
  let db: SymphonyDatabase;
  let server: OrchestratorServerHandle;
  let rpc: RpcClient<SymphonyRouter>;
  let mcpClient: Client;
  let injector: AutomationInjector;
  let mock: ReturnType<typeof fakeMaestro>;
  let orphanId: string;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), '8d3-scn-'));
    dbFile = path.join(dir, 'symphony.db');
    prevConfig = process.env['SYMPHONY_CONFIG_FILE'];
    process.env['SYMPHONY_CONFIG_FILE'] = path.join(dir, 'config.json');

    // ---- Prior session: leave an orphaned, overdue automation, then close. ---
    {
      const seedDb = SymphonyDatabase.open({ filePath: dbFile });
      const seedStore = new SqliteAutomationStore(seedDb.db, { now: () => T_PRIOR });
      const orphan = seedStore.create({
        name: 'orphaned-nightly',
        prompt: 'Run the nightly checks.',
        schedule: HOURLY,
      });
      orphanId = orphan.id;
      seedStore.claim(orphan.id, T_PRIOR_NEXT, new Date(T_PRIOR).toISOString());
      seedDb.close();
    }

    // ---- Fresh session: boot the real server on the SAME file. -------------
    db = SymphonyDatabase.open({ filePath: dbFile });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    server = await startOrchestratorServer({
      transport: serverTransport,
      initialMode: 'act',
      database: db,
      automations: { enabled: true },
      automationTickIntervalMs: 1_000_000,
      automationTriggerPollIntervalMs: 1_000_000,
      automationTriggerWarmupMs: 1_000_000,
      rpc: { enabled: true, port: 0, skipDescriptorFile: true },
    });
    mcpClient = new Client({ name: '8d3-scn', version: '0.0.0' });
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

  it('boot reconcile fails the orphan, catches up once, and the injector delivers it', async () => {
    // Boot-time reconcile('startup') is fire-and-forget — wait for the catch-up.
    await waitFor(() => server.automationStore.listPending().length === 1);

    const after = server.automationStore.get(orphanId)!;
    expect(after.inFlight).toBe(true); // re-claimed by catch-up
    // Exactly-once: prior claim (1) + catch-up (1) = 2 — NOT one per missed hour.
    expect(after.runCount).toBe(2);
    expect(Date.parse(after.nextRunAt!)).toBeGreaterThan(T_PRIOR);
    // The orphan's old log was failed; the catch-up inserted a fresh running one.
    const logs = server.automationStore.listRunLogs(orphanId);
    expect(logs.filter((l) => l.status === 'failure')).toHaveLength(1);
    expect(logs.filter((l) => l.status === 'running')).toHaveLength(1);

    // The injector pulls the caught-up run (over real WS-RPC) + delivers it.
    injector.start();
    await waitFor(() => mock.sent.length === 1);
    expect(mock.sent[0]).toContain('[Scheduled automation: orphaned-nightly]');
    expect(mock.sent[0]).toContain('Run the nightly checks.');

    // Maestro finishes → the run is recorded success and in_flight clears.
    mock.pushIdle();
    await waitFor(() => server.automationStore.get(orphanId)!.inFlight === false);
    expect(server.automationStore.get(orphanId)!.lastRunResult).toBe('success');
    expect(server.automationStore.listPending()).toHaveLength(0);
  });
});
