/**
 * Phase 7B.3 — REAL plugin subprocess integration for host enrichment.
 * Spawns the `enrich` fixture (`tests/fixtures/plugins/enrich/server.mjs`)
 * via the production StdioClientTransport and verifies, end to end against a
 * genuine child process speaking real MCP:
 *   - `on_<event>` handler tools (marked `symphony/eventHandler`) are kept
 *     OUT of the registered toolbelt but STILL receive dispatched events
 *   - a tool whose `symphony/permissions` are a subset of the manifest
 *     grant IS registered
 *   - a tool whose permissions exceed the grant is REFUSED (fail-closed)
 *   - the new 7B.3 events (onTaskCreated + onWorkerSpawned) are delivered
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SymphonyDatabase } from '../../src/state/db.js';
import { SqlitePluginStore } from '../../src/plugins/store.js';
import { PluginHost, type PluginToolRegistrar } from '../../src/plugins/host.js';
import type { ToolRegistration } from '../../src/orchestrator/registry.js';
import { SYMPHONY_PLUGINS_DIR_ENV } from '../../src/plugins/paths.js';
import type { DispatchContext } from '../../src/orchestrator/types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PLUGINS_ROOT = path.join(here, '..', 'fixtures', 'plugins');

let db: SymphonyDatabase;
let store: SqlitePluginStore;
let host: PluginHost | undefined;
let prevEnv: string | undefined;

beforeEach(() => {
  prevEnv = process.env[SYMPHONY_PLUGINS_DIR_ENV];
  process.env[SYMPHONY_PLUGINS_DIR_ENV] = PLUGINS_ROOT;
  db = SymphonyDatabase.open({ filePath: ':memory:' });
  store = new SqlitePluginStore(db.db);
  store.upsert({
    id: 'enrich',
    name: 'Enrich',
    version: '1.0.0',
    source: PLUGINS_ROOT,
    enabled: true,
    now: '2026-06-03T00:00:00.000Z',
  });
});

afterEach(async () => {
  if (host !== undefined) await host.shutdown();
  host = undefined;
  db.close();
  if (prevEnv === undefined) delete process.env[SYMPHONY_PLUGINS_DIR_ENV];
  else process.env[SYMPHONY_PLUGINS_DIR_ENV] = prevEnv;
});

function ctx(): DispatchContext {
  return { mode: 'act', tier: 2, awayMode: false, automationContext: false };
}

describe('7B.3 real plugin subprocess — host enrichment', () => {
  it('hides handlers, refuses over-permissioned tools, delivers create/spawn events', async () => {
    const captured: Array<ToolRegistration<Record<string, never>>> = [];
    const registrar: PluginToolRegistrar = {
      register(reg) {
        captured.push(reg as ToolRegistration<Record<string, never>>);
        return {};
      },
    };

    host = new PluginHost({ store, registry: registrar, logger: () => {} });
    const report = await host.start();

    expect(report.loaded).toEqual(['enrich']);
    // Handlers hidden (on_task_created / on_worker_spawned), over_reach
    // refused — only the granted + plain tools are registered.
    expect(captured.map((r) => r.name).sort()).toEqual([
      'enrich__get_event_count',
      'enrich__safe_read',
    ]);
    expect(report.registeredToolCount).toBe(2);

    // Baseline: no events yet.
    const counter = captured.find((r) => r.name === 'enrich__get_event_count');
    expect((await counter!.handler({}, ctx())).structuredContent).toEqual({ count: 0 });

    // The hidden handlers still receive dispatched events.
    host.dispatchEvent('onTaskCreated', {
      taskId: 't1',
      projectId: 'p1',
      description: 'do thing',
      status: 'pending',
    });
    host.dispatchEvent('onWorkerSpawned', {
      workerId: 'w1',
      role: 'implementer',
      featureIntent: 'do it',
      projectId: 'p1',
      taskId: 't1',
    });
    await new Promise((r) => setTimeout(r, 300));

    expect((await counter!.handler({}, ctx())).structuredContent).toEqual({ count: 2 });
  }, 20_000);
});
