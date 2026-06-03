/**
 * Phase 7B.3 — host enrichment: hide `on_<event>` handler tools from the
 * toolbelt, and enforce a per-tool permission ceiling against the manifest.
 * FAKE client connections (no subprocess). Real-subprocess coverage lives
 * in the 7B.3 integration test.
 */
import path from 'node:path';
import os from 'node:os';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SymphonyDatabase } from '../../src/state/db.js';
import { SqlitePluginStore } from '../../src/plugins/store.js';
import { pluginDir } from '../../src/plugins/paths.js';
import {
  PluginHost,
  checkToolPermissions,
  type PluginToolRegistrar,
} from '../../src/plugins/host.js';
import {
  SYMPHONY_META_EVENT_HANDLER,
  SYMPHONY_META_PERMISSIONS,
} from '../../src/plugins/meta-keys.js';
import {
  SYMPHONY_META_EVENT_HANDLER as SDK_META_EVENT_HANDLER,
  SYMPHONY_META_PERMISSIONS as SDK_META_PERMISSIONS,
} from '../../packages/plugin-sdk/src/plugin.js';
import type {
  PluginClientConnection,
  PluginClientFactory,
  PluginClientOptions,
  PluginToolDescriptor,
} from '../../src/plugins/client.js';
import type { ToolRegistration } from '../../src/orchestrator/registry.js';

let tmpRoot: string;
let home: string;
let db: SymphonyDatabase;
let store: SqlitePluginStore;

interface FakeConn extends PluginClientConnection {
  readonly calls: Array<{ name: string; args: Record<string, unknown> }>;
}

const conns = new Map<string, FakeConn>();
const NOW = '2026-06-03T00:00:00.000Z';
const objSchema = { type: 'object', properties: {} };

function makeFactory(toolsById: Record<string, PluginToolDescriptor[]>): PluginClientFactory {
  return (opts: PluginClientOptions): PluginClientConnection => {
    const calls: FakeConn['calls'] = [];
    const conn: FakeConn = {
      calls,
      async connect() {},
      async listTools() {
        return toolsById[opts.id] ?? [];
      },
      async callTool(name, args) {
        calls.push({ name, args });
        return { content: [{ type: 'text', text: `${opts.id}:${name}` }], isError: false };
      },
      async close() {},
      onClose() {},
    };
    conns.set(opts.id, conn);
    return conn;
  };
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

function writeManifest(id: string, overrides: Record<string, unknown> = {}): void {
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
      ...overrides,
    }),
    'utf8',
  );
}

beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'sym-7b3-'));
  home = path.join(tmpRoot, 'home');
  mkdirSync(home, { recursive: true });
  db = SymphonyDatabase.open({ filePath: ':memory:' });
  store = new SqlitePluginStore(db.db);
  conns.clear();
});

