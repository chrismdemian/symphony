/**
 * Phase 7A — PluginHost behavior with FAKE client connections (no real
 * subprocess): loading, proxy registration, event fan-out, crash
 * isolation, shutdown. Real-subprocess coverage lives in the 7A
 * integration test.
 */
import path from 'node:path';
import os from 'node:os';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SymphonyDatabase } from '../../src/state/db.js';
import { SqlitePluginStore } from '../../src/plugins/store.js';
import { pluginDir } from '../../src/plugins/paths.js';
import { PluginHost, type PluginToolRegistrar } from '../../src/plugins/host.js';
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
  closed: boolean;
}

const conns = new Map<string, FakeConn>();
let throwOnStart: Set<string>;
let throwOnListTools: Set<string>;

const NOW = '2026-06-02T00:00:00.000Z';

function makeFactory(toolsById: Record<string, PluginToolDescriptor[]>): PluginClientFactory {
  return (opts: PluginClientOptions): PluginClientConnection => {
    const calls: FakeConn['calls'] = [];
    const conn: FakeConn = {
      calls,
      closed: false,
      async connect() {
        if (throwOnStart.has(opts.id)) throw new Error(`boom-${opts.id}`);
      },
      async listTools() {
        if (throwOnListTools.has(opts.id)) throw new Error(`discover-fail-${opts.id}`);
        return toolsById[opts.id] ?? [];
      },
      async callTool(name, args) {
        calls.push({ name, args });
        return { content: [{ type: 'text', text: `${opts.id}:${name}` }], isError: false };
      },
      async close() {
        conn.closed = true;
      },
      onClose() {
        /* no-op for fakes */
      },
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
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'sym-host-'));
  home = path.join(tmpRoot, 'home');
  mkdirSync(home, { recursive: true });
  db = SymphonyDatabase.open({ filePath: ':memory:' });
  store = new SqlitePluginStore(db.db);
  conns.clear();
  throwOnStart = new Set();
  throwOnListTools = new Set();
});

afterEach(() => {
  db.close();
  rmSync(tmpRoot, { recursive: true, force: true });
});

const objSchema = { type: 'object', properties: {} };

describe('PluginHost.start', () => {
  it('loads enabled plugins and registers namespaced proxy tools', async () => {
    writeManifest('alpha');
    writeManifest('beta');
    store.upsert({ id: 'alpha', name: 'alpha', version: '1', source: 's', enabled: true, now: NOW });
    store.upsert({ id: 'beta', name: 'beta', version: '1', source: 's', enabled: true, now: NOW });
    // A disabled plugin must NOT load.
    writeManifest('gamma');
    store.upsert({ id: 'gamma', name: 'gamma', version: '1', source: 's', enabled: false, now: NOW });

    const { registrar, captured } = capturingRegistrar();
    const factory = makeFactory({
      alpha: [{ name: 'ping', inputSchema: objSchema }],
      beta: [
        { name: 'search', inputSchema: objSchema },
        { name: 'index', inputSchema: objSchema },
      ],
    });
    const host = new PluginHost({ store, registry: registrar, home, clientFactory: factory, logger: () => {} });
    const report = await host.start();

    expect([...report.loaded].sort()).toEqual(['alpha', 'beta']);
    expect(report.failed).toEqual([]);
    expect(report.registeredToolCount).toBe(3);
    expect(captured.map((r) => r.name).sort()).toEqual(['alpha__ping', 'beta__index', 'beta__search']);
    // gamma (disabled) never spawned.
    expect(conns.has('gamma')).toBe(false);
  });

  it('isolates a crashing plugin — others still load', async () => {
    writeManifest('good');
    writeManifest('bad');
    store.upsert({ id: 'good', name: 'good', version: '1', source: 's', enabled: true, now: NOW });
    store.upsert({ id: 'bad', name: 'bad', version: '1', source: 's', enabled: true, now: NOW });
    throwOnStart.add('bad');

    const { registrar } = capturingRegistrar();
    const factory = makeFactory({ good: [{ name: 'ping', inputSchema: objSchema }] });
    const host = new PluginHost({ store, registry: registrar, home, clientFactory: factory, logger: () => {} });
    const report = await host.start();

    expect(report.loaded).toEqual(['good']);
    expect(report.failed.map((f) => f.id)).toEqual(['bad']);
    expect(report.failed[0]?.reason).toContain('boom-bad');
  });

  it('closes the subprocess when tool discovery fails (audit M1 — no leak)', async () => {
    writeManifest('leaky');
    store.upsert({ id: 'leaky', name: 'leaky', version: '1', source: 's', enabled: true, now: NOW });
    throwOnListTools.add('leaky');
    const { registrar } = capturingRegistrar();
    const host = new PluginHost({ store, registry: registrar, home, clientFactory: makeFactory({}), logger: () => {} });
    const report = await host.start();
    expect(report.failed.map((f) => f.id)).toEqual(['leaky']);
    // The client connected (subprocess spawned) then failed listTools —
    // it must be closed so the child doesn't orphan.
    expect(conns.get('leaky')?.closed).toBe(true);
  });

  it('skips a plugin with an api-incompatible manifest', async () => {
    writeManifest('future', { requiresPluginApi: '^9.0.0' });
    store.upsert({ id: 'future', name: 'future', version: '1', source: 's', enabled: true, now: NOW });
    const { registrar } = capturingRegistrar();
    const host = new PluginHost({ store, registry: registrar, home, clientFactory: makeFactory({}), logger: () => {} });
    const report = await host.start();
    expect(report.loaded).toEqual([]);
    expect(report.failed[0]?.id).toBe('future');
  });
});

