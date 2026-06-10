/**
 * Phase 9A — REAL plugin subprocess integration for an issue-source plugin.
 *
 * Spawns the `github-source` fixture via the production StdioClientTransport
 * and drives the full bridge end-to-end against a genuine child process +
 * real in-memory stores:
 *   - the host hides the issue-source internal tools (`fetch_open_issues` /
 *     `write_back_status`) and registers `sync_github` (host-built) plus the
 *     plain `github-source__get_writeback_log` proxy
 *   - calling `sync_github` fetches via the subprocess, drops the malformed
 *     issue, skips the terminal one, and creates a task + external link for
 *     the open issue
 *   - completing that task fans a terminal-status writeback out to the
 *     plugin's `write_back_status` tool (observed via get_writeback_log)
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SymphonyDatabase } from '../../src/state/db.js';
import { SqlitePluginStore } from '../../src/plugins/store.js';
import { PluginHost, type PluginToolRegistrar } from '../../src/plugins/host.js';
import { SYMPHONY_PLUGINS_DIR_ENV } from '../../src/plugins/paths.js';
import { ProjectRegistry } from '../../src/projects/registry.js';
import { TaskRegistry } from '../../src/state/task-registry.js';
import { MemoryExternalLinkStore } from '../../src/state/external-link-store.js';
import type { ToolRegistration } from '../../src/orchestrator/registry.js';
import type { DispatchContext } from '../../src/orchestrator/types.js';
import type { TaskSnapshot } from '../../src/state/types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PLUGINS_ROOT = path.join(here, '..', 'fixtures', 'plugins');

let db: SymphonyDatabase;
let store: SqlitePluginStore;
let host: PluginHost | undefined;
let prevEnv: string | undefined;

// Real in-memory stores + the writeback fan-out (mirrors server.ts).
let projects: ProjectRegistry;
let tasks: TaskRegistry;
let links: MemoryExternalLinkStore;
let writebackRefs: Array<(snap: TaskSnapshot) => void>;

beforeEach(() => {
  prevEnv = process.env[SYMPHONY_PLUGINS_DIR_ENV];
  process.env[SYMPHONY_PLUGINS_DIR_ENV] = PLUGINS_ROOT;
  db = SymphonyDatabase.open({ filePath: ':memory:' });
  store = new SqlitePluginStore(db.db);
  store.upsert({
    id: 'github-source',
    name: 'GitHub source fixture',
    version: '1.0.0',
    source: PLUGINS_ROOT,
    enabled: true,
    now: '2026-06-09T00:00:00.000Z',
  });

  projects = new ProjectRegistry();
  projects.register({ id: 'proj', name: 'acme/widgets', path: '/tmp/acme-widgets', createdAt: '' });
  links = new MemoryExternalLinkStore();
  writebackRefs = [];
  tasks = new TaskRegistry({
    projectStore: projects,
    onTaskStatusChange: (snap) => {
      for (const ref of writebackRefs) ref(snap);
    },
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

describe('9A real plugin subprocess — issue-source bridge', () => {
  it('hides internal tools, registers sync_github + writeback, and round-trips a task', async () => {
    const captured: Array<ToolRegistration<Record<string, never>>> = [];
    const registrar: PluginToolRegistrar = {
      register(reg) {
        captured.push(reg as ToolRegistration<Record<string, never>>);
        return {};
      },
    };

    host = new PluginHost({
      store,
      registry: registrar,
      logger: () => {},
      issueSource: {
        taskStore: tasks,
        projectStore: projects,
        externalLinkStore: links,
        registerWritebackRef: (ref) => writebackRefs.push(ref),
      },
    });
    const report = await host.start();
    expect(report.loaded).toEqual(['github-source']);

    // Internal tools hidden; sync_github (host-built) + the plain proxy registered.
    const names = captured.map((r) => r.name).sort();
    expect(names).toEqual(['github-source__get_writeback_log', 'sync_github']);
    expect(names).not.toContain('github-source__fetch_open_issues');
    expect(names).not.toContain('github-source__write_back_status');
    // One writeback ref pushed for the issue source.
    expect(writebackRefs).toHaveLength(1);

    // sync_github fetches via the subprocess and ingests.
    const sync = captured.find((r) => r.name === 'sync_github');
    const syncRes = await sync!.handler({}, ctx());
    const sc = syncRes.structuredContent as { createdCount: number; created: string[]; skippedDone: number };
    // Open issue → 1 task; terminal issue skipped; malformed issue dropped by the adapter.
    expect(sc.createdCount).toBe(1);
    expect(sc.skippedDone).toBe(1);
    const taskId = sc.created[0]!;
    expect(links.getByExternal('github', 'acme/widgets#1')?.taskId).toBe(taskId);
    expect(tasks.get(taskId)?.projectId).toBe('proj');

    // Complete the task → terminal transition fans writeback to the plugin.
    tasks.update(taskId, { status: 'in_progress' });
    tasks.update(taskId, { status: 'completed' });
    await new Promise((r) => setTimeout(r, 400)); // writeback is fire-and-forget

    const logTool = captured.find((r) => r.name === 'github-source__get_writeback_log');
    const logRes = await logTool!.handler({}, ctx());
    const calls = (logRes.structuredContent as { calls: Array<{ externalId: string; status: string }> }).calls;
    expect(calls).toEqual([{ externalId: 'acme/widgets#1', status: 'completed' }]);
  }, 30_000);
});
