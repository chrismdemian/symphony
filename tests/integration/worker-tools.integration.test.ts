import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  startOrchestratorServer,
  type OrchestratorServerHandle,
} from '../../src/orchestrator/index.js';
import {
  CircularBuffer,
  type WorkerRecord,
} from '../../src/orchestrator/worker-registry.js';
import type { WorkerLifecycleHandle } from '../../src/orchestrator/worker-lifecycle.js';
import type { StreamEvent, Worker } from '../../src/workers/types.js';

class FakeWorker implements Worker {
  readonly id: string;
  sessionId: string | undefined = undefined;
  status: Worker['status'] = 'running';
  followups: string[] = [];
  killed = false;
  private resolveExit!: (info: Worker extends { waitForExit(): Promise<infer T> } ? T : never) => void;
  private readonly exitPromise: Promise<Parameters<typeof this.resolveExit>[0]>;

  constructor(id: string) {
    this.id = id;
    this.exitPromise = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
  }

  readonly events: AsyncIterable<StreamEvent> = (async function* () {
    /* no events for integration */
  })();

  sendFollowup(text: string): void {
    this.followups.push(text);
  }

  endInput(): void {
    /* no-op */
  }

  kill(): void {
    this.killed = true;
    this.status = 'killed';
    this.resolveExit({
      status: 'killed',
      exitCode: null,
      signal: 'SIGTERM',
      durationMs: 0,
    });
  }

  waitForExit(): Promise<Parameters<typeof this.resolveExit>[0]> {
    return this.exitPromise;
  }
}

function makeFakeLifecycle(): {
  lifecycle: WorkerLifecycleHandle;
  spawned: FakeWorker[];
  records: WorkerRecord[];
} {
  const spawned: FakeWorker[] = [];
  const records: WorkerRecord[] = [];
  let idCounter = 0;
  const lifecycle: WorkerLifecycleHandle = {
    spawn: async (input) => {
      idCounter += 1;
      const id = `wk-fake-${idCounter}`;
      const worker = new FakeWorker(id);
      spawned.push(worker);
      // The real lifecycle would register into registry; for this harness,
      // wire the registry directly via the handle returned from start…
      const rec: WorkerRecord = {
        id,
        projectPath: input.projectPath,
        worktreePath: `${input.projectPath}/.symphony/worktrees/${id}`,
        role: input.role,
        featureIntent: input.featureIntent ?? 'integration-fake',
        taskDescription: input.taskDescription,
        autonomyTier: input.autonomyTier ?? 1,
        dependsOn: input.dependsOn ?? [],
        status: 'running',
        createdAt: new Date().toISOString(),
        worker,
        buffer: new CircularBuffer<StreamEvent>(100),
        detach: () => {},
        sessionId: 'fake-session-id',
      };
      records.push(rec);
      return rec;
    },
    resume: async (input) => {
      const rec = records.find((r) => r.id === input.recordId);
      if (!rec) throw new Error('unknown record');
      const worker = new FakeWorker(rec.id);
      spawned.push(worker);
      rec.worker = worker;
      rec.status = 'spawning';
      return rec;
    },
    cleanup: () => {},
    shutdown: async () => {
      for (const w of spawned) {
        if (!w.killed) w.kill();
      }
    },
  };
  return { lifecycle, spawned, records };
}

async function makePair(): Promise<{
  client: Client;
  server: OrchestratorServerHandle;
  fake: ReturnType<typeof makeFakeLifecycle>;
}> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const fake = makeFakeLifecycle();
  const server = await startOrchestratorServer({
    transport: serverTransport,
    initialMode: 'act',
    defaultProjectPath: '/proj',
    workerLifecycle: fake.lifecycle,
  });
  // Hand the stubbed lifecycle the actual registry from the server so
  // spawn_worker's handler, which goes through the server-owned lifecycle,
  // stays wired to server.workerRegistry. The spawn closure above registers
  // INTO its own ephemeral map; we instead register into server.workerRegistry
  // so list/get/kill observations work.
  const origSpawn = fake.lifecycle.spawn;
  fake.lifecycle.spawn = async (input) => {
    const rec = await origSpawn(input);
    server.workerRegistry.register(rec);
    void rec.worker
      .waitForExit()
      .then((info) => server.workerRegistry.markCompleted(rec.id, info))
      .catch(() => {});
    return rec;
  };
  const origResume = fake.lifecycle.resume;
  fake.lifecycle.resume = async (input) => {
    const rec = await origResume(input);
    // ensure registry reflects the new worker handle
    server.workerRegistry.replace(rec.id, {
      worker: rec.worker,
      buffer: rec.buffer,
      detach: rec.detach,
      ...(rec.sessionId !== undefined ? { sessionId: rec.sessionId } : {}),
    });
    return server.workerRegistry.get(rec.id)!;
  };

  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(clientTransport);
  return { client, server, fake };
}

