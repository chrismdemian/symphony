import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ProjectRegistry,
  startOrchestratorServer,
  type OrchestratorServerHandle,
} from '../../src/orchestrator/index.js';
import {
  CircularBuffer,
  WorkerRegistry,
  type WorkerRecord,
} from '../../src/orchestrator/worker-registry.js';
import type {
  SpawnWorkerInput,
  WorkerLifecycleHandle,
} from '../../src/orchestrator/worker-lifecycle.js';
import type { WorkerManager } from '../../src/workers/manager.js';
import type { StreamEvent, Worker } from '../../src/workers/types.js';
import { WorktreeManager } from '../../src/worktree/manager.js';

const execFileAsync = promisify(execFile);

function fakeWorkerManager(): WorkerManager {
  return {
    spawn: async () => {
      throw new Error('no worker spawn expected in 2A.4a scenario');
    },
    list: () => [],
    get: () => undefined,
    shutdown: async () => {},
  } as unknown as WorkerManager;
}

function stubWorker(id: string): Worker {
  return {
    id,
    sessionId: undefined,
    status: 'running',
    events: (async function* () {})(),
    sendFollowup: () => {},
    endInput: () => {},
    kill: () => {},
    waitForExit: async () =>
      ({ status: 'completed', exitCode: 0, signal: null, durationMs: 0 }),
  } as unknown as Worker;
}

/**
 * Fake lifecycle that creates REAL worktrees on disk (so `review_diff`
 * has something to diff) but skips the `claude -p` spawn. Registers a
 * `WorkerRecord` pointing at the real worktree path.
 */
function makeRealWorktreeFakeSpawnLifecycle(args: {
  registry: WorkerRegistry;
  worktreeManager: WorktreeManager;
}): WorkerLifecycleHandle {
  let counter = 0;
  return {
    spawn: async (input: SpawnWorkerInput) => {
      counter += 1;
      const id = `wk-fake-${counter}`;
      const worktree = await args.worktreeManager.create({
        projectPath: input.projectPath,
        workerId: id,
        shortDescription: input.featureIntent ?? 'fake',
      });
      const record: WorkerRecord = {
        id,
        projectPath: input.projectPath,
        projectId: input.projectId ?? null,
        taskId: input.taskId ?? null,
        worktreePath: worktree.path,
        role: input.role,
        featureIntent: input.featureIntent ?? 'fake',
        taskDescription: input.taskDescription,
        autonomyTier: input.autonomyTier ?? 1,
        dependsOn: input.dependsOn ?? [],
        status: 'running',
        createdAt: new Date().toISOString(),
        worker: stubWorker(id),
        buffer: new CircularBuffer<StreamEvent>(10),
        detach: () => {},
      };
      args.registry.register(record);
      return record;
    },
    resume: async () => {
      throw new Error('not used in 2A.4a scenario');
    },
    cleanup: (id: string) => {
      args.registry.remove(id);
    },
    shutdown: async () => {
      args.registry.clear();
    },
    recoverFromStore: () => ({ crashedIds: [] }),
    setOnEvent: () => {},
  };
}

async function git(cwd: string, ...cmdArgs: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', cmdArgs, { cwd });
  return stdout;
}

async function initRepo(repoPath: string): Promise<void> {
  await git(repoPath, 'init', '--initial-branch=main');
  await git(repoPath, 'config', 'user.email', 'test@example.com');
  await git(repoPath, 'config', 'user.name', 'Symphony Scenario 2A.4a');
  await git(repoPath, 'config', 'commit.gpgsign', 'false');
  writeFileSync(path.join(repoPath, 'README.md'), '# seed\n');
  await git(repoPath, 'add', 'README.md');
  await git(repoPath, 'commit', '-m', 'seed');
}

interface Harness {
  client: Client;
  server: OrchestratorServerHandle;
  repoPath: string;
  tmpRoot: string;
  worktreeManager: WorktreeManager;
  workerRegistry: WorkerRegistry;
}

