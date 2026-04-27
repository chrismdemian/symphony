import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

const execFileAsync = promisify(execFile);

function ctx(tier: AutonomyTier = 2): DispatchContext {
  return {
    mode: 'act',
    tier,
    awayMode: false,
    automationContext: false,
  };
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
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sym-finalize-'));
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

function makeRunner(response: unknown): OneShotRunner {
  return async () => ({
    rawStdout: '',
    text: JSON.stringify(response),
    exitCode: 0,
    signaled: false,
    durationMs: 1,
    stderrTail: '',
  });
}

function makeOkRunner(): OneShotRunner {
  return makeRunner({ verdict: 'PASS', findings: [], summary: 'ok' });
}

/**
 * Spread-helper for finalize handler args so tests don't need to list
 * every optional field explicitly (2A.4a review m7 pattern: zod `.optional()`
 * collapses to `T | undefined` and the handler signature requires explicit
 * `undefined`, so tests must either list every key or use a helper like this).
 */
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

interface SpyFinalize {
  calls: number;
  lastOpts: unknown;
}

function makeFakeFinalizer(
  spy: SpyFinalize,
  result: FinalizeRunResult,
): typeof runFinalize {
  return async (opts) => {
    spy.calls += 1;
    spy.lastOpts = opts;
    return result;
  };
}

describe('finalize tool', () => {
  let worktree = '';
  let registry: WorkerRegistry;
  let projectStore: ProjectRegistry;

  beforeEach(async () => {
    worktree = await makeTempWorktree();
    registry = new WorkerRegistry();
    projectStore = new ProjectRegistry();
    projectStore.register({ id: 'p', name: 'p', path: worktree, createdAt: '' });
    // Project path same as worktree path means merge_to will be rejected —
    // that's a specific test case. Most tests use distinct paths.
    registerWorker(registry, 'wk-1', worktree, worktree);
  });

  afterEach(async () => {
    await fs.rm(worktree, { recursive: true, force: true }).catch(() => {});
  });

  it('scope=act, capabilities=[external-visible]', () => {
    const tool = makeFinalizeTool({
      registry,
      projectStore,
      oneShotRunner: makeOkRunner(),
    });
    expect(tool.scope).toBe('act');
    expect(tool.capabilities).toEqual(['external-visible']);
  });

  it('happy no-merge path invokes the runner with correct options', async () => {
    const spy: SpyFinalize = { calls: 0, lastOpts: undefined };
    const fakeResult: FinalizeRunResult = {
      ok: true,
      featureBranch: 'feature/x',
      commitSha: 'c'.repeat(40),
      steps: [
        { step: 'audit', status: 'ok', durationMs: 5, detail: 'PASS' },
        { step: 'lint', status: 'skipped', durationMs: 0 },
        { step: 'test', status: 'skipped', durationMs: 0 },
        { step: 'build', status: 'skipped', durationMs: 0 },
        { step: 'verify', status: 'skipped', durationMs: 0 },
        { step: 'commit', status: 'ok', durationMs: 10, detail: 'ccccccc: feat' },
        { step: 'push', status: 'ok', durationMs: 10, detail: 'origin/feature/x' },
      ],
    };
    const tool = makeFinalizeTool({
      registry,
      projectStore,
      oneShotRunner: makeOkRunner(),
      finalizeRunner: makeFakeFinalizer(spy, fakeResult),
    });
    const r = await tool.handler(
      { ...BASE_ARGS, worker_id: 'wk-1', commit_message: undefined, merge_to: undefined, source_remote: undefined, skip_audit: undefined, audit_model: undefined },
      ctx(2),
    );
    expect(r.isError).toBe(false);
    expect(spy.calls).toBe(1);
    expect(r.structuredContent?.ok).toBe(true);
    expect(r.structuredContent?.commit_sha).toBe('c'.repeat(40));
    expect(r.structuredContent?.merge_to).toBeNull();
    expect(r.content[0]?.text).toContain('feature/x');
  });

  it('defaults commit_message to "<role>: <feature_intent>"', async () => {
    const spy: SpyFinalize = { calls: 0, lastOpts: undefined };
    const fakeResult: FinalizeRunResult = {
      ok: true,
      featureBranch: 'feature/x',
      steps: [],
    };
    const tool = makeFinalizeTool({
      registry,
      projectStore,
      oneShotRunner: makeOkRunner(),
      finalizeRunner: makeFakeFinalizer(spy, fakeResult),
    });
    await tool.handler(
      { ...BASE_ARGS, worker_id: 'wk-1', commit_message: undefined, merge_to: undefined, source_remote: undefined, skip_audit: undefined, audit_model: undefined },
      ctx(2),
    );
    const opts = spy.lastOpts as { commitMessage: string };
    expect(opts.commitMessage).toBe('implementer: ship feature x');
  });

  it('rejects merge_to at tier < 3', async () => {
    const tool = makeFinalizeTool({
      registry,
      projectStore,
      oneShotRunner: makeOkRunner(),
    });
    const r = await tool.handler(
      { ...BASE_ARGS, worker_id: 'wk-1', commit_message: undefined, merge_to: 'main', source_remote: undefined, skip_audit: undefined, audit_model: undefined },
      ctx(2),
    );
    expect(r.isError).toBe(true);
    expect(r.content[0]?.text).toMatch(/tier 3/);
  });

  it('rejects skip_audit at tier < 3', async () => {
    const tool = makeFinalizeTool({
      registry,
      projectStore,
      oneShotRunner: makeOkRunner(),
    });
    const r = await tool.handler(
      { ...BASE_ARGS, worker_id: 'wk-1', commit_message: undefined, merge_to: undefined, source_remote: undefined, skip_audit: true, audit_model: undefined },
      ctx(2),
    );
    expect(r.isError).toBe(true);
    expect(r.content[0]?.text).toMatch(/skip_audit.*tier 3/);
  });

  it('rejects merge_to when worktreePath equals projectPath', async () => {
    // Our default fixture has worktree === projectPath; registry must refuse merge.
    const tool = makeFinalizeTool({
      registry,
      projectStore,
      oneShotRunner: makeOkRunner(),
    });
    const r = await tool.handler(
      { ...BASE_ARGS, worker_id: 'wk-1', commit_message: undefined, merge_to: 'main', source_remote: undefined, skip_audit: undefined, audit_model: undefined },
      ctx(3),
    );
    expect(r.isError).toBe(true);
    expect(r.content[0]?.text).toMatch(/distinct from the project root/);
  });

  it('allows merge_to at tier 3 with distinct worktree', async () => {
    const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'sym-finproj-'));
    try {
      projectStore.register({
        id: 'p2',
        name: 'p2',
        path: projectPath,
        createdAt: '',
      });
      registerWorker(registry, 'wk-2', projectPath, worktree);
      const spy: SpyFinalize = { calls: 0, lastOpts: undefined };
      const fakeResult: FinalizeRunResult = {
        ok: true,
        featureBranch: 'feature/x',
        commitSha: 'c'.repeat(40),
        mergeSha: 'd'.repeat(40),
        steps: [],
      };
      const tool = makeFinalizeTool({
        registry,
        projectStore,
        oneShotRunner: makeOkRunner(),
        finalizeRunner: makeFakeFinalizer(spy, fakeResult),
      });
      const r = await tool.handler(
        { ...BASE_ARGS, worker_id: 'wk-2', commit_message: undefined, merge_to: 'main', source_remote: undefined, skip_audit: undefined, audit_model: undefined },
        ctx(3),
      );
      expect(r.isError).toBe(false);
      expect(r.structuredContent?.merge_sha).toBe('d'.repeat(40));
      const opts = spy.lastOpts as { mergeTo: string; repoPath: string };
      expect(opts.mergeTo).toBe('main');
      expect(path.resolve(opts.repoPath)).toBe(path.resolve(projectPath));
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('returns isError:true with a readable detached-HEAD error', async () => {
    // Force detached HEAD in the worktree.
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
      cwd: worktree,
    });
    await execFileAsync('git', ['checkout', '-q', stdout.trim()], { cwd: worktree });
    const tool = makeFinalizeTool({
      registry,
      projectStore,
      oneShotRunner: makeOkRunner(),
    });
    const r = await tool.handler(
      { ...BASE_ARGS, worker_id: 'wk-1', commit_message: undefined, merge_to: undefined, source_remote: undefined, skip_audit: undefined, audit_model: undefined },
      ctx(2),
    );
    expect(r.isError).toBe(true);
    expect(r.content[0]?.text).toMatch(/detached-HEAD/);
  });

  it('returns isError:true for unknown worker id', async () => {
    const tool = makeFinalizeTool({
      registry,
      projectStore,
      oneShotRunner: makeOkRunner(),
    });
    const r = await tool.handler(
      { ...BASE_ARGS, worker_id: 'wk-nope', commit_message: undefined, merge_to: undefined, source_remote: undefined, skip_audit: undefined, audit_model: undefined },
      ctx(2),
    );
    expect(r.isError).toBe(true);
    expect(r.content[0]?.text).toMatch(/Unknown worker/);
  });

  it('audit FAIL propagates through auditRunner closure and reports failedAt:audit', async () => {
    // Real finalize-runner, fake one-shot with FAIL.
    const failingRunner = makeRunner({
      verdict: 'FAIL',
      findings: [{ severity: 'Critical', location: 'x', description: 'bad' }],
      summary: 'Critical issue.',
    });
    const tool = makeFinalizeTool({
      registry,
      projectStore,
      oneShotRunner: failingRunner,
    });
    const r = await tool.handler(
      { ...BASE_ARGS, worker_id: 'wk-1', commit_message: undefined, merge_to: undefined, source_remote: undefined, skip_audit: undefined, audit_model: undefined },
      ctx(2),
    );
    expect(r.isError).toBe(true);
    expect(r.structuredContent?.failed_at).toBe('audit');
    expect(r.structuredContent?.ok).toBe(false);
  });

  it('C1: rejects finalize when untracked files are present (tier < 3)', async () => {
    // Add an untracked file — git sees it as ?? but audit never reads content.
    await fs.writeFile(path.join(worktree, 'secrets.env'), 'AWS_KEY=fake\n', 'utf8');
    const tool = makeFinalizeTool({
      registry,
      projectStore,
      oneShotRunner: makeOkRunner(),
    });
    const r = await tool.handler(
      { ...BASE_ARGS, worker_id: 'wk-1' },
      ctx(2),
    );
    expect(r.isError).toBe(true);
    expect(r.content[0]?.text).toMatch(/secrets\.env/);
    expect(r.content[0]?.text).toMatch(/allow_untracked|Stage them/);
  });

  it('C1: requires tier 3 for allow_untracked escape hatch', async () => {
    await fs.writeFile(path.join(worktree, 'misc.txt'), 'x\n', 'utf8');
    const tool = makeFinalizeTool({
      registry,
      projectStore,
      oneShotRunner: makeOkRunner(),
    });
    const r = await tool.handler(
      { ...BASE_ARGS, worker_id: 'wk-1', allow_untracked: true },
      ctx(2),
    );
    expect(r.isError).toBe(true);
    expect(r.content[0]?.text).toMatch(/allow_untracked=true.*tier 3/);
  });

  it('C1: allow_untracked=true at tier 3 proceeds past the untracked guard', async () => {
    await fs.writeFile(path.join(worktree, 'extra.md'), 'x\n', 'utf8');
    // Use a distinct project path so merge_to is not a separate concern.
    const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'sym-fin-c1-'));
    try {
      projectStore.register({
        id: 'p3',
        name: 'p3',
        path: projectPath,
        createdAt: '',
      });
      registerWorker(registry, 'wk-c1', projectPath, worktree);
      const spy: SpyFinalize = { calls: 0, lastOpts: undefined };
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
        finalizeRunner: makeFakeFinalizer(spy, fakeResult),
      });
      const r = await tool.handler(
        { ...BASE_ARGS, worker_id: 'wk-c1', allow_untracked: true },
        ctx(3),
      );
      expect(r.isError).toBe(false);
      expect(spy.calls).toBe(1);
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('M3: rejects finalize on a non-terminal (running) worker', async () => {
    // Replace wk-1 with a running-status record.
    registry.remove('wk-1');
    const runningRecord: WorkerRecord = {
      id: 'wk-run',
      projectPath: worktree,
      projectId: null,
      taskId: null,
      worktreePath: worktree,
      role: 'implementer',
      featureIntent: 'in flight',
      taskDescription: 'in flight',
      autonomyTier: 2,
      dependsOn: [],
      status: 'running',
      createdAt: new Date().toISOString(),
      worker: stubWorker(),
      buffer: new CircularBuffer<StreamEvent>(10),
      detach: () => {},
    };
    registry.register(runningRecord);
    const tool = makeFinalizeTool({
      registry,
      projectStore,
      oneShotRunner: makeOkRunner(),
    });
    const r = await tool.handler(
      { ...BASE_ARGS, worker_id: 'wk-run' },
      ctx(2),
    );
    expect(r.isError).toBe(true);
    expect(r.content[0]?.text).toMatch(/running|wait for completion/);
  });

  it('M3: force_finalize_while_running=true requires tier 3', async () => {
    registry.remove('wk-1');
    const runningRecord: WorkerRecord = {
      id: 'wk-run',
      projectPath: worktree,
      projectId: null,
      taskId: null,
      worktreePath: worktree,
      role: 'implementer',
      featureIntent: 'in flight',
      taskDescription: 'in flight',
      autonomyTier: 2,
      dependsOn: [],
      status: 'spawning',
      createdAt: new Date().toISOString(),
      worker: stubWorker(),
      buffer: new CircularBuffer<StreamEvent>(10),
      detach: () => {},
    };
    registry.register(runningRecord);
    const tool = makeFinalizeTool({
      registry,
      projectStore,
      oneShotRunner: makeOkRunner(),
    });
    const r = await tool.handler(
      { ...BASE_ARGS, worker_id: 'wk-run', force_finalize_while_running: true },
      ctx(2),
    );
    expect(r.isError).toBe(true);
    expect(r.content[0]?.text).toMatch(/force_finalize_while_running.*tier 3/);
  });

  it('M2: post-audit mutation triggers preCommitCheck failure at commit step', async () => {
    // Set up a distinct project so we can finalize legitimately, then
    // provide a finalizeRunner that drives the REAL preCommitCheck.
    const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'sym-fin-m2-'));
    try {
      projectStore.register({
        id: 'p4',
        name: 'p4',
        path: projectPath,
        createdAt: '',
      });
      registerWorker(registry, 'wk-m2', projectPath, worktree);
      await fs.writeFile(path.join(worktree, 'a.md'), 'before\n', 'utf8');
      await execFileAsync('git', ['add', '.'], { cwd: worktree });

      const tool = makeFinalizeTool({
        registry,
        projectStore,
        oneShotRunner: makeOkRunner(),
        finalizeRunner: async (opts) => {
          // Run the real audit runner closure (exercises runAudit + fingerprint).
          await opts.auditRunner();
          // Mutate the worktree BEFORE the preCommitCheck runs.
          await fs.writeFile(path.join(worktree, 'sneak.md'), 'injected\n', 'utf8');
          await execFileAsync('git', ['add', '.'], { cwd: worktree });
          const gate = await (opts.preCommitCheck ?? (async () => ({ ok: true as const })))();
          if (gate.ok) {
            throw new Error('preCommitCheck should have failed');
          }
          return {
            ok: false,
            steps: [
              { step: 'commit', status: 'failed', durationMs: 1, detail: gate.message },
            ],
            featureBranch: 'feature/x',
            failedAt: 'commit',
          };
        },
      });
      const r = await tool.handler(
        { ...BASE_ARGS, worker_id: 'wk-m2' },
        ctx(2),
      );
      expect(r.isError).toBe(true);
      expect(r.structuredContent?.failed_at).toBe('commit');
      expect(r.content[0]?.text).toMatch(/Worktree changed during finalize/);
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('skip_audit=true at tier 3 bypasses the reviewer', async () => {
    // Fail hard if the runner is called; it shouldn't be.
    const runner: OneShotRunner = async () => {
      throw new Error('reviewer should not be called');
    };
    const spy: SpyFinalize = { calls: 0, lastOpts: undefined };
    const fakeResult: FinalizeRunResult = {
      ok: true,
      featureBranch: 'feature/x',
      commitSha: 'c'.repeat(40),
      steps: [],
    };
    const tool = makeFinalizeTool({
      registry,
      projectStore,
      oneShotRunner: runner,
      finalizeRunner: async (opts) => {
        // Exercise the closure — verify it returns skipped without calling runner.
        const audit = await opts.auditRunner();
        expect(audit.pass).toBe(true);
        expect(audit.detail).toMatch(/skipped/);
        return makeFakeFinalizer(spy, fakeResult)(opts);
      },
    });
    const r = await tool.handler(
      { ...BASE_ARGS, worker_id: 'wk-1', commit_message: undefined, merge_to: undefined, source_remote: undefined, skip_audit: true, audit_model: undefined },
      ctx(3),
    );
    expect(r.isError).toBe(false);
    expect(r.structuredContent?.skip_audit).toBe(true);
  });
});