afterEach(() => {
  db.close();
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('7B.3 meta-key drift lock', () => {
  it('host meta-key constants equal the SDK constants', () => {
    expect(SYMPHONY_META_EVENT_HANDLER).toBe(SDK_META_EVENT_HANDLER);
    expect(SYMPHONY_META_PERMISSIONS).toBe(SDK_META_PERMISSIONS);
    expect(SYMPHONY_META_EVENT_HANDLER).toBe('symphony/eventHandler');
    expect(SYMPHONY_META_PERMISSIONS).toBe('symphony/permissions');
  });
});

describe('7B.3 hide event-handler tools', () => {
  it('keeps an eventHandler-marked tool out of the toolbelt but still dispatchable', async () => {
    writeManifest('p', { events: ['onTaskCompleted'] });
    store.upsert({ id: 'p', name: 'p', version: '1', source: 's', enabled: true, now: NOW });
    const { registrar, captured } = capturingRegistrar();
    const factory = makeFactory({
      p: [
        { name: 'notifier_status', inputSchema: objSchema },
        {
          name: 'on_task_completed',
          inputSchema: objSchema,
          meta: { [SYMPHONY_META_EVENT_HANDLER]: true },
        },
      ],
    });
    const host = new PluginHost({ store, registry: registrar, home, clientFactory: factory, logger: () => {} });
    const report = await host.start();

    // Only the non-handler tool is registered as a proxy.
    expect(captured.map((r) => r.name)).toEqual(['p__notifier_status']);
    expect(report.registeredToolCount).toBe(1);
    // ...but the hidden handler is still reachable via event dispatch.
    host.dispatchEvent('onTaskCompleted', { taskId: 't1', projectId: 'pr', status: 'completed' });
    await new Promise((r) => setImmediate(r));
    expect(conns.get('p')?.calls).toEqual([
      { name: 'on_task_completed', args: { taskId: 't1', projectId: 'pr', status: 'completed' } },
    ]);
  });

  it('hide-check wins over permission-check: a handler tool that also declares perms is hidden, not refused', async () => {
    // The handler is marked eventHandler AND carries an over-permissioned
    // perms list. The hide-check runs first (continue), so it is kept out of
    // the toolbelt as a handler — it must NOT be treated as a refused tool,
    // and must stay dispatchable.
    writeManifest('p', { permissions: ['task:read'], events: ['onTaskCompleted'] });
    store.upsert({ id: 'p', name: 'p', version: '1', source: 's', enabled: true, now: NOW });
    const { registrar, captured } = capturingRegistrar();
    const factory = makeFactory({
      p: [
        {
          name: 'on_task_completed',
          inputSchema: objSchema,
          meta: { [SYMPHONY_META_EVENT_HANDLER]: true, [SYMPHONY_META_PERMISSIONS]: ['task:write'] },
        },
      ],
    });
    const host = new PluginHost({ store, registry: registrar, home, clientFactory: factory, logger: () => {} });
    await host.start();
    expect(captured).toEqual([]); // hidden (not registered), not a permission refusal
    host.dispatchEvent('onTaskCompleted', { taskId: 't1', projectId: 'pr', status: 'completed' });
    await new Promise((r) => setImmediate(r));
    expect(conns.get('p')?.calls).toEqual([
      { name: 'on_task_completed', args: { taskId: 't1', projectId: 'pr', status: 'completed' } },
    ]);
  });
});

describe('7B.3 per-tool permission enforcement', () => {
  it('registers a tool whose permissions are a subset of the manifest grant', async () => {
    writeManifest('p', { permissions: ['task:read', 'notify:send'] });
    store.upsert({ id: 'p', name: 'p', version: '1', source: 's', enabled: true, now: NOW });
    const { registrar, captured } = capturingRegistrar();
    const factory = makeFactory({
      p: [{ name: 'reader', inputSchema: objSchema, meta: { [SYMPHONY_META_PERMISSIONS]: ['task:read'] } }],
    });
    const host = new PluginHost({ store, registry: registrar, home, clientFactory: factory, logger: () => {} });
    const report = await host.start();
    expect(captured.map((r) => r.name)).toEqual(['p__reader']);
    expect(report.registeredToolCount).toBe(1);
  });

  it('refuses just the over-permissioned tool; sibling valid tools still register', async () => {
    writeManifest('p', { permissions: ['task:read'] });
    store.upsert({ id: 'p', name: 'p', version: '1', source: 's', enabled: true, now: NOW });
    const { registrar, captured } = capturingRegistrar();
    const logs: string[] = [];
    const factory = makeFactory({
      p: [
        { name: 'reader', inputSchema: objSchema, meta: { [SYMPHONY_META_PERMISSIONS]: ['task:read'] } },
        { name: 'writer', inputSchema: objSchema, meta: { [SYMPHONY_META_PERMISSIONS]: ['task:write'] } },
        { name: 'plain', inputSchema: objSchema },
      ],
    });
    const host = new PluginHost({
      store,
      registry: registrar,
      home,
      clientFactory: factory,
      logger: (l) => logs.push(l),
    });
    const report = await host.start();
    // writer is refused; reader + plain survive (per-tool isolation).
    expect(captured.map((r) => r.name).sort()).toEqual(['p__plain', 'p__reader']);
    expect(report.registeredToolCount).toBe(2);
    expect(logs.some((l) => l.includes("tool 'writer' refused") && l.includes('task:write'))).toBe(true);
  });

  it('refuses a tool with a malformed permissions meta (fail-closed)', async () => {
    writeManifest('p', { permissions: ['task:read'] });
    store.upsert({ id: 'p', name: 'p', version: '1', source: 's', enabled: true, now: NOW });
    const { registrar, captured } = capturingRegistrar();
    const factory = makeFactory({
      p: [
        // string, not string[] — malformed.
        { name: 'bad', inputSchema: objSchema, meta: { [SYMPHONY_META_PERMISSIONS]: 'task:read' } },
      ],
    });
    const host = new PluginHost({ store, registry: registrar, home, clientFactory: factory, logger: () => {} });
    const report = await host.start();
    expect(captured).toEqual([]);
    expect(report.registeredToolCount).toBe(0);
  });
});

describe('7B.3 checkToolPermissions (pure)', () => {
  const granted = new Set(['task:read', 'net:api.notion.com']);
  it('ok when no permissions declared', () => {
    expect(checkToolPermissions(granted, { name: 't', inputSchema: {} }).ok).toBe(true);
  });
  it('ok when a subset', () => {
    expect(
      checkToolPermissions(granted, {
        name: 't',
        inputSchema: {},
        meta: { [SYMPHONY_META_PERMISSIONS]: ['task:read'] },
      }).ok,
    ).toBe(true);
  });
  it('refuses a superset, naming the missing permission', () => {
    const r = checkToolPermissions(granted, {
      name: 't',
      inputSchema: {},
      meta: { [SYMPHONY_META_PERMISSIONS]: ['task:read', 'task:write'] },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("'task:write'");
  });
  it('refuses malformed metadata', () => {
    const r = checkToolPermissions(granted, {
      name: 't',
      inputSchema: {},
      meta: { [SYMPHONY_META_PERMISSIONS]: [1, 2] as unknown as string[] },
    });
    expect(r.ok).toBe(false);
  });
  it('exact-match only — a net wildcard grant does NOT cover a specific host (documented conservative default)', () => {
    const r = checkToolPermissions(new Set(['net:*.notion.com']), {
      name: 't',
      inputSchema: {},
      meta: { [SYMPHONY_META_PERMISSIONS]: ['net:api.notion.com'] },
    });
    expect(r.ok).toBe(false);
  });
});
