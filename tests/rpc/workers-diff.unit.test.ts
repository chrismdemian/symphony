import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSymphonyRouter } from '../../src/rpc/router-impl.js';
import { ProjectRegistry } from '../../src/projects/registry.js';
import { TaskRegistry } from '../../src/state/task-registry.js';
import { QuestionRegistry } from '../../src/state/question-registry.js';
import { WaveRegistry } from '../../src/orchestrator/research-wave-registry.js';
import {
  CircularBuffer,
  WorkerRegistry,
  type WorkerRecord,
} from '../../src/orchestrator/worker-registry.js';
import { ModeController } from '../../src/orchestrator/mode.js';
import type { StreamEvent, Worker } from '../../src/workers/types.js';

const execFileAsync = promisify(execFile);

/**
 * Phase 3J — `workers.diff` RPC tests. The handler resolves a baseRef
 * fallback chain (project.baseRef → gitBranch → master → main), runs
 * `git merge-base` against HEAD, and returns the diff body + structured
 * file list.
 *
 * Tests use real temp git repos so the merge-base path is exercised
 * against actual git, not a mock. Stub `Worker` objects are sufficient
 * since the handler reads only `worktreePath` + `projectId` off the
 * registry record.
 */

function stubWorker(): Worker {
  return {
    id: 'wk',
    sessionId: undefined,
    status: 'running',
    events: (async function* () {})(),
    sendFollowup: () => {},
    endInput: () => {},
    kill: () => {},
    waitForExit: async () =>
      ({ status: 'running' as const, exitCode: 0, signal: null, durationMs: 0 }),
  } as unknown as Worker;
}

function makeRecord(overrides: Partial<WorkerRecord>): WorkerRecord {
  return {
    id: overrides.id ?? 'wk-1',
    projectPath: overrides.projectPath ?? '/tmp/p',
    projectId: overrides.projectId ?? null,
    taskId: null,
    worktreePath: overrides.worktreePath ?? '/tmp/p',
    role: 'implementer',
    featureIntent: 'feature',
    taskDescription: 'task',
    autonomyTier: 2,
    dependsOn: [],
    status: 'running',
    createdAt: new Date().toISOString(),
    worker: stubWorker(),
    buffer: new CircularBuffer<StreamEvent>(10),
    detach: () => {},
    ...overrides,
  };
}

async function initRepo(dir: string): Promise<void> {
  await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  await execFileAsync('git', ['config', 'user.email', 't@t'], { cwd: dir });
  await execFileAsync('git', ['config', 'user.name', 't'], { cwd: dir });
  await execFileAsync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
  await fs.writeFile(path.join(dir, 'README.md'), '# base\n', 'utf8');
  await execFileAsync('git', ['add', '.'], { cwd: dir });
  await execFileAsync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
}

async function checkoutBranch(dir: string, name: string): Promise<void> {
  await execFileAsync('git', ['checkout', '-q', '-b', name], { cwd: dir });
}

async function commit(dir: string, file: string, content: string, message: string): Promise<void> {
  await fs.writeFile(path.join(dir, file), content, 'utf8');
  await execFileAsync('git', ['add', '.'], { cwd: dir });
  await execFileAsync('git', ['commit', '-q', '-m', message], { cwd: dir });
}

function makeRouter(opts: {
  workerRegistry: WorkerRegistry;
  projectStore?: ProjectRegistry;
}) {
  const projectStore = opts.projectStore ?? new ProjectRegistry();
  const taskStore = new TaskRegistry({ projectStore });
  return createSymphonyRouter({
    projectStore,
    taskStore,
    questionStore: new QuestionRegistry(),
    waveStore: new WaveRegistry(),
    workerRegistry: opts.workerRegistry,
    modeController: new ModeController({ initial: 'plan' }),
  });
}

