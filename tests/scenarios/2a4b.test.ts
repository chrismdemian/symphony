import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
import type { OneShotRunner } from '../../src/orchestrator/one-shot.js';
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
      throw new Error('no worker spawn expected in 2A.4b scenario');
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
    status: 'completed',
    events: (async function* () {})(),
    sendFollowup: () => {},
    endInput: () => {},
    kill: () => {},
    waitForExit: async () =>
      ({ status: 'completed', exitCode: 0, signal: null, durationMs: 0 }),
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
        detach: () => {},
      };
      args.registry.register(record);
      return record;
    },
    resume: async () => {
      throw new Error('not used in 2A.4b scenario');
    },
    cleanup: (id: string) => {
      args.registry.remove(id);
    },
    shutdown: async () => {
      args.registry.clear();
    },
    recoverFromStore: () => ({ crashedIds: [] }),
    setOnEvent: () => {},
    getQueueSnapshot: () => ({ running: 0, capacity: Number.POSITIVE_INFINITY, pending: [] }),
  };
}

async function git(cwd: string, ...cmdArgs: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', cmdArgs, { cwd });
  return stdout;
}

interface Harness {
  client: Client;
  server: OrchestratorServerHandle;
  repoPath: string;
  bareRemote: string;
  tmpRoot: string;
  workerRegistry: WorkerRegistry;
  setOneShot: (runner: OneShotRunner) => void;
}

function makeResponse(payload: unknown): string {
  return JSON.stringify(payload);
}

function passRunner(): OneShotRunner {
  return async () => ({
    rawStdout: makeResponse({
      result: makeResponse({
        verdict: 'PASS',
        findings: [],
        summary: 'All good.',
      }),
      session_id: 'sess',
    }),
    text: makeResponse({
      verdict: 'PASS',
      findings: [],
      summary: 'All good.',
    }),
    sessionId: 'sess',
    exitCode: 0,
    signaled: false,
    durationMs: 1,
    stderrTail: '',
  });
}

function failRunner(): OneShotRunner {
  return async () => ({
    rawStdout: '',
    text: makeResponse({
      verdict: 'FAIL',
      findings: [
        {
          severity: 'Critical',
          location: 'feature.ts:1',
          description: 'null deref',
        },
      ],
      summary: 'Critical bug found.',
    }),
    sessionId: 'sess',
    exitCode: 0,
    signaled: false,
    durationMs: 1,
    stderrTail: '',
  });
}

