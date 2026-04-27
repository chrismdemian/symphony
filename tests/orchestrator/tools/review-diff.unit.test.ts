import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeReviewDiffTool } from '../../../src/orchestrator/tools/review-diff.js';
import {
  CircularBuffer,
  WorkerRegistry,
  type WorkerRecord,
} from '../../../src/orchestrator/worker-registry.js';
import type { DispatchContext } from '../../../src/orchestrator/types.js';
import type { StreamEvent, Worker } from '../../../src/workers/types.js';

const execFileAsync = promisify(execFile);

function ctx(overrides: Partial<DispatchContext> = {}): DispatchContext {
  return {
    mode: 'act',
    tier: 1,
    awayMode: false,
    automationContext: false,
    ...overrides,
  };
}

async function makeTempRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sym-review-diff-'));
  await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  await execFileAsync('git', ['config', 'user.email', 't@t'], { cwd: dir });
  await execFileAsync('git', ['config', 'user.name', 't'], { cwd: dir });
  await execFileAsync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
  await fs.writeFile(path.join(dir, 'README.md'), '# base\n', 'utf8');
  await execFileAsync('git', ['add', '.'], { cwd: dir });
  await execFileAsync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
  return dir;
}

function stubWorker(): Worker {
  return {
    id: 'wk-stub',
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

function registerWorker(reg: WorkerRegistry, id: string, worktreePath: string): void {
  const record: WorkerRecord = {
    id,
    projectPath: path.dirname(worktreePath),
    projectId: null,
    taskId: null,
    worktreePath,
    role: 'implementer',
    featureIntent: 'test',
    taskDescription: 'test',
    autonomyTier: 1,
    dependsOn: [],
    status: 'completed',
    createdAt: new Date().toISOString(),
    worker: stubWorker(),
    buffer: new CircularBuffer<StreamEvent>(10),
    detach: () => {},
  };
  reg.register(record);
}

describe('review_diff tool', () => {
  let dir = '';
  let registry: WorkerRegistry;

  beforeEach(async () => {
    dir = await makeTempRepo();
    registry = new WorkerRegistry();
    registerWorker(registry, 'wk-a', dir);
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('returns "(no diff)" for a clean worktree', async () => {
    const tool = makeReviewDiffTool({ registry });
    const r = await tool.handler(
      { worker_id: 'wk-a', base_ref: undefined, cap_bytes: undefined },
      ctx(),
    );
    expect(r.isError).toBeUndefined();
    expect(r.content[0]?.text).toContain('(no diff)');
    expect(r.structuredContent?.bytes).toBe(0);
    expect(r.structuredContent?.files).toEqual([]);
  });

  it('captures unstaged + staged changes + untracked files', async () => {
    await fs.writeFile(path.join(dir, 'README.md'), '# changed\n', 'utf8');
    await fs.writeFile(path.join(dir, 'NEW.md'), 'hi\n', 'utf8');
    await execFileAsync('git', ['add', 'NEW.md'], { cwd: dir });
    await fs.writeFile(path.join(dir, 'UNTRACKED.txt'), 'x\n', 'utf8');
    const tool = makeReviewDiffTool({ registry });
    const r = await tool.handler(
      { worker_id: 'wk-a', base_ref: undefined, cap_bytes: undefined },
      ctx(),
    );
    expect(r.content[0]?.text).toMatch(/\+# changed/);
    expect(r.content[0]?.text).toMatch(/NEW\.md/);
    expect(r.content[0]?.text).toMatch(/UNTRACKED\.txt/);
    const files = r.structuredContent?.files as Array<{ path: string; status: string }>;
    expect(files.map((f) => f.path).sort()).toEqual([
      'NEW.md',
      'README.md',
      'UNTRACKED.txt',
    ]);
  });

  it('reports branch in the header', async () => {
    const tool = makeReviewDiffTool({ registry });
    const r = await tool.handler(
      { worker_id: 'wk-a', base_ref: undefined, cap_bytes: undefined },
      ctx(),
    );
    expect(r.content[0]?.text).toMatch(/branch main/);
    expect(r.structuredContent?.branch).toBe('main');
  });

  it('honors cap_bytes and sets truncated=true', async () => {
    const big = 'x'.repeat(5_000) + '\n';
    await fs.writeFile(path.join(dir, 'BIG.txt'), big, 'utf8');
    await execFileAsync('git', ['add', 'BIG.txt'], { cwd: dir });
    const tool = makeReviewDiffTool({ registry });
    const r = await tool.handler(
      { worker_id: 'wk-a', cap_bytes: 1000, base_ref: undefined },
      ctx(),
    );
    expect(r.structuredContent?.truncated).toBe(true);
    expect(r.content[0]?.text).toContain('diff truncated');
  });

  it('returns isError for unknown worker id', async () => {
    const tool = makeReviewDiffTool({ registry });
    const r = await tool.handler(
      { worker_id: 'wk-nope', base_ref: undefined, cap_bytes: undefined },
      ctx(),
    );
    expect(r.isError).toBe(true);
    expect(r.content[0]?.text).toMatch(/Unknown worker/);
  });

  it('surfaces git errors as isError, not a throw', async () => {
    // Register a worker pointing at a non-repo path.
    const notRepo = await fs.mkdtemp(path.join(os.tmpdir(), 'sym-not-repo-'));
    try {
      registerWorker(registry, 'wk-bad', notRepo);
      const tool = makeReviewDiffTool({ registry });
      const r = await tool.handler(
        { worker_id: 'wk-bad', base_ref: undefined, cap_bytes: undefined },
        ctx(),
      );
      expect(r.isError).toBe(true);
      expect(r.content[0]?.text).toMatch(/review_diff failed/);
    } finally {
      // Windows git may hold file handles briefly; tolerate EBUSY.
      await fs.rm(notRepo, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('scope is act (writes to disk via git subprocess, requires worker context)', () => {
    const tool = makeReviewDiffTool({ registry });
    expect(tool.scope).toBe('act');
  });
});
