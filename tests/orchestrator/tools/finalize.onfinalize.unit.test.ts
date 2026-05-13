import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeFinalizeTool } from '../../../src/orchestrator/tools/finalize.js';
import type {
  runFinalize,
  FinalizeRunResult,
} from '../../../src/orchestrator/finalize-runner.js';
import type { OneShotRunner } from '../../../src/orchestrator/one-shot.js';
import { ProjectRegistry } from '../../../src/projects/registry.js';
import type { AutonomyTier, DispatchContext } from '../../../src/orchestrator/types.js';
import {
  CircularBuffer,
  WorkerRegistry,
  type WorkerRecord,
} from '../../../src/orchestrator/worker-registry.js';
import type { StreamEvent, Worker } from '../../../src/workers/types.js';

/**
 * Phase 3O.1 — `onFinalize` callback seam on FinalizeDeps.
 *
 * Verifies: fires only on `result.ok === true`; passes the correct context
 * (workerId / branch / projectPath / worktreePath / mergeToSpecified flag);
 * a throwing callback does NOT break the finalize tool's structured return.
 */

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
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sym-finalize-onfin-'));
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
): void {
  const record: WorkerRecord = {
    id,
    projectPath,
    projectId: null,
    taskId: null,
    worktreePath,
    role: 'implementer',
    featureIntent: 'ship feature x',
    taskDescription: 'ship feature x',
    autonomyTier: 2,
    dependsOn: [],
    status: 'completed',
    createdAt: new Date().toISOString(),
    worker: stubWorker(),
    buffer: new CircularBuffer<StreamEvent>(10),
    detach: () => {},
  };
  reg.register(record);
}

function makeOkRunner(): OneShotRunner {
  return async () => ({
    rawStdout: '',
    text: JSON.stringify({ verdict: 'PASS', findings: [], summary: 'ok' }),
    exitCode: 0,
    signaled: false,
    durationMs: 1,
    stderrTail: '',
  });
}

function makeFakeFinalizer(result: FinalizeRunResult): typeof runFinalize {
  return async () => result;
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
} as const;

