/**
 * Phase 7A — REAL plugin subprocess integration. Spawns the echo fixture
 * (`tests/fixtures/plugins/echo/server.mjs`) via the production
 * StdioClientTransport, drives it through the PluginHost, and exercises:
 *   - tool discovery → namespaced proxy registration
 *   - a real MCP tool round-trip through the proxy handler
 *   - real event delivery (onTaskCompleted → on_task_completed)
 *   - clean shutdown
 *
 * This is the "real-PTY-equivalent" rigor for a non-TUI phase: a genuine
 * child process speaking real MCP over stdio, not a mock.
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
// repo/tests/fixtures/plugins is the plugins root; the echo plugin dir is
// `<root>/echo` so `pluginDir('echo')` resolves to the fixture in place
// (so `node server.mjs` resolves @modelcontextprotocol/sdk from the repo).
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
    id: 'echo',
    name: 'Echo',
    version: '1.0.0',
    source: PLUGINS_ROOT,
    enabled: true,
    now: '2026-06-02T00:00:00.000Z',
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

describe('7A real plugin subprocess', () => {
  it('discovers tools, round-trips a real MCP call, delivers a real event', async () => {
    const captured: Array<ToolRegistration<Record<string, never>>> = [];
    const registrar: PluginToolRegistrar = {
      register(reg) {
        captured.push(reg as ToolRegistration<Record<string, never>>);
        return {};
      },
    };

    host = new PluginHost({ store, registry: registrar, logger: () => {} });
    const report = await host.start();

    expect(report.loaded).toEqual(['echo']);
    const names = captured.map((r) => r.name).sort();
    expect(names).toEqual(['echo__echo', 'echo__get_event_count', 'echo__on_task_completed', 'echo__ping']);

    // Real round-trip: invoke the proxy handler → real subprocess → result.
    const ping = captured.find((r) => r.name === 'echo__ping');
    expect(ping).toBeDefined();
    const pong = await ping!.handler({}, ctx());
    expect(pong.content[0]?.text).toBe('pong');

    const echo = captured.find((r) => r.name === 'echo__echo');
    const echoed = await echo!.handler({ text: 'hello' } as never, ctx());
    expect(echoed.content[0]?.text).toBe('echo: hello');

    // Event delivery: count starts at 0, dispatch bumps it to 1.
    const counter = captured.find((r) => r.name === 'echo__get_event_count');
    const before = await counter!.handler({}, ctx());
    expect(before.structuredContent).toEqual({ count: 0 });

    host.dispatchEvent('onTaskCompleted', { taskId: 't1', status: 'completed' });
    // Give the fire-and-forget delivery time to round-trip the subprocess.
    await new Promise((r) => setTimeout(r, 200));

    const after = await counter!.handler({}, ctx());
    expect(after.structuredContent).toEqual({ count: 1 });
  }, 20_000);
});