async function setup(opts: {
  initialTier?: 1 | 2 | 3;
  lintCommand?: string;
  testCommand?: string;
  buildCommand?: string;
  verifyCommand?: string;
  verifyTimeoutMs?: number;
} = {}): Promise<Harness> {
  const tmpRoot = mkdtempSync(path.join(tmpdir(), 'symphony-2a4b-'));
  const bareRemote = path.join(tmpRoot, 'remote.git');
  const repoPath = path.join(tmpRoot, 'main-repo');

  await execFileAsync('git', ['init', '-q', '--bare', '--initial-branch=main', bareRemote]);
  await execFileAsync('git', ['clone', '-q', bareRemote, repoPath]);
  await git(repoPath, 'config', 'user.email', 'test@symphony.dev');
  await git(repoPath, 'config', 'user.name', 'Symphony Scenario 2A.4b');
  await git(repoPath, 'config', 'commit.gpgsign', 'false');
  // Force a branch rename on the clone to 'main' in case origin HEAD differed.
  await git(repoPath, 'checkout', '-q', '-b', 'main');
  writeFileSync(path.join(repoPath, 'README.md'), '# seed\n');
  await git(repoPath, 'add', 'README.md');
  await git(repoPath, 'commit', '-m', 'seed');
  await git(repoPath, 'push', '-q', '-u', 'origin', 'main');

  const projectStore = new ProjectRegistry();
  projectStore.register({
    id: 'main',
    name: 'main',
    path: repoPath,
    createdAt: '',
    ...(opts.lintCommand !== undefined ? { lintCommand: opts.lintCommand } : {}),
    ...(opts.testCommand !== undefined ? { testCommand: opts.testCommand } : {}),
    ...(opts.buildCommand !== undefined ? { buildCommand: opts.buildCommand } : {}),
    ...(opts.verifyCommand !== undefined ? { verifyCommand: opts.verifyCommand } : {}),
    ...(opts.verifyTimeoutMs !== undefined ? { verifyTimeoutMs: opts.verifyTimeoutMs } : {}),
  });

  const worktreeManager = new WorktreeManager();
  const workerRegistry = new WorkerRegistry();
  const lifecycle = makeRealWorktreeFakeSpawnLifecycle({
    registry: workerRegistry,
    worktreeManager,
  });

  // Stash a mutable runner pointer so tests can swap PASS/FAIL per-call.
  let currentRunner: OneShotRunner = passRunner();
  const setOneShot = (runner: OneShotRunner): void => {
    currentRunner = runner;
  };
  const delegatingRunner: OneShotRunner = (o) => currentRunner(o);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = await startOrchestratorServer({
    transport: serverTransport,
    initialMode: 'act',
    initialTier: opts.initialTier ?? 2,
    defaultProjectPath: repoPath,
    workerManager: fakeWorkerManager(),
    worktreeManager,
    workerRegistry,
    workerLifecycle: lifecycle,
    projectStore,
    oneShotRunner: delegatingRunner,
  });
  const client = new Client({ name: '2a4b-scenario', version: '0.0.0' });
  await client.connect(clientTransport);

  return {
    client,
    server,
    repoPath,
    bareRemote,
    tmpRoot,
    workerRegistry,
    setOneShot,
  };
}

async function stageFeatureChange(worktreePath: string): Promise<void> {
  writeFileSync(path.join(worktreePath, 'feature.ts'), 'export const v = 1;\n');
  await git(worktreePath, 'add', 'feature.ts');
}

