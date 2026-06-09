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
import { SentryConnector } from '../../src/integrations/sentry.js';
import { defaultSentryConfig } from '../../src/integrations/sentry-config.js';
import type { SentryClientLike, SentryIssueNode } from '../../src/integrations/sentry-client.js';

process.env.SYMPHONY_DISABLE_KEYRING = '1';

/**
 * Phase 8D.5 production scenario — the FULL trigger loop end-to-end with real
 * components (real SQLite, a REAL `SentryConnector` over a fake client, the real
 * trigger engine, broker, WS-RPC, and injector); a fake Maestro receives turns.
 * Asserts: seed (no fire) → a new Sentry error group → claimTrigger → wake hint
 * → injector pull → ENRICHED delivery → idle → completeRun → run-log success.
 */

function node(over: Partial<SentryIssueNode>): SentryIssueNode {
  return {
    project: 'backend',
    id: '1000',
    shortId: 'BACKEND-1',
    title: 'TypeError: boom',
    culprit: 'app/handler',
    permalink: 'https://sentry.io/organizations/acme/issues/1000/',
    status: 'unresolved',
    level: 'error',
    lastSeen: '2026-06-08T00:00:00Z',
    assignee: null,
    ...over,
  };
}

function fakeClient(issues: Record<string, SentryIssueNode[]>): SentryClientLike {
  return {
    listUnresolvedIssues: async (project) => issues[project] ?? [],
    searchIssues: async () => [],
    addNote: async () => {},
    resolveIssue: async () => {},
  };
}

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

describe('Phase 8D.5 scenario — a new Sentry error fires an enriched turn into Maestro', () => {
  let dir: string;
  let prevConfig: string | undefined;
  let db: SymphonyDatabase;
  let server: OrchestratorServerHandle;
  let rpc: RpcClient<SymphonyRouter>;
  let mcpClient: Client;
  let injector: AutomationInjector;
  let mock: ReturnType<typeof fakeMaestro>;
  let issues: Record<string, SentryIssueNode[]>;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), '8d5-scn-'));
    prevConfig = process.env['SYMPHONY_CONFIG_FILE'];
    process.env['SYMPHONY_CONFIG_FILE'] = path.join(dir, 'config.json');
    db = SymphonyDatabase.open({ filePath: path.join(dir, 'symphony.db') });
    issues = { backend: [node({ id: '1', title: 'Pre-existing error' })] };
    const connector = new SentryConnector({
      client: fakeClient(issues),
      config: { ...defaultSentryConfig(), org: 'acme', projects: ['backend'] },
      sleep: () => Promise.resolve(),
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    server = await startOrchestratorServer({
      transport: serverTransport,
      initialMode: 'act',
      database: db,
      sentryConnector: connector,
      automations: { enabled: true },
      automationTickIntervalMs: 1_000_000,
      automationTriggerPollIntervalMs: 1_000_000,
      automationTriggerWarmupMs: 1_000_000,
      rpc: { enabled: true, port: 0, skipDescriptorFile: true },
    });
    mcpClient = new Client({ name: '8d5-scn', version: '0.0.0' });
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

  it('a new error group fires an ENRICHED turn into Maestro and records success', async () => {
    const a = server.automationStore.create({
      name: 'sentry-triage',
      prompt: 'Investigate the new Sentry error and propose a fix.',
      triggerType: 'sentry_error',
    });

    // First poll seeds the pre-existing error (does NOT fire).
    await server.automationTriggerEngine!.executeTriggerPoll();
    expect(server.automationStore.listPending()).toHaveLength(0);

    // A new error appears → engine claims it.
    issues.backend = [
      node({ id: '2', title: 'Unhandled rejection in /checkout', level: 'fatal' }),
      node({ id: '1', title: 'Pre-existing error' }),
    ];
    const claimed = await server.automationTriggerEngine!.executeTriggerPoll();
    expect(claimed).toHaveLength(1);

    injector.start();
    await waitFor(() => mock.sent.length === 1);
    expect(mock.sent[0]).toContain(
      '[Automation "sentry-triage" triggered by Sentry issue: "Unhandled rejection in /checkout"]',
    );
    expect(mock.sent[0]).toContain('Investigate the new Sentry error and propose a fix.');
    expect(server.getContext().automationContext).toBe(true);

    // Maestro finishes → run recorded success, context cleared.
    mock.pushIdle();
    await waitFor(() => server.automationStore.get(a.id)!.inFlight === false);
    expect(server.automationStore.listRunLogs(a.id)[0]!.status).toBe('success');
    await waitFor(() => server.getContext().automationContext === false);
    expect(server.getContext().automationContext).toBe(false);
  });
});
