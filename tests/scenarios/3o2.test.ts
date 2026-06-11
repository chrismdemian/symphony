import { execFile, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';

import {
  ProjectRegistry,
  startOrchestratorServer,
  type OrchestratorServerHandle,
} from '../../src/orchestrator/index.js';
import type {
  GhCreatePrInput,
  GhCreatePrResult,
  GhRunner,
} from '../../src/orchestrator/gh-cli.js';
import type { OneShotResult, OneShotRunner } from '../../src/orchestrator/one-shot.js';
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

const claudeAvailable = detectClaude();
function detectClaude(): boolean {
  try {
    const r = spawnSync('claude', ['--version'], { encoding: 'utf8', timeout: 5_000, shell: false });
    return r.status === 0 && r.stdout.trim().length > 0;
  } catch {
    return false;
  }
}
if (!claudeAvailable) {
  console.warn(
    '[3o2 scenario] `claude --version` unavailable — the real-claude happy-path test will skip. The Tier-1 capability-gate test still runs.',
  );
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout;
}

function fakeWorkerManager(): WorkerManager {
  return {
    spawn: async () => {
      throw new Error('no worker spawn expected in 3o2 scenario');
    },
    list: () => [],
    get: () => undefined,
    shutdown: async () => {},
  } as unknown as WorkerManager;
}

function stubWorker(id: string): Worker {
  return {
    id,
    status: 'completed',
    events: (async function* () {})(),
    sendFollowup: () => {},
    endInput: () => {},
    kill: () => {},
    waitForExit: async () => ({ status: 'completed', exitCode: 0, signal: null, durationMs: 0 }),
  } as unknown as Worker;
}

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
        status: 'completed',
        createdAt: new Date().toISOString(),
        worker: stubWorker(id),
        buffer: new CircularBuffer<StreamEvent>(10),
        auditAttempts: 0,
        detach: () => {},
      };
      args.registry.register(record);
      return record;
    },
    resume: async () => {
      throw new Error('not used in 3o2 scenario');
    },
    cleanup: (id: string) => args.registry.remove(id),
    shutdown: async () => args.registry.clear(),
    recoverFromStore: () => ({ crashedIds: [] }),
    setOnEvent: () => {},
    getQueueSnapshot: () => ({ running: 0, capacity: Number.POSITIVE_INFINITY, pending: [] }),
    getTotalRunning: () => 0,
    listPendingGlobal: () => [],
    cancelQueued: () => ({ cancelled: false, reason: 'not in queue' }),
    reorderQueued: () => ({ moved: false, reason: 'not in queue' }),
    killAllRunning: () => ({ killedIds: [] }),
    cancelAllQueued: () => ({ cancelledIds: [] }),
  };
}

function recordingGh(result?: GhCreatePrResult): { gh: GhRunner; inputs: GhCreatePrInput[] } {
  const inputs: GhCreatePrInput[] = [];
  return {
    inputs,
    gh: {
      checkAvailable: async () => ({ available: true }),
      hasGitHubRemote: async () => true,
      createPr: async (input) => {
        inputs.push(input);
        return result ?? { url: 'https://github.com/symphony/test/pull/123', alreadyExisted: false };
      },
    },
  };
}

function stubOneShot(): OneShotRunner {
  return async (): Promise<OneShotResult> => ({
    rawStdout: '{"title":"x","description":"y"}',
    text: '{"title":"x","description":"y"}',
    exitCode: 0,
    signaled: false,
    durationMs: 1,
    stderrTail: '',
  });
}

interface Harness {
  client: Client;
  server: OrchestratorServerHandle;
  repoPath: string;
  tmpRoot: string;
  workerRegistry: WorkerRegistry;
  ghInputs: GhCreatePrInput[];
}