describe('PluginHost.dispatchEvent', () => {
  it('delivers onTaskCompleted only to a plugin that declared it AND exposes on_task_completed', async () => {
    writeManifest('subbed', { events: ['onTaskCompleted'] });
    writeManifest('unsubbed'); // no events
    store.upsert({ id: 'subbed', name: 's', version: '1', source: 's', enabled: true, now: NOW });
    store.upsert({ id: 'unsubbed', name: 'u', version: '1', source: 's', enabled: true, now: NOW });

    const { registrar } = capturingRegistrar();
    const factory = makeFactory({
      subbed: [{ name: 'on_task_completed', inputSchema: objSchema }],
      unsubbed: [{ name: 'on_task_completed', inputSchema: objSchema }],
    });
    const host = new PluginHost({ store, registry: registrar, home, clientFactory: factory, logger: () => {} });
    await host.start();

    host.dispatchEvent('onTaskCompleted', { taskId: 't1', status: 'completed' });
    await new Promise((r) => setImmediate(r));

    expect(conns.get('subbed')?.calls).toEqual([
      { name: 'on_task_completed', args: { taskId: 't1', status: 'completed' } },
    ]);
    // unsubbed declared no events → not called even though it exposes the tool.
    expect(conns.get('unsubbed')?.calls).toEqual([]);
  });

  it('does not deliver an undelivered event (onVoiceTranscript)', async () => {
    writeManifest('p', { events: ['onVoiceTranscript', 'onTaskCompleted'] });
    store.upsert({ id: 'p', name: 'p', version: '1', source: 's', enabled: true, now: NOW });
    const { registrar } = capturingRegistrar();
    const factory = makeFactory({
      p: [
        { name: 'on_voice_transcript', inputSchema: objSchema },
        { name: 'on_task_completed', inputSchema: objSchema },
      ],
    });
    const host = new PluginHost({ store, registry: registrar, home, clientFactory: factory, logger: () => {} });
    await host.start();

    host.dispatchEvent('onVoiceTranscript', { text: 'hi' });
    await new Promise((r) => setImmediate(r));
    expect(conns.get('p')?.calls).toEqual([]); // onVoiceTranscript not sourced yet
  });

  it('delivers the Phase 7B.3 create/spawn events (onTaskCreated + onWorkerSpawned)', async () => {
    writeManifest('p', { events: ['onTaskCreated', 'onWorkerSpawned'] });
    store.upsert({ id: 'p', name: 'p', version: '1', source: 's', enabled: true, now: NOW });
    const { registrar } = capturingRegistrar();
    const factory = makeFactory({
      p: [
        { name: 'on_task_created', inputSchema: objSchema },
        { name: 'on_worker_spawned', inputSchema: objSchema },
      ],
    });
    const host = new PluginHost({ store, registry: registrar, home, clientFactory: factory, logger: () => {} });
    await host.start();

    host.dispatchEvent('onTaskCreated', { taskId: 't1', projectId: 'pr', description: 'd', status: 'pending' });
    host.dispatchEvent('onWorkerSpawned', {
      workerId: 'w1',
      role: 'implementer',
      featureIntent: 'do it',
      projectId: 'pr',
      taskId: 't1',
    });
    await new Promise((r) => setImmediate(r));
    expect(conns.get('p')?.calls).toEqual([
      { name: 'on_task_created', args: { taskId: 't1', projectId: 'pr', description: 'd', status: 'pending' } },
      {
        name: 'on_worker_spawned',
        args: { workerId: 'w1', role: 'implementer', featureIntent: 'do it', projectId: 'pr', taskId: 't1' },
      },
    ]);
  });
});

describe('PluginHost.shutdown', () => {
  it('closes every loaded client', async () => {
    writeManifest('a');
    writeManifest('b');
    store.upsert({ id: 'a', name: 'a', version: '1', source: 's', enabled: true, now: NOW });
    store.upsert({ id: 'b', name: 'b', version: '1', source: 's', enabled: true, now: NOW });
    const { registrar } = capturingRegistrar();
    const factory = makeFactory({ a: [], b: [] });
    const host = new PluginHost({ store, registry: registrar, home, clientFactory: factory, logger: () => {} });
    await host.start();
    await host.shutdown();
    expect(conns.get('a')?.closed).toBe(true);
    expect(conns.get('b')?.closed).toBe(true);
  });
});