describe('finalize tool — onFinalize callback (3O.1)', () => {
  let worktree = '';
  let registry: WorkerRegistry;
  let projectStore: ProjectRegistry;

  beforeEach(async () => {
    worktree = await makeTempWorktree();
    registry = new WorkerRegistry();
    projectStore = new ProjectRegistry();
    // Use a distinct project path from worktreePath so merge_to is permitted.
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sym-finalize-onfin-proj-'));
    projectStore.register({ id: 'p', name: 'p', path: projectDir, createdAt: '' });
    registerWorker(registry, 'wk-1', projectDir, worktree);
  });

  afterEach(async () => {
    await fs.rm(worktree, { recursive: true, force: true }).catch(() => {});
  });

  it('fires on result.ok=true with mergeToSpecified=false when merge_to is undefined', async () => {
    const onFinalize = vi.fn();
    const fakeResult: FinalizeRunResult = {
      ok: true,
      featureBranch: 'feature/x',
      commitSha: 'c'.repeat(40),
      steps: [
        { step: 'audit', status: 'ok', durationMs: 5, detail: 'PASS' },
        { step: 'commit', status: 'ok', durationMs: 10, detail: 'ccccccc: feat' },
        { step: 'push', status: 'ok', durationMs: 10, detail: 'origin/feature/x' },
      ],
    };
    const tool = makeFinalizeTool({
      registry,
      projectStore,
      oneShotRunner: makeOkRunner(),
      finalizeRunner: makeFakeFinalizer(fakeResult),
      onFinalize,
    });
    const r = await tool.handler({ ...BASE_ARGS, worker_id: 'wk-1' }, ctx(2));
    expect(r.isError).toBe(false);
    expect(onFinalize).toHaveBeenCalledTimes(1);
    const [resultArg, contextArg] = onFinalize.mock.calls[0]!;
    expect(resultArg).toBe(fakeResult);
    expect(contextArg).toMatchObject({
      workerId: 'wk-1',
      branch: 'feature/x',
      mergeToSpecified: false,
      worktreePath: worktree,
    });
    expect(contextArg.projectPath).toBeDefined();
  });

  it('fires with mergeToSpecified=true when merge_to is passed (tier 3)', async () => {
    const onFinalize = vi.fn();
    const fakeResult: FinalizeRunResult = {
      ok: true,
      featureBranch: 'feature/x',
      commitSha: 'c'.repeat(40),
      mergeSha: 'm'.repeat(40),
      steps: [
        { step: 'audit', status: 'ok', durationMs: 5 },
        { step: 'commit', status: 'ok', durationMs: 10 },
        { step: 'push', status: 'ok', durationMs: 10 },
        { step: 'merge', status: 'ok', durationMs: 20 },
      ],
    };
    const tool = makeFinalizeTool({
      registry,
      projectStore,
      oneShotRunner: makeOkRunner(),
      finalizeRunner: makeFakeFinalizer(fakeResult),
      onFinalize,
    });
    const r = await tool.handler(
      { ...BASE_ARGS, worker_id: 'wk-1', merge_to: 'main' },
      ctx(3),
    );
    expect(r.isError).toBe(false);
    expect(onFinalize).toHaveBeenCalledTimes(1);
    expect(onFinalize.mock.calls[0]![1]).toMatchObject({
      mergeToSpecified: true,
    });
  });

  it('does NOT fire when result.ok=false', async () => {
    const onFinalize = vi.fn();
    const fakeResult: FinalizeRunResult = {
      ok: false,
      featureBranch: 'feature/x',
      failedAt: 'test',
      steps: [
        { step: 'audit', status: 'ok', durationMs: 5 },
        { step: 'lint', status: 'skipped', durationMs: 0 },
        { step: 'test', status: 'failed', durationMs: 30, detail: 'tests red' },
      ],
    };
    const tool = makeFinalizeTool({
      registry,
      projectStore,
      oneShotRunner: makeOkRunner(),
      finalizeRunner: makeFakeFinalizer(fakeResult),
      onFinalize,
    });
    const r = await tool.handler({ ...BASE_ARGS, worker_id: 'wk-1' }, ctx(2));
    expect(r.isError).toBe(true);
    expect(onFinalize).not.toHaveBeenCalled();
  });

  it('a throwing callback does NOT poison finalize structured return', async () => {
    const onFinalize = vi.fn(() => {
      throw new Error('dispatcher exploded');
    });
    const fakeResult: FinalizeRunResult = {
      ok: true,
      featureBranch: 'feature/x',
      commitSha: 'c'.repeat(40),
      steps: [],
    };
    const tool = makeFinalizeTool({
      registry,
      projectStore,
      oneShotRunner: makeOkRunner(),
      finalizeRunner: makeFakeFinalizer(fakeResult),
      onFinalize,
    });
    const r = await tool.handler({ ...BASE_ARGS, worker_id: 'wk-1' }, ctx(2));
    expect(r.isError).toBe(false);
    expect(r.structuredContent?.ok).toBe(true);
    expect(onFinalize).toHaveBeenCalledTimes(1);
  });

  it('omitted onFinalize is a no-op (existing test callers unaffected)', async () => {
    const fakeResult: FinalizeRunResult = {
      ok: true,
      featureBranch: 'feature/x',
      commitSha: 'c'.repeat(40),
      steps: [],
    };
    const tool = makeFinalizeTool({
      registry,
      projectStore,
      oneShotRunner: makeOkRunner(),
      finalizeRunner: makeFakeFinalizer(fakeResult),
      // onFinalize intentionally omitted
    });
    const r = await tool.handler({ ...BASE_ARGS, worker_id: 'wk-1' }, ctx(2));
    expect(r.isError).toBe(false);
    expect(r.structuredContent?.ok).toBe(true);
  });
});