describe('Phase 2A.4b — production scenario (audit + finalize, real git)', () => {
  let harness: Harness | null = null;

  beforeEach(async () => {
    // Set up per-test; some tests override config.
    harness = null;
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

  it('audit_changes returns PASS on a real worktree with the fake reviewer', async () => {
    harness = await setup({ initialTier: 2 });
    await harness.client.callTool({
      name: 'spawn_worker',
      arguments: {
        role: 'implementer',
        feature_intent: 'ship feature v',
        task_description: 'ship feature v',
      },
    });
    const record = harness.workerRegistry.list()[0]!;
    await stageFeatureChange(record.worktreePath);

    const res = await harness.client.callTool({
      name: 'audit_changes',
      arguments: { worker_id: record.id },
    });
    expect(res.isError).toBe(false);
    const sc = res.structuredContent as {
      verdict: string;
      findings: unknown[];
      summary: string;
    };
    expect(sc.verdict).toBe('PASS');
    expect(sc.summary).toContain('All good');
  });

  it('finalize (no merge) commits, pushes, and populates commit_sha', async () => {
    harness = await setup({
      initialTier: 2,
      lintCommand: 'node -e "process.exit(0)"',
      testCommand: 'node -e "process.exit(0)"',
      buildCommand: 'node -e "process.exit(0)"',
      verifyCommand: 'node -e "process.exit(0)"',
    });
    await harness.client.callTool({
      name: 'spawn_worker',
      arguments: {
        role: 'implementer',
        feature_intent: 'ship feature v',
        task_description: 'ship feature v',
      },
    });
    const record = harness.workerRegistry.list()[0]!;
    await stageFeatureChange(record.worktreePath);

    const res = await harness.client.callTool({
      name: 'finalize',
      arguments: { worker_id: record.id },
    });
    expect(res.isError).toBe(false);
    const sc = res.structuredContent as {
      ok: boolean;
      commit_sha: string;
      merge_sha: unknown;
      steps: Array<{ step: string; status: string }>;
    };
    expect(sc.ok).toBe(true);
    expect(sc.commit_sha).toMatch(/^[0-9a-f]{40}$/);
    expect(sc.merge_sha).toBeNull();
    // Every configured shell step ran OK.
    expect(sc.steps.find((s) => s.step === 'lint')?.status).toBe('ok');
    expect(sc.steps.find((s) => s.step === 'verify')?.status).toBe('ok');

    // The bare remote now has the feature branch with the commit.
    const branchList = await git(harness.bareRemote, 'branch');
    expect(branchList).toMatch(/symphony\/wk-fake-1/);
  });

  it('finalize with merge_to=main at tier 3 merges and deletes the remote branch', async () => {
    harness = await setup({ initialTier: 3 });
    await harness.client.callTool({
      name: 'spawn_worker',
      arguments: {
        role: 'implementer',
        feature_intent: 'ship feature v',
        task_description: 'ship feature v',
      },
    });
    const record = harness.workerRegistry.list()[0]!;
    await stageFeatureChange(record.worktreePath);

    const res = await harness.client.callTool({
      name: 'finalize',
      arguments: { worker_id: record.id, merge_to: 'main' },
    });
    expect(res.isError).toBe(false);
    const sc = res.structuredContent as {
      ok: boolean;
      commit_sha: string;
      merge_sha: string;
    };
    expect(sc.ok).toBe(true);
    expect(sc.commit_sha).toMatch(/^[0-9a-f]{40}$/);
    expect(sc.merge_sha).toMatch(/^[0-9a-f]{40}$/);

    // main on the bare remote now contains a merge commit.
    const log = await git(harness.bareRemote, 'log', '-2', '--pretty=%s', 'main');
    expect(log).toMatch(/Merge remote-tracking branch/);

    // Feature branch deleted from remote.
    const branchList = await git(harness.bareRemote, 'branch');
    expect(branchList).not.toMatch(/symphony\/wk-fake-1/);
  });

  it('finalize aborts at audit FAIL with no commit made', async () => {
    harness = await setup({ initialTier: 2 });
    await harness.client.callTool({
      name: 'spawn_worker',
      arguments: {
        role: 'implementer',
        feature_intent: 'ship buggy feature',
        task_description: 'ship buggy feature',
      },
    });
    const record = harness.workerRegistry.list()[0]!;
    await stageFeatureChange(record.worktreePath);
    harness.setOneShot(failRunner());

    const headBefore = (await git(record.worktreePath, 'rev-parse', 'HEAD')).trim();
    const res = await harness.client.callTool({
      name: 'finalize',
      arguments: { worker_id: record.id },
    });
    expect(res.isError).toBe(true);
    const sc = res.structuredContent as { ok: boolean; failed_at: string };
    expect(sc.ok).toBe(false);
    expect(sc.failed_at).toBe('audit');
    const headAfter = (await git(record.worktreePath, 'rev-parse', 'HEAD')).trim();
    expect(headAfter).toBe(headBefore);
  });

  it('finalize fails fast on a non-zero verify step, no commit made', async () => {
    harness = await setup({
      initialTier: 2,
      verifyCommand: 'node -e "process.exit(7)"',
    });
    await harness.client.callTool({
      name: 'spawn_worker',
      arguments: {
        role: 'implementer',
        feature_intent: 'ship broken',
        task_description: 'ship broken',
      },
    });
    const record = harness.workerRegistry.list()[0]!;
    await stageFeatureChange(record.worktreePath);

    const headBefore = (await git(record.worktreePath, 'rev-parse', 'HEAD')).trim();
    const res = await harness.client.callTool({
      name: 'finalize',
      arguments: { worker_id: record.id },
    });
    expect(res.isError).toBe(true);
    const sc = res.structuredContent as {
      ok: boolean;
      failed_at: string;
      commit_sha: unknown;
    };
    expect(sc.ok).toBe(false);
    expect(sc.failed_at).toBe('verify');
    expect(sc.commit_sha).toBeNull();
    const headAfter = (await git(record.worktreePath, 'rev-parse', 'HEAD')).trim();
    expect(headAfter).toBe(headBefore);
  });
});