async function setup(opts: {
  initialTier: 1 | 2 | 3;
  ghRunner: GhRunner;
  ghInputs: GhCreatePrInput[];
  oneShotRunner?: OneShotRunner;
}): Promise<Harness> {
  const tmpRoot = mkdtempSync(path.join(tmpdir(), 'symphony-3o2-'));
  const bareRemote = path.join(tmpRoot, 'remote.git');
  const repoPath = path.join(tmpRoot, 'main-repo');

  await execFileAsync('git', ['init', '-q', '--bare', '--initial-branch=main', bareRemote]);
  await execFileAsync('git', ['clone', '-q', bareRemote, repoPath]);
  await git(repoPath, 'config', 'user.email', 'test@symphony.dev');
  await git(repoPath, 'config', 'user.name', 'Symphony Scenario 3O.2');
  await git(repoPath, 'config', 'commit.gpgsign', 'false');
  await git(repoPath, 'checkout', '-q', '-b', 'main');
  writeFileSync(path.join(repoPath, 'README.md'), '# seed\n');
  await git(repoPath, 'add', 'README.md');
  await git(repoPath, 'commit', '-m', 'seed');
  await git(repoPath, 'push', '-q', '-u', 'origin', 'main');

  const projectStore = new ProjectRegistry();
  projectStore.register({ id: 'main', name: 'main', path: repoPath, createdAt: '' });

  const worktreeManager = new WorktreeManager();
  const workerRegistry = new WorkerRegistry();
  const lifecycle = makeRealWorktreeFakeSpawnLifecycle({ registry: workerRegistry, worktreeManager });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = await startOrchestratorServer({
    transport: serverTransport,
    initialMode: 'act',
    initialTier: opts.initialTier,
    defaultProjectPath: repoPath,
    workerManager: fakeWorkerManager(),
    worktreeManager,
    workerRegistry,
    workerLifecycle: lifecycle,
    projectStore,
    openPrGhRunner: opts.ghRunner,
    ...(opts.oneShotRunner !== undefined ? { oneShotRunner: opts.oneShotRunner } : {}),
  });
  const client = new Client({ name: '3o2-scenario', version: '0.0.0' });
  await client.connect(clientTransport);

  return { client, server, repoPath, tmpRoot, workerRegistry, ghInputs: opts.ghInputs };
}

/** Spawn a worker, then COMMIT a change on its worktree branch. */
async function spawnAndCommit(h: Harness): Promise<WorkerRecord> {
  await h.client.callTool({
    name: 'spawn_worker',
    arguments: { role: 'implementer', feature_intent: 'add greeting', task_description: 'add a greeting helper' },
  });
  const record = h.workerRegistry.list()[0]!;
  writeFileSync(path.join(record.worktreePath, 'greeting.ts'), 'export const hi = () => "hello";\n');
  await git(record.worktreePath, 'add', 'greeting.ts');
  await git(record.worktreePath, 'commit', '-m', 'feat: add greeting helper');
  return record;
}

describe('Phase 3O.2 — open_pr production scenario', () => {
  let harness: Harness | null = null;

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

  it('denies open_pr at Tier 1 (external-visible needs Tier ≥2); gh is never called', async () => {
    const { gh, inputs } = recordingGh();
    harness = await setup({ initialTier: 1, ghRunner: gh, ghInputs: inputs, oneShotRunner: stubOneShot() });
    const record = await spawnAndCommit(harness);

    const res = await harness.client.callTool({
      name: 'open_pr',
      arguments: { worker_id: record.id },
    });
    expect(res.isError).toBe(true);
    expect(inputs).toHaveLength(0);
  });

  it.skipIf(!claudeAvailable)(
    'generates real PR content with claude and opens the PR via the fake gh',
    async () => {
      const { gh, inputs } = recordingGh();
      // No oneShotRunner override → the real defaultOneShotRunner (real claude).
      harness = await setup({ initialTier: 2, ghRunner: gh, ghInputs: inputs });
      const record = await spawnAndCommit(harness);

      const res = await harness.client.callTool({
        name: 'open_pr',
        arguments: { worker_id: record.id },
      });

      expect(res.isError).toBeFalsy();
      const sc = res.structuredContent as {
        url: string;
        base: string;
        head: string;
        description_source: string;
      };
      expect(sc.url).toBe('https://github.com/symphony/test/pull/123');
      expect(sc.base).toBe('main');
      expect(sc.head).toMatch(/wk-fake-1/); // head is the worker branch
      expect(['llm', 'heuristic', 'fallback']).toContain(sc.description_source);

      // The fake gh received exactly one createPr with real, non-empty content.
      expect(inputs).toHaveLength(1);
      expect(inputs[0]?.base).toBe('main');
      expect(inputs[0]?.head).toMatch(/wk-fake-1/);
      expect(inputs[0]?.title.trim().length).toBeGreaterThan(0);
      expect(inputs[0]?.body.trim().length).toBeGreaterThan(0);
    },
    120_000,
  );
});
