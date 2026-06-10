/**
 * Phase 9B — host-side issue-source POLLING. When an issue-source plugin
 * declares `provides.issueSource.pollIntervalMs`, the host schedules a loop
 * that pulls `fetch_open_issues` and ingests the result (replacing a
 * push-source watcher a sandboxed plugin can't run). FAKE client connections
 * (no subprocess); a small interval drives real timers. Real-subprocess
 * coverage lives in the 9B integration test.
 */
import path from 'node:path';
import os from 'node:os';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SymphonyDatabase } from '../../src/state/db.js';
import { SqlitePluginStore } from '../../src/plugins/store.js';
import { pluginDir } from '../../src/plugins/paths.js';
import { PluginHost, type PluginToolRegistrar } from '../../src/plugins/host.js';
import { ProjectRegistry } from '../../src/projects/registry.js';
import { TaskRegistry } from '../../src/state/task-registry.js';
import { MemoryExternalLinkStore } from '../../src/state/external-link-store.js';
import type {
  PluginClientConnection,
  PluginClientFactory,
  PluginClientOptions,
  PluginToolDescriptor,
} from '../../src/plugins/client.js';
import type { ToolRegistration } from '../../src/orchestrator/registry.js';
import type { TaskSnapshot } from '../../src/state/types.js';

let tmpRoot: string;
let home: string;
let db: SymphonyDatabase;
let store: SqlitePluginStore;
let host: PluginHost | undefined;

let projects: ProjectRegistry;
let tasks: TaskRegistry;
let links: MemoryExternalLinkStore;
let writebackRefs: Array<(snap: TaskSnapshot) => void>;

const NOW = '2026-06-09T00:00:00.000Z';

const ISSUE_DESCRIPTORS: PluginToolDescriptor[] = [
  { name: 'fetch_open_issues', description: 'f', inputSchema: { type: 'object', properties: {} } },
  { name: 'write_back_status', description: 'w', inputSchema: { type: 'object', properties: {} } },
];

const FETCH_RESULT = {
  issues: [
    {
      externalId: 'notes/a.md#h:open1',
      title: 'A polled task',
      url: null,
      state: ' ',
      isTerminal: false,
      body: null,
      assignee: null,
      labels: [],
      projectValue: 'acme/widgets',
      priority: 0,
      updatedAt: null,
    },
    {
      externalId: 'notes/a.md#h:done1',
      title: 'Done already',
      url: null,
      state: 'x',
      isTerminal: true,
      body: null,
      assignee: null,
      labels: [],
      projectValue: 'acme/widgets',
      priority: 0,
      updatedAt: null,
    },
  ],
};

interface FakeConn extends PluginClientConnection {
  readonly calls: Array<{ name: string; args: Record<string, unknown> }>;
}
const conns = new Map<string, FakeConn>();

function makeFactory(): PluginClientFactory {
  return (opts: PluginClientOptions): PluginClientConnection => {
    const calls: FakeConn['calls'] = [];
    const conn: FakeConn = {
      calls,
      async connect() {},
      async listTools() {
        return ISSUE_DESCRIPTORS;
      },
      async callTool(name, args) {
        calls.push({ name, args });
        if (name === 'fetch_open_issues') {
          return { content: [{ type: 'text', text: 'ok' }], structuredContent: FETCH_RESULT, isError: false };
        }
        return { content: [{ type: 'text', text: 'ok' }], isError: false };
      },
      async close() {},
      onClose() {},
    };
    conns.set(opts.id, conn);
    return conn;
  };
}

function writeManifest(id: string, pollIntervalMs?: number): void {
  const dir = pluginDir(id, home);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, 'plugin.json'),
    JSON.stringify({
      schemaVersion: 1,
      id,
      name: id,
      version: '1.0.0',
      author: 'me',
      description: 'd',
      entrypoint: { command: 'node', args: ['server.js'] },
      toolScope: 'both',
      capabilityFlags: ['external-visible'],
      provides: {
        issueSource: { source: 'obsidian', ...(pollIntervalMs !== undefined ? { pollIntervalMs } : {}) },
      },
    }),
    'utf8',
  );
}