describe('worker-lifecycle tools (integration)', () => {
  let handles: OrchestratorServerHandle[] = [];
  let clients: Client[] = [];

  beforeEach(() => {
    handles = [];
    clients = [];
  });

  afterEach(async () => {
    for (const c of clients) await c.close().catch(() => {});
    for (const h of handles) await h.close().catch(() => {});
  });

  async function connect() {
    const pair = await makePair();
    handles.push(pair.server);
    clients.push(pair.client);
    return pair;
  }

  it('hides worker-lifecycle tools in plan mode and exposes them in act', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const fake = makeFakeLifecycle();
    const server = await startOrchestratorServer({
      transport: serverTransport,
      initialMode: 'plan',
      defaultProjectPath: '/proj',
      workerLifecycle: fake.lifecycle,
    });
    handles.push(server);
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    await client.connect(clientTransport);
    clients.push(client);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).not.toContain('spawn_worker');
    expect(names).not.toContain('list_workers');
    expect(names).toContain('think');
    expect(names).toContain('propose_plan');
  });

  it('lists all 7 worker tools in act mode', async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const n of [
      'spawn_worker',
      'list_workers',
      'get_worker_output',
      'send_to_worker',
      'kill_worker',
      'resume_worker',
      'find_worker',
    ]) {
      expect(names).toContain(n);
    }
  });

  it('spawn_worker → list_workers → kill_worker round-trip', async () => {
    const { client } = await connect();
    const spawnRes = await client.callTool({
      name: 'spawn_worker',
      arguments: {
        task_description: 'Do integration test thing',
        role: 'implementer',
      },
    });
    expect(spawnRes.isError).toBeFalsy();
    const spawned = spawnRes.structuredContent as { id: string };
    expect(spawned.id).toMatch(/^wk-fake-/);

    const listRes = await client.callTool({ name: 'list_workers', arguments: {} });
    const list = listRes.structuredContent as { workers: Array<{ id: string }> };
    expect(list.workers.map((w) => w.id)).toContain(spawned.id);

    const killRes = await client.callTool({
      name: 'kill_worker',
      arguments: { worker_id: spawned.id, reason: 'test-over' },
    });
    expect(killRes.isError).toBeFalsy();

    // After kill, listing shows terminal status
    const listAfter = await client.callTool({ name: 'list_workers', arguments: {} });
    const listAfterContent = listAfter.structuredContent as {
      workers: Array<{ id: string; status: string }>;
    };
    const entry = listAfterContent.workers.find((w) => w.id === spawned.id);
    expect(['killed', 'completed', 'failed', 'timeout']).toContain(entry?.status ?? '');
  });

  it('get_worker_output returns isError for unknown id', async () => {
    const { client } = await connect();
    const res = await client.callTool({
      name: 'get_worker_output',
      arguments: { worker_id: 'nope' },
    });
    expect(res.isError).toBe(true);
  });

  it('send_to_worker forwards the message to the scripted worker', async () => {
    const { client, fake } = await connect();
    const spawn = await client.callTool({
      name: 'spawn_worker',
      arguments: { task_description: 'integration send', role: 'implementer' },
    });
    const s = spawn.structuredContent as { id: string };
    const send = await client.callTool({
      name: 'send_to_worker',
      arguments: { worker_id: s.id, message: 'follow up please' },
    });
    expect(send.isError).toBeFalsy();
    const w = fake.spawned.find((x) => x.id === s.id);
    expect(w?.followups).toEqual(['follow up please']);
  });

  it('find_worker resolves feature intent substring', async () => {
    const { client } = await connect();
    const spawn = await client.callTool({
      name: 'spawn_worker',
      arguments: { task_description: 'integration finder', role: 'implementer' },
    });
    const s = spawn.structuredContent as { id: string; featureIntent: string };
    expect(s.featureIntent).toBe('integration-fake'); // fixed by fake lifecycle
    const find = await client.callTool({
      name: 'find_worker',
      arguments: { description: 'integration' },
    });
    const m = find.structuredContent as { matches: Array<{ id: string }> };
    expect(m.matches.map((r) => r.id)).toContain(s.id);
  });

  it('resume_worker rejects a running worker and accepts a terminal one', async () => {
    const { client, server } = await connect();
    const spawn = await client.callTool({
      name: 'spawn_worker',
      arguments: { task_description: 'integration resume', role: 'implementer' },
    });
    const s = spawn.structuredContent as { id: string };
    const res1 = await client.callTool({
      name: 'resume_worker',
      arguments: { worker_id: s.id, message: 'go again' },
    });
    expect(res1.isError).toBe(true);

    // Force terminal state
    server.workerRegistry.updateStatus(s.id, 'completed');
    const res2 = await client.callTool({
      name: 'resume_worker',
      arguments: { worker_id: s.id, message: 'continue' },
    });
    expect(res2.isError).toBeFalsy();
  });

  it('spawn_worker validates zod schema and returns isError on malformed input', async () => {
    const { client } = await connect();
    const res = await client.callTool({
      name: 'spawn_worker',
      arguments: { role: 'not-a-role', task_description: '' },
    });
    expect(res.isError).toBe(true);
  });
});
