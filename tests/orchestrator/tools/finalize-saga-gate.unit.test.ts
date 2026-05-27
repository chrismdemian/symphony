/**
 * Phase 5E — saga-partial finalize gate.
 *
 *   - Worker without `taskId`: gate skipped.
 *   - Worker with `taskId` but no saga membership: gate skipped.
 *   - Worker with saga membership + all siblings terminal: gate skipped.
 *   - Worker with saga membership + sibling incomplete + tier <3: rejected.
 *   - Worker with saga membership + sibling incomplete + tier 3 +
 *     force_saga_partial=true: gate bypassed (runner is reached).
 *
 * Uses a stub `finalizeRunner` so we never spawn real git. We assert
 * the runner WAS / WAS NOT called.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { makeFinalizeTool } from '../../../src/orchestrator/tools/finalize.js';
import type {
  FinalizeRunResult,
  runFinalize,
} from '../../../src/orchestrator/finalize-runner.js';
import { ProjectRegistry } from '../../../src/projects/registry.js';
import { SagaRegistry } from '../../../src/state/saga-registry.js';
import type { AutonomyTier, DispatchContext } from '../../../src/orchestrator/types.js';
import {
  CircularBuffer,
  WorkerRegistry,
  type WorkerRecord,
} from '../../../src/orchestrator/worker-registry.js';
import type { StreamEvent, Worker } from '../../../src/workers/types.js';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function ctx(tier: AutonomyTier = 2): DispatchContext {
  return { mode: 'act', tier, awayMode: false, automationContext: false };
}

function stubWorker(): Worker {
  return {
    id: 'wk',
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

async function makeTempWorktree(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sym-saga-gate-'));
  await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  await execFileAsync('git', ['config', 'user.email', 't@t'], { cwd: dir });
  await execFileAsync('git', ['config', 'user.name', 't'], { cwd: dir });
  await execFileAsync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
  await fs.writeFile(path.join(dir, 'a.md'), 'seed\n', 'utf8');
  await execFileAsync('git', ['add', '.'], { cwd: dir });
  await execFileAsync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
  await execFileAsync('git', ['checkout', '-q', '-b', 'feature/x'], { cwd: dir });
  return dir;
}

function registerWorker(
  reg: WorkerRegistry,
  id: string,
  projectPath: string,
  worktreePath: string,
  taskId: string | null,
): void {
  const record: WorkerRecord = {
    id,
    projectPath,
    projectId: null,
    taskId,
    worktreePath,
    role: 'implementer',
    featureIntent: 'ship feature',
    taskDescription: 'ship feature',
    autonomyTier: 2,
    dependsOn: [],
    status: 'completed',
    createdAt: new Date().toISOString(),
    worker: stubWorker(),
    buffer: new CircularBuffer<StreamEvent>(10),
    auditAttempts: 0,
    detach: () => {},
  };
  reg.register(record);
}

const BASE_ARGS = {
  worker_id: '',
  commit_message: undefined,
  merge_to: undefined,
  source_remote: undefined,
  skip_audit: undefined,
  allow_untracked: undefined,
  force_finalize_while_running: undefined,
  audit_model: undefined,
  force_saga_partial: undefined,
} as const;

const okRunResult: FinalizeRunResult = {
  ok: true,
  featureBranch: 'feature/x',
  steps: [],
};

describe('finalize — saga-partial gate', () => {
  let dir: string;
  let projects: ProjectRegistry;
  let workers: WorkerRegistry;
  let sagas: SagaRegistry;
  let runnerSpy: { calls: number };
  let stubRunner: typeof runFinalize;

  beforeEach(async () => {
    dir = await makeTempWorktree();
    projects = new ProjectRegistry();
    projects.register({ id: 'p-a', name: 'projA', path: dir, createdAt: '' });
    projects.register({ id: 'p-b', name: 'projB', path: '/tmp/b', createdAt: '' });
    workers = new WorkerRegistry();
    sagas = new SagaRegistry();
    runnerSpy = { calls: 0 };
    stubRunner = (async () => {
      runnerSpy.calls += 1;
      return { ...okRunResult };
    }) as unknown as typeof runFinalize;
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('skips the gate when worker has no taskId', async () => {
    registerWorker(workers, 'wk-1', dir, dir, null);
    const tool = makeFinalizeTool({
      registry: workers,
      projectStore: projects,
      finalizeRunner: stubRunner,
      sagaStore: sagas,
    });
    const r = await tool.handler({ ...BASE_ARGS, worker_id: 'wk-1' }, ctx(2));
    expect(r.isError).toBeFalsy();
    expect(runnerSpy.calls).toBe(1);
  });

  it('skips the gate when task is not a saga member', async () => {
    registerWorker(workers, 'wk-1', dir, dir, 'tk-orphan');
    const tool = makeFinalizeTool({
      registry: workers,
      projectStore: projects,
      finalizeRunner: stubRunner,
      sagaStore: sagas,
    });
    const r = await tool.handler({ ...BASE_ARGS, worker_id: 'wk-1' }, ctx(2));
    expect(r.isError).toBeFalsy();
    expect(runnerSpy.calls).toBe(1);
  });

  it('skips the gate when all siblings are terminal', async () => {
    const s = sagas.create({ description: 'cross' });
    sagas.addMember({ sagaId: s.id, taskId: 'tk-self', projectId: 'p-a' });
    sagas.addMember({ sagaId: s.id, taskId: 'tk-sibling', projectId: 'p-b' });
    sagas.updateMemberStatus('tk-sibling', 'completed');
    registerWorker(workers, 'wk-1', dir, dir, 'tk-self');

    const tool = makeFinalizeTool({
      registry: workers,
      projectStore: projects,
      finalizeRunner: stubRunner,
      sagaStore: sagas,
    });
    const r = await tool.handler({ ...BASE_ARGS, worker_id: 'wk-1' }, ctx(2));
    expect(r.isError).toBeFalsy();
    expect(runnerSpy.calls).toBe(1);
  });

  it('rejects with saga-partial when a sibling is in_progress', async () => {
    const s = sagas.create({ description: 'cross' });
    sagas.addMember({ sagaId: s.id, taskId: 'tk-self', projectId: 'p-a' });
    sagas.addMember({ sagaId: s.id, taskId: 'tk-sibling', projectId: 'p-b' });
    sagas.updateMemberStatus('tk-sibling', 'in_progress');
    registerWorker(workers, 'wk-1', dir, dir, 'tk-self');

    const tool = makeFinalizeTool({
      registry: workers,
      projectStore: projects,
      finalizeRunner: stubRunner,
      sagaStore: sagas,
    });
    const r = await tool.handler({ ...BASE_ARGS, worker_id: 'wk-1' }, ctx(2));
    expect(r.isError).toBe(true);
    expect(runnerSpy.calls).toBe(0);
    const sc = r.structuredContent! as { code: string; sagaId: string; incompleteTaskIds: string[] };
    expect(sc.code).toBe('saga-partial');
    expect(sc.sagaId).toBe(s.id);
    expect(sc.incompleteTaskIds).toEqual(['tk-sibling']);
  });

  it('rejects force_saga_partial=true at tier <3', async () => {
    const s = sagas.create({ description: 'cross' });
    sagas.addMember({ sagaId: s.id, taskId: 'tk-self', projectId: 'p-a' });
    sagas.addMember({ sagaId: s.id, taskId: 'tk-sibling', projectId: 'p-b' });
    sagas.updateMemberStatus('tk-sibling', 'in_progress');
    registerWorker(workers, 'wk-1', dir, dir, 'tk-self');

    const tool = makeFinalizeTool({
      registry: workers,
      projectStore: projects,
      finalizeRunner: stubRunner,
      sagaStore: sagas,
    });
    const r = await tool.handler(
      { ...BASE_ARGS, worker_id: 'wk-1', force_saga_partial: true },
      ctx(2),
    );
    expect(r.isError).toBe(true);
    expect(runnerSpy.calls).toBe(0);
    expect(r.content[0]!.text).toContain('tier 3');
  });

  it('bypasses the gate with force_saga_partial=true at tier 3', async () => {
    const s = sagas.create({ description: 'cross' });
    sagas.addMember({ sagaId: s.id, taskId: 'tk-self', projectId: 'p-a' });
    sagas.addMember({ sagaId: s.id, taskId: 'tk-sibling', projectId: 'p-b' });
    sagas.updateMemberStatus('tk-sibling', 'in_progress');
    registerWorker(workers, 'wk-1', dir, dir, 'tk-self');

    const tool = makeFinalizeTool({
      registry: workers,
      projectStore: projects,
      finalizeRunner: stubRunner,
      sagaStore: sagas,
    });
    const r = await tool.handler(
      { ...BASE_ARGS, worker_id: 'wk-1', force_saga_partial: true },
      ctx(3),
    );
    expect(r.isError).toBeFalsy();
    expect(runnerSpy.calls).toBe(1);
  });

  it('skipped entirely when deps.sagaStore is undefined (pre-5E test fakes)', async () => {
    registerWorker(workers, 'wk-1', dir, dir, 'tk-self');
    const tool = makeFinalizeTool({
      registry: workers,
      projectStore: projects,
      finalizeRunner: stubRunner,
      // sagaStore: omitted on purpose — gate is no-op
    });
    const r = await tool.handler({ ...BASE_ARGS, worker_id: 'wk-1' }, ctx(2));
    expect(r.isError).toBeFalsy();
    expect(runnerSpy.calls).toBe(1);
  });
});