function makeHost(id: string, issueSourcePollIntervalMs?: number): PluginHost {
  return new PluginHost({
    store,
    registry: capturingRegistrar().registrar,
    home,
    clientFactory: makeFactory(),
    logger: () => {},
    issueSource: {
      taskStore: tasks,
      projectStore: projects,
      externalLinkStore: links,
      registerWritebackRef: (ref) => writebackRefs.push(ref),
    },
    ...(issueSourcePollIntervalMs !== undefined ? { issueSourcePollIntervalMs } : {}),
  });
}

function capturingRegistrar(): {
  registrar: PluginToolRegistrar;
  captured: Array<ToolRegistration<Record<string, never>>>;
} {
  const captured: Array<ToolRegistration<Record<string, never>>> = [];
  const registrar: PluginToolRegistrar = {
    register(reg) {
      captured.push(reg as ToolRegistration<Record<string, never>>);
      return {};
    },
  };
  return { registrar, captured };
}

beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'sym-9b-poll-'));
  home = path.join(tmpRoot, 'home');
  mkdirSync(home, { recursive: true });
  db = SymphonyDatabase.open({ filePath: ':memory:' });
  store = new SqlitePluginStore(db.db);
  conns.clear();

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
  rmSync(tmpRoot, { recursive: true, force: true });
});

const settle = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('9B host-side issue-source polling', () => {
  it('schedules a poll loop that ingests fetched issues (no explicit sync)', async () => {
    writeManifest('obsidian-source', 30000); // manifest value; overridden below
    store.upsert({ id: 'obsidian-source', name: 'o', version: '1', source: 's', enabled: true, now: NOW });
    host = makeHost('obsidian-source', 40); // fast override
    await host.start();

    // No sync called — wait for the poll to fire and ingest.
    await settle(150);
    const conn = conns.get('obsidian-source')!;
    expect(conn.calls.some((c) => c.name === 'fetch_open_issues')).toBe(true);

    // The open issue was ingested; the terminal one skipped.
    const created = tasks.list().filter((t) => t.description === 'A polled task');
    expect(created).toHaveLength(1);
    expect(links.getByExternal('obsidian', 'notes/a.md#h:open1')?.taskId).toBe(created[0]!.id);
    expect(links.getByExternal('obsidian', 'notes/a.md#h:done1')).toBeUndefined();
  }, 15_000);

  it('repeated polls are idempotent (dedup via the link table)', async () => {
    writeManifest('obsidian-source');
    store.upsert({ id: 'obsidian-source', name: 'o', version: '1', source: 's', enabled: true, now: NOW });
    host = makeHost('obsidian-source', 40);
    await host.start();
    await settle(200); // several poll ticks

    const created = tasks.list().filter((t) => t.description === 'A polled task');
    expect(created).toHaveLength(1); // not one-per-tick
  }, 15_000);

  it('stops polling after shutdown', async () => {
    writeManifest('obsidian-source');
    store.upsert({ id: 'obsidian-source', name: 'o', version: '1', source: 's', enabled: true, now: NOW });
    host = makeHost('obsidian-source', 40);
    await host.start();
    await settle(120);
    const conn = conns.get('obsidian-source')!;

    await host.shutdown();
    host = undefined;
    const countAtShutdown = conn.calls.filter((c) => c.name === 'fetch_open_issues').length;
    expect(countAtShutdown).toBeGreaterThan(0);

    await settle(150);
    const countLater = conn.calls.filter((c) => c.name === 'fetch_open_issues').length;
    expect(countLater).toBe(countAtShutdown); // no ticks after shutdown
  }, 15_000);

  it('does NOT schedule a poll when the manifest omits pollIntervalMs (pull-only)', async () => {
    writeManifest('notion-like'); // no pollIntervalMs
    store.upsert({ id: 'notion-like', name: 'n', version: '1', source: 's', enabled: true, now: NOW });
    // No override → pull-only.
    host = makeHost('notion-like');
    await host.start();
    await settle(150);
    const conn = conns.get('notion-like')!;
    expect(conn.calls.some((c) => c.name === 'fetch_open_issues')).toBe(false);
    expect(tasks.list()).toHaveLength(0);
  }, 15_000);
});
