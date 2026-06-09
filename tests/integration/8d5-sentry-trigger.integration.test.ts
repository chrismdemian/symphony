import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
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
import { SentryConnector } from '../../src/integrations/sentry.js';
import { defaultSentryConfig } from '../../src/integrations/sentry-config.js';
import type { SentryClientLike, SentryIssueNode } from '../../src/integrations/sentry-client.js';
import { formatAutomationPrompt } from '../../src/orchestrator/maestro/automation-injector.js';

// The integration config doesn't load tests/setup.ts; this test injects the
// connector + fake client and never reads tokens.
process.env.SYMPHONY_DISABLE_KEYRING = '1';

/**
 * Phase 8D.5 integration — real SQLite + a real orchestrator server + a REAL
 * `SentryConnector` over an injected `SentryClientLike` fake (no live API).
 * Proves the full wiring through server.ts: (1) the `sync_sentry` tool creates
 * tasks + links and skips resolved issues; (2) a terminal task transition pushes
 * status back as a NOTE (and resolves only when opted in); (3) the connector is
 * exposed as the `sentry_error` automation trigger source — a new error group
 * fires a claim carrying the enriched event.
 */

interface FakeClient extends SentryClientLike {
  readonly noteCalls: { id: string; text: string }[];
  readonly resolveCalls: string[];
}

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

/** A live-readable fake — mutate `issues[project]` between polls. */
function fakeClient(issues: Record<string, SentryIssueNode[]>): FakeClient {
  const noteCalls: FakeClient['noteCalls'] = [];
  const resolveCalls: FakeClient['resolveCalls'] = [];
  return {
    noteCalls,
    resolveCalls,
    listUnresolvedIssues: async (project) => issues[project] ?? [],
    searchIssues: async () => [],
    addNote: async (id, text) => {
      noteCalls.push({ id, text });
    },
    resolveIssue: async (id) => {
      resolveCalls.push(id);
    },
  };
}

async function flush(): Promise<void> {
  await new Promise((r) => setImmediate(r));
  await Promise.resolve();
}

async function waitFor(predicate: () => boolean, tries = 60): Promise<void> {
  for (let i = 0; i < tries; i += 1) {
    if (predicate()) return;
    await new Promise((r) => setImmediate(r));
  }
}

