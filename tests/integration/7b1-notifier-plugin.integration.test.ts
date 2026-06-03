/**
 * Phase 7B.1 — REAL subprocess integration for the SDK-built notifier
 * example. Builds → installs → boots the example as a genuine MCP stdio
 * subprocess through the PluginHost and exercises:
 *   - tool discovery → namespaced proxy (`notifier-example__notifier_status`)
 *   - event delivery (onTaskCompleted → the SDK's on_task_completed handler)
 *     observed via the plugin's own in-memory state through the tool
 *
 * Proves the SDK's serve()/event wiring works end-to-end against the real
 * host — the same rigor as 7A's echo-fixture integration, but the server is
 * authored with `@symphony/plugin-sdk` rather than hand-rolled.
 *
 * Requires `pnpm build:packages` first (the example bundles the SDK + MCP
 * SDK into a single dist/index.js). Skips with a warning if absent.
 */
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync, mkdirSync, copyFileSync, existsSync, writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SymphonyDatabase } from '../../src/state/db.js';
import { SqlitePluginStore } from '../../src/plugins/store.js';
import { PluginHost, type PluginToolRegistrar } from '../../src/plugins/host.js';
import type { ToolRegistration } from '../../src/orchestrator/registry.js';
import { SYMPHONY_PLUGINS_DIR_ENV } from '../../src/plugins/paths.js';
import type { DispatchContext } from '../../src/orchestrator/types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const EXAMPLE_DIR = path.resolve(here, '..', '..', 'packages', 'examples', 'notifier');
const EXAMPLE_DIST = path.join(EXAMPLE_DIR, 'dist', 'index.js');
const EXAMPLE_MANIFEST = path.join(EXAMPLE_DIR, 'plugin.json');
const BUILT = existsSync(EXAMPLE_DIST);

let tmpRoot: string;
let db: SymphonyDatabase;
let store: SqlitePluginStore;
let host: PluginHost | undefined;
let prevEnv: string | undefined;

beforeEach(() => {
  prevEnv = process.env[SYMPHONY_PLUGINS_DIR_ENV];
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'sym-7b1-root-'));
  process.env[SYMPHONY_PLUGINS_DIR_ENV] = tmpRoot;

  if (BUILT) {
    // Stage exactly what would ship (plugin.json + dist), keyed by id.
    const pluginInstallDir = path.join(tmpRoot, 'notifier-example');
    mkdirSync(path.join(pluginInstallDir, 'dist'), { recursive: true });
    copyFileSync(EXAMPLE_MANIFEST, path.join(pluginInstallDir, 'plugin.json'));
    copyFileSync(EXAMPLE_DIST, path.join(pluginInstallDir, 'dist', 'index.js'));
    // index.js.map is optional; copy if present so source maps resolve.
    if (existsSync(`${EXAMPLE_DIST}.map`)) {
      copyFileSync(`${EXAMPLE_DIST}.map`, path.join(pluginInstallDir, 'dist', 'index.js.map'));
    }
    // A scratch log target so the notifier's appendFile never collides
    // with a real user file (the env var won't reach the subprocess —
    // strict allowlist — so this is belt-and-suspenders only).
    writeFileSync(path.join(tmpRoot, 'notifier.log'), '', 'utf8');
  }

  db = SymphonyDatabase.open({ filePath: ':memory:' });
  store = new SqlitePluginStore(db.db);
  store.upsert({
    id: 'notifier-example',
    name: 'Notifier (example)',
    version: '0.1.0',
    source: tmpRoot,
    enabled: true,
    now: '2026-06-03T00:00:00.000Z',
  });
});

afterEach(async () => {
  if (host !== undefined) await host.shutdown();
  host = undefined;
  db.close();
  rmSync(tmpRoot, { recursive: true, force: true });
  if (prevEnv === undefined) delete process.env[SYMPHONY_PLUGINS_DIR_ENV];
  else process.env[SYMPHONY_PLUGINS_DIR_ENV] = prevEnv;
});

function ctx(): DispatchContext {
  return { mode: 'act', tier: 2, awayMode: false, automationContext: false };
}

describe('7B.1 SDK-built notifier — real subprocess', () => {
  it.skipIf(!BUILT)(
    'discovers the tool, delivers an event, and reflects it via the tool',
    async () => {
      const captured: Array<ToolRegistration<Record<string, never>>> = [];
      const registrar: PluginToolRegistrar = {
        register(reg) {
          captured.push(reg as ToolRegistration<Record<string, never>>);
          return {};
        },
      };

      host = new PluginHost({ store, registry: registrar, logger: () => {} });
      const report = await host.start();
      expect(report.loaded).toEqual(['notifier-example']);

      const names = captured.map((r) => r.name).sort();
      // In 7B.1 the event-handler proxy is still registered (hiding is 7B.3).
      expect(names).toContain('notifier-example__notifier_status');
      expect(names).toContain('notifier-example__on_task_completed');

      const status = captured.find((r) => r.name === 'notifier-example__notifier_status');
      expect(status).toBeDefined();

      const before = await status!.handler({} as never, ctx());
      expect((before.structuredContent as { count?: number } | undefined)?.count).toBe(0);

      // Fire two task events through the real subprocess.
      host.dispatchEvent('onTaskCompleted', { taskId: 't1', projectId: 'p1', status: 'completed' });
      host.dispatchEvent('onTaskFailed', { taskId: 't2', projectId: null, status: 'failed' });
      await new Promise((r) => setTimeout(r, 300));

      const after = await status!.handler({} as never, ctx());
      const sc = after.structuredContent as
        | { count?: number; notifications?: Array<{ taskId: string; kind: string }> }
        | undefined;
      expect(sc?.count).toBe(2);
      expect(sc?.notifications?.map((n) => `${n.kind}:${n.taskId}`)).toEqual([
        'completed:t1',
        'failed:t2',
      ]);
    },
    30_000,
  );

  it.skipIf(BUILT)('skips when the example is not built', () => {
    console.warn(
      '[7b1] notifier example not built — run `pnpm build:packages` to run the real-subprocess integration test.',
    );
    expect(BUILT).toBe(false);
  });
});