describe('workers.diff RPC (Phase 3J)', () => {
  let dir = '';

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sym-rpc-diff-'));
    await initRepo(dir);
    await checkoutBranch(dir, 'feature/x');
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it('throws not_found when worker is unknown', async () => {
    const reg = new WorkerRegistry();
    const router = makeRouter({ workerRegistry: reg });
    await expect(router.workers.diff({ workerId: 'nope' })).rejects.toThrow(/not registered/);
  });

  it('rejects empty workerId', async () => {
    const reg = new WorkerRegistry();
    const router = makeRouter({ workerRegistry: reg });
    await expect(router.workers.diff({ workerId: '' })).rejects.toThrow(/workerId/);
  });

  it('rejects out-of-range capBytes', async () => {
    const reg = new WorkerRegistry();
    reg.register(makeRecord({ worktreePath: dir }));
    const router = makeRouter({ workerRegistry: reg });
    await expect(router.workers.diff({ workerId: 'wk-1', capBytes: 1 })).rejects.toThrow(/capBytes/);
    await expect(router.workers.diff({ workerId: 'wk-1', capBytes: 999_999_999 })).rejects.toThrow(
      /capBytes/,
    );
    await expect(
      router.workers.diff({ workerId: 'wk-1', capBytes: 4.5 as unknown as number }),
    ).rejects.toThrow(/capBytes/);
  });

  it('returns diff against project.baseRef when set', async () => {
    // feature commit so HEAD diverges from main
    await commit(dir, 'feat.txt', 'hello\n', 'feat');
    await fs.writeFile(path.join(dir, 'unstaged.txt'), 'wip\n', 'utf8');

    const projectStore = new ProjectRegistry();
    projectStore.register({
      id: 'p',
      name: 'p',
      path: dir,
      baseRef: 'main',
      createdAt: '',
    });
    const reg = new WorkerRegistry();
    reg.register(makeRecord({ worktreePath: dir, projectId: 'p' }));
    const router = makeRouter({ workerRegistry: reg, projectStore });

    const result = await router.workers.diff({ workerId: 'wk-1' });
    expect(result.resolvedBase).toBe('main');
    expect(result.mergeBaseSha).toMatch(/^[0-9a-f]{40}$/);
    expect(result.branch).toBe('feature/x');
    expect(result.diff).toContain('feat.txt');
    expect(result.files.some((f) => f.path === 'feat.txt' && f.status === 'A')).toBe(true);
    expect(result.files.some((f) => f.path === 'unstaged.txt' && f.status === '??')).toBe(true);
  });

  it('falls back to project.gitBranch when baseRef is not set', async () => {
    await commit(dir, 'b.txt', 'b\n', 'b');
    const projectStore = new ProjectRegistry();
    projectStore.register({
      id: 'p',
      name: 'p',
      path: dir,
      gitBranch: 'main',
      createdAt: '',
    });
    const reg = new WorkerRegistry();
    reg.register(makeRecord({ worktreePath: dir, projectId: 'p' }));
    const router = makeRouter({ workerRegistry: reg, projectStore });

    const result = await router.workers.diff({ workerId: 'wk-1' });
    expect(result.resolvedBase).toBe('main');
  });

  it('falls back to "main" when project has neither baseRef nor gitBranch (init -b main)', async () => {
    await commit(dir, 'c.txt', 'c\n', 'c');
    const projectStore = new ProjectRegistry();
    projectStore.register({ id: 'p', name: 'p', path: dir, createdAt: '' });
    const reg = new WorkerRegistry();
    reg.register(makeRecord({ worktreePath: dir, projectId: 'p' }));
    const router = makeRouter({ workerRegistry: reg, projectStore });

    const result = await router.workers.diff({ workerId: 'wk-1' });
    // 'master' fails rev-parse (repo init'd as main); chain proceeds to 'main' which exists.
    expect(result.resolvedBase).toBe('main');
  });

  it('works for an unregistered worker (projectId null) via master/main fallback', async () => {
    await commit(dir, 'd.txt', 'd\n', 'd');
    const reg = new WorkerRegistry();
    reg.register(makeRecord({ worktreePath: dir, projectId: null }));
    const router = makeRouter({ workerRegistry: reg });

    const result = await router.workers.diff({ workerId: 'wk-1' });
    // Fallback chain: master fails, main exists.
    expect(result.resolvedBase).toBe('main');
    expect(result.diff).toContain('d.txt');
  });

  it('throws bad_args when no candidate base ref resolves', async () => {
    // Brand-new orphan branch with no other history → no main / master / etc.
    await execFileAsync('git', ['checkout', '-q', '--orphan', 'orphan'], { cwd: dir });
    await execFileAsync('git', ['rm', '-rf', '-q', '.'], { cwd: dir });
    await fs.writeFile(path.join(dir, 'O.md'), 'orphan\n', 'utf8');
    await execFileAsync('git', ['add', '.'], { cwd: dir });
    await execFileAsync('git', ['commit', '-q', '-m', 'orphan'], { cwd: dir });
    await execFileAsync('git', ['branch', '-D', 'main'], { cwd: dir });
    await execFileAsync('git', ['branch', '-D', 'feature/x'], { cwd: dir });

    const projectStore = new ProjectRegistry();
    projectStore.register({ id: 'p', name: 'p', path: dir, createdAt: '' });
    const reg = new WorkerRegistry();
    reg.register(makeRecord({ worktreePath: dir, projectId: 'p' }));
    const router = makeRouter({ workerRegistry: reg, projectStore });

    await expect(router.workers.diff({ workerId: 'wk-1' })).rejects.toThrow(/no base ref resolved/);
  });

  it('returns empty diff body when worktree matches base', async () => {
    // No commits on feature branch; HEAD === main
    const projectStore = new ProjectRegistry();
    projectStore.register({
      id: 'p',
      name: 'p',
      path: dir,
      baseRef: 'main',
      createdAt: '',
    });
    const reg = new WorkerRegistry();
    reg.register(makeRecord({ worktreePath: dir, projectId: 'p' }));
    const router = makeRouter({ workerRegistry: reg, projectStore });

    const result = await router.workers.diff({ workerId: 'wk-1' });
    expect(result.diff).toBe('');
    expect(result.bytes).toBe(0);
    expect(result.truncated).toBe(false);
    expect(result.files).toEqual([]);
  });

  it('honors capBytes and reports truncation', async () => {
    // Commit a big file on the feature branch.
    await fs.writeFile(path.join(dir, 'big.txt'), 'x'.repeat(60_000) + '\n', 'utf8');
    await execFileAsync('git', ['add', '.'], { cwd: dir });
    await execFileAsync('git', ['commit', '-q', '-m', 'big'], { cwd: dir });

    const projectStore = new ProjectRegistry();
    projectStore.register({ id: 'p', name: 'p', path: dir, baseRef: 'main', createdAt: '' });
    const reg = new WorkerRegistry();
    reg.register(makeRecord({ worktreePath: dir, projectId: 'p' }));
    const router = makeRouter({ workerRegistry: reg, projectStore });

    const result = await router.workers.diff({ workerId: 'wk-1', capBytes: 4_000 });
    expect(result.truncated).toBe(true);
    expect(result.bytes).toBeGreaterThan(4_000);
    expect(result.diff).toContain('diff truncated');
  });

  it('detects detached-HEAD branch as null', async () => {
    await commit(dir, 'e.txt', 'e\n', 'e');
    const head = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: dir })).stdout.trim();
    await execFileAsync('git', ['checkout', '-q', head], { cwd: dir });

    const projectStore = new ProjectRegistry();
    projectStore.register({ id: 'p', name: 'p', path: dir, baseRef: 'main', createdAt: '' });
    const reg = new WorkerRegistry();
    reg.register(makeRecord({ worktreePath: dir, projectId: 'p' }));
    const router = makeRouter({ workerRegistry: reg, projectStore });

    const result = await router.workers.diff({ workerId: 'wk-1' });
    expect(result.branch).toBeNull();
  });

  it('throws bad_args git error when worktree path is missing', async () => {
    const reg = new WorkerRegistry();
    reg.register(makeRecord({ worktreePath: path.join(dir, 'does-not-exist') }));
    const router = makeRouter({ workerRegistry: reg });

    // refExists returns false for all candidates → no base resolves
    await expect(router.workers.diff({ workerId: 'wk-1' })).rejects.toThrow(/no base ref resolved/);
  });
});