async function setup(): Promise<Harness> {
  const tmpRoot = mkdtempSync(path.join(tmpdir(), 'symphony-2a4a-'));
  const repoPath = path.join(tmpRoot, 'main-repo');
  await execFileAsync('git', ['init', '-q', repoPath]);
  await initRepo(repoPath);

  const projectStore = new ProjectRegistry();
  projectStore.register({ id: 'main', name: 'main', path: repoPath, createdAt: '' });

  const worktreeManager = new WorktreeManager();
  const workerRegistry = new WorkerRegistry();
  const lifecycle = makeRealWorktreeFakeSpawnLifecycle({
    registry: workerRegistry,
    worktreeManager,
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = await startOrchestratorServer({
    transport: serverTransport,
    initialMode: 'act',
    defaultProjectPath: repoPath,
    workerManager: fakeWorkerManager(),
    worktreeManager,
    workerRegistry,
    workerLifecycle: lifecycle,
    projectStore,
  });
  const client = new Client({ name: '2a4a-scenario', version: '0.0.0' });
  await client.connect(clientTransport);
  return { client, server, repoPath, tmpRoot, worktreeManager, workerRegistry };
}

describe('Phase 2A.4a — production scenario (Maestro-only tools, real git)', () => {
  let harness: Harness | null = null;

  beforeEach(async () => {
    harness = await setup();
  });

  afterEach(async () => {
    if (!harness) return;
    await harness.client.close().catch(() => {});
    await harness.server.close().catch(() => {});
    try {
      rmSync(harness.tmpRoot, { recursive: true, force: true, maxRetries: 5 });
    } catch {
      /* windows file-lock retry — best effort */
    }
    harness = null;
  });

  it('drives ask_user + research_wave + review_diff + global_status end-to-end', async () => {
    const h = harness!;

    const blocking = await h.client.callTool({
      name: 'ask_user',
      arguments: { question: 'ship after 2A.4a?' },
    });
    expect(blocking.isError).toBeFalsy();
    const advisory = await h.client.callTool({
      name: 'ask_user',
      arguments: {
        question: 'naming?',
        project: 'main',
        urgency: 'advisory',
      },
    });
    expect(advisory.isError).toBeFalsy();
    expect(h.server.questionStore.size()).toBe(2);

    const waveRes = await h.client.callTool({
      name: 'research_wave',
      arguments: { topic: 'task-routing patterns', n: 3 },
    });
    expect(waveRes.isError).toBeFalsy();
    const waveSc = waveRes.structuredContent as {
      wave: { id: string; size: number };
      spawned: number;
    };
    expect(waveSc.spawned).toBe(3);
    expect(waveSc.wave.size).toBe(3);
    expect(h.server.waveStore.size()).toBe(1);

    const waveRecord = h.server.waveStore.list()[0]!;
    expect(waveRecord.workerIds.length).toBe(3);
    const firstWorkerId = waveRecord.workerIds[0]!;
    const firstRecord = h.workerRegistry.get(firstWorkerId)!;
    expect(existsSync(firstRecord.worktreePath)).toBe(true);

    // Write and stage a file in the first researcher's real worktree.
    writeFileSync(path.join(firstRecord.worktreePath, 'FOUND.md'), 'finding\n');
    await git(firstRecord.worktreePath, 'add', 'FOUND.md');

    const diffRes = await h.client.callTool({
      name: 'review_diff',
      arguments: { worker_id: firstWorkerId },
    });
    expect(diffRes.isError).toBeFalsy();
    const diffSc = diffRes.structuredContent as {
      files: Array<{ path: string; status: string }>;
      truncated: boolean;
    };
    expect(diffSc.files.some((f) => f.path === 'FOUND.md' && f.status === 'A')).toBe(true);
    expect(diffSc.truncated).toBe(false);

    const status = await h.client.callTool({
      name: 'global_status',
      arguments: {},
    });
    expect(status.isError).toBeFalsy();
    const sSc = status.structuredContent as {
      totals: { projects: number; workers: number; active: number };
      projects: Array<{ project: string; active: number; total: number }>;
    };
    expect(sSc.totals).toEqual({ projects: 1, workers: 3, active: 3 });
    const mainBucket = sSc.projects.find((p) => p.project === 'main')!;
    expect(mainBucket.total).toBe(3);
    expect(mainBucket.active).toBe(3);

    const withUncommitted = await h.client.callTool({
      name: 'global_status',
      arguments: { uncommitted: true },
    });
    const uSc = withUncommitted.structuredContent as {
      uncommitted: Array<{ worker_id: string; has_changes: boolean; staged: number }>;
    };
    const staged = uSc.uncommitted.find((u) => u.worker_id === firstWorkerId);
    expect(staged).toBeDefined();
    expect(staged!.has_changes).toBe(true);
    expect(staged!.staged).toBeGreaterThanOrEqual(1);

    const badDiff = await h.client.callTool({
      name: 'review_diff',
      arguments: { worker_id: 'wk-ghost' },
    });
    expect(badDiff.isError).toBe(true);

    const tooSmallWave = await h.client.callTool({
      name: 'research_wave',
      arguments: { topic: 'solo', n: 1 },
    });
    expect(tooSmallWave.isError).toBe(true);

    // Cleanup worktrees before harness afterEach; `remove` is idempotent.
    for (const id of waveRecord.workerIds) {
      const rec = h.workerRegistry.get(id);
      if (rec) {
        await h.worktreeManager.remove(rec.worktreePath, { deleteBranch: true }).catch(() => {});
      }
    }
  });
});