describe('Phase 8D.5 — Sentry connector + trigger source (integration)', () => {
  let dir: string;
  let prevConfig: string | undefined;
  let db: SymphonyDatabase;
  let server: OrchestratorServerHandle;
  let mcpClient: Client;
  let rpc: RpcClient<SymphonyRouter>;
  let fc: FakeClient;
  let issues: Record<string, SentryIssueNode[]>;

  async function boot(resolveOnCompleted = false): Promise<void> {
    fc = fakeClient(issues);
    const connector = new SentryConnector({
      client: fc,
      config: { ...defaultSentryConfig(), org: 'acme', projects: ['backend'], resolveOnCompleted },
      sleep: () => Promise.resolve(),
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    server = await startOrchestratorServer({
      transport: serverTransport,
      initialMode: 'act',
      initialTier: 2,
      database: db,
      projects: { backend: '/tmp/8d5-backend' },
      sentryConnector: connector,
      automations: { enabled: true },
      automationTickIntervalMs: 1_000_000,
      automationTriggerPollIntervalMs: 1_000_000,
      automationTriggerWarmupMs: 1_000_000,
      rpc: { enabled: true, port: 0, skipDescriptorFile: true },
    });
    mcpClient = new Client({ name: '8d5-int', version: '0.0.0' });
    await mcpClient.connect(clientTransport);
    if (server.rpc === undefined) throw new Error('rpc handle missing');
    rpc = await RpcClient.connect<SymphonyRouter>({
      url: `ws://${server.rpc.host}:${server.rpc.port}`,
      token: server.rpc.token,
    });
  }

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), '8d5-int-'));
    prevConfig = process.env['SYMPHONY_CONFIG_FILE'];
    process.env['SYMPHONY_CONFIG_FILE'] = path.join(dir, 'config.json');
    db = SymphonyDatabase.open({ filePath: ':memory:' });
    issues = {};
  });

  afterEach(async () => {
    await rpc?.close().catch(() => {});
    await mcpClient?.close().catch(() => {});
    await server?.close().catch(() => {});
    db.close();
    rmSync(dir, { recursive: true, force: true });
    if (prevConfig === undefined) delete process.env['SYMPHONY_CONFIG_FILE'];
    else process.env['SYMPHONY_CONFIG_FILE'] = prevConfig;
  });

  it('sync_sentry creates a task + link per unresolved issue, skips resolved, idempotently', async () => {
    issues = {
      backend: [
        node({ id: '1', title: 'First' }),
        node({ id: '2', title: 'Already fixed', status: 'resolved' }),
      ],
    };
    await boot();

    const res = await mcpClient.callTool({ name: 'sync_sentry', arguments: {} });
    expect(res.isError).toBeFalsy();
    const sc = res.structuredContent as { createdCount: number; skippedDone: number };
    expect(sc.createdCount).toBe(1);
    expect(sc.skippedDone).toBe(1);

    expect(server.externalLinkStore.getByExternal('sentry', 'backend#1')).toBeDefined();
    expect(server.externalLinkStore.getByExternal('sentry', 'backend#2')).toBeUndefined();

    const res2 = await mcpClient.callTool({ name: 'sync_sentry', arguments: {} });
    const sc2 = res2.structuredContent as { createdCount: number; skippedExisting: number };
    expect(sc2.createdCount).toBe(0);
    expect(sc2.skippedExisting).toBe(1);
  });

  it('completion fires the writeback hook → posts a note and does NOT resolve by default', async () => {
    issues = { backend: [node({ id: '42', title: 'Investigate me' })] };
    await boot(false);

    const res = await mcpClient.callTool({ name: 'sync_sentry', arguments: {} });
    const taskId = (res.structuredContent as { created: string[] }).created[0]!;
    server.taskStore.update(taskId, { status: 'in_progress' });
    server.taskStore.update(taskId, { status: 'completed' });
    await flush();
    await flush();

    expect(fc.noteCalls).toEqual([{ id: '42', text: 'Investigated by Symphony.' }]);
    expect(fc.resolveCalls).toEqual([]);
  });

  it('completion ALSO resolves when resolveOnCompleted is configured', async () => {
    issues = { backend: [node({ id: '42', title: 'Investigate me' })] };
    await boot(true);

    const res = await mcpClient.callTool({ name: 'sync_sentry', arguments: {} });
    const taskId = (res.structuredContent as { created: string[] }).created[0]!;
    server.taskStore.update(taskId, { status: 'in_progress' });
    server.taskStore.update(taskId, { status: 'completed' });
    await flush();
    await flush();

    expect(fc.noteCalls).toHaveLength(1);
    expect(fc.resolveCalls).toEqual(['42']);
  });

  it('exposes the sentry_error trigger source — a new error group fires an enriched claim', async () => {
    issues = { backend: [node({ id: '1', title: 'Old error' })] };
    await boot();
    expect(server.automationTriggerEngine).toBeDefined();

    const a = server.automationStore.create({
      name: 'sentry-triage',
      prompt: 'Investigate the new error.',
      triggerType: 'sentry_error',
    });

    // First poll seeds the pre-existing error (does NOT fire).
    expect(await server.automationTriggerEngine!.executeTriggerPoll()).toEqual([]);
    expect(server.automationStore.listPending()).toHaveLength(0);

    // A brand-new error group appears → fires.
    issues.backend = [node({ id: '2', title: 'NEW crash', level: 'fatal' }), node({ id: '1', title: 'Old error' })];
    const claimed = await server.automationTriggerEngine!.executeTriggerPoll();
    expect(claimed).toHaveLength(1);

    // The launcher PULLS the claimed run; it carries the firing event's JSON.
    const pending = await rpc.call.automations.takePending();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.runLogId).toBe(claimed[0]);
    const event = JSON.parse(pending[0]!.triggerEvent!) as { id: string; title: string; type: string };
    expect(event).toMatchObject({ id: 'sentry:backend#2', title: 'NEW crash', type: 'Sentry issue' });

    // The injector's formatter enriches the prompt with event context.
    const enriched = formatAutomationPrompt(pending[0]!);
    expect(enriched).toContain('[Automation "sentry-triage" triggered by Sentry issue: "NEW crash"]');
    expect(enriched).toContain('Investigate the new error.');

    // Complete the run → in_flight clears.
    const done = await rpc.call.automations.completeRun({ runLogId: claimed[0]!, status: 'success' });
    expect(done.completed).toBe(true);
    expect(server.automationStore.get(a.id)!.inFlight).toBe(false);
  });

  it('a label filter on the sentry level scopes which errors fire', async () => {
    issues = { backend: [node({ id: '1', level: 'error' })] };
    await boot();

    // Only fatal-level errors should fire.
    server.automationStore.create({
      name: 'fatal-only',
      prompt: 'page someone',
      triggerType: 'sentry_error',
      triggerConfig: JSON.stringify({ labelFilter: ['fatal'] }),
    });
    await server.automationTriggerEngine!.executeTriggerPoll(); // seed

    // A new warning-level error → does NOT fire (level surfaced as label 'error').
    issues.backend = [node({ id: '2', level: 'error' }), node({ id: '1', level: 'error' })];
    expect(await server.automationTriggerEngine!.executeTriggerPoll()).toEqual([]);

    // A new fatal error → fires.
    issues.backend = [node({ id: '3', level: 'fatal' }), node({ id: '2', level: 'error' })];
    const claimed = await server.automationTriggerEngine!.executeTriggerPoll();
    expect(claimed).toHaveLength(1);
    await waitFor(() => server.automationStore.listPending().length === 1);
    const pending = await rpc.call.automations.takePending();
    expect(JSON.parse(pending[0]!.triggerEvent!).id).toBe('sentry:backend#3');
  });
});
