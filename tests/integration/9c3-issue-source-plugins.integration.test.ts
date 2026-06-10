/**
 * Phase 9C.3 — REAL plugin subprocess integration for the Plain + Sentry
 * issue-source plugins.
 *
 * Uses build-free `.mjs` fixtures (canned data + a get_writeback_log observer)
 * driven through the production StdioClientTransport — the real port (GraphQL /
 * REST I/O) is unit-tested directly against the example packages. Here we prove
 * the bridge end-to-end:
 *   - the host hides the issue-source internal tools and registers
 *     `sync_plain` / `sync_sentry` (host-built) + the plain
 *     `<id>__get_writeback_log` proxy
 *   - `sync_<source>` fetches via the subprocess, drops the malformed issue,
 *     skips the terminal one, creates a task + external link
 *   - completing the task fans terminal-status writeback to the plugin
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

let projects: ProjectRegistry;
let tasks: TaskRegistry;
let links: MemoryExternalLinkStore;
let writebackRefs: Array<(snap: TaskSnapshot) => void>;

const NOW = '2026-06-10T00:00:00.000Z';

beforeEach(() => {
  prevEnv = process.env[SYMPHONY_PLUGINS_DIR_ENV];
  process.env[SYMPHONY_PLUGINS_DIR_ENV] = PLUGINS_ROOT;
  db = SymphonyDatabase.open({ filePath: ':memory:' });
  store = new SqlitePluginStore(db.db);

  projects = new ProjectRegistry();
  // The fixtures' open issue routes to project `ENG` via NormalizedIssue.projectValue.
  projects.register({ id: 'proj', name: 'ENG', path: '/tmp/eng', createdAt: '' });
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

function enable(id: string): void {
  store.upsert({ id, name: id, version: '1.0.0', source: PLUGINS_ROOT, enabled: true, now: NOW });
}

function capturingHost(): {
  host: PluginHost;
  captured: Array<ToolRegistration<Record<string, never>>>;
} {
  const captured: Array<ToolRegistration<Record<string, never>>> = [];
  const registrar: PluginToolRegistrar = {
    register(reg) {
      captured.push(reg as ToolRegistration<Record<string, never>>);
      return {};
    },
  };
  const h = new PluginHost({
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
  return { host: h, captured };
}

function ctx(): DispatchContext {
  return { mode: 'act', tier: 2, awayMode: false, automationContext: false };
}

const settle = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('9C.3 real plugin subprocess — plain + sentry issue-source bridge', () => {
  it.each([
    { id: 'plain-source', source: 'plain', externalId: 'th-1' },
    { id: 'sentry-source', source: 'sentry', externalId: 'backend#1' },
  ])('$source: hides internals, registers sync_$source + writeback, round-trips a task', async ({
    id,
    source,
    externalId,
  }) => {
    enable(id);
    const { host: h, captured } = capturingHost();
    host = h;
    const report = await h.start();
    expect(report.loaded).toEqual([id]);

    const names = captured.map((r) => r.name).sort();
    expect(names).toEqual([`${id}__get_writeback_log`, `sync_${source}`]);
    expect(names).not.toContain(`${id}__fetch_open_issues`);
    expect(names).not.toContain(`${id}__write_back_status`);
    expect(writebackRefs).toHaveLength(1);

    const sync = captured.find((r) => r.name === `sync_${source}`)!;
    const syncRes = await sync.handler({}, ctx());
    const sc = syncRes.structuredContent as { createdCount: number; created: string[]; skippedDone: number };
    expect(sc.createdCount).toBe(1);
    expect(sc.skippedDone).toBe(1);
    const taskId = sc.created[0]!;
    expect(links.getByExternal(source, externalId)?.taskId).toBe(taskId);

    tasks.update(taskId, { status: 'in_progress' });
    tasks.update(taskId, { status: 'completed' });
    await settle(400); // writeback is fire-and-forget

    const logTool = captured.find((r) => r.name === `${id}__get_writeback_log`)!;
    const logRes = await logTool.handler({}, ctx());
    const calls = (logRes.structuredContent as { calls: Array<{ externalId: string; status: string }> }).calls;
    expect(calls).toEqual([{ externalId, status: 'completed' }]);
  }, 30_000);
});
