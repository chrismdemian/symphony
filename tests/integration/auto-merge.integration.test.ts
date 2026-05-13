import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAutoMergeBroker } from '../../src/orchestrator/auto-merge-broker.js';
import { createAutoMergeDispatcher } from '../../src/orchestrator/auto-merge-dispatcher.js';
import * as gitOps from '../../src/orchestrator/git-ops.js';
import { QuestionRegistry } from '../../src/state/question-registry.js';
import { WorktreeManager } from '../../src/worktree/manager.js';
import { defaultConfig } from '../../src/utils/config-schema.js';
import type { AutoMergeEvent } from '../../src/orchestrator/auto-merge-types.js';
import type { LoadResult } from '../../src/utils/config.js';
import type { FinalizeRunResult } from '../../src/orchestrator/finalize-runner.js';

/**
 * Phase 3O.1 — full-stack auto-merge integration test.
 *
 * Spins up:
 *   - A real bare "remote" repo + a real cloned working repo.
 *   - A real feature branch with a new commit pushed to "origin".
 *   - A real worktree pointing at that feature branch via
 *     `WorktreeManager` (`.symphony/worktrees/<id>/...` layout).
 *   - A real `QuestionRegistry` with `onQuestionAnswered` wired to the
 *     dispatcher.
 *   - A real `gitOps.mergeBranch` call (fetch / checkout / pull / merge
 *     --no-ff / push / delete remote branch).
 *   - A real `WorktreeManager.remove({deleteBranch:true})` for cleanup.
 *
 * Verifies the merge gate end-to-end: dispatcher reads `autoMerge='ask'`,
 * enqueues a blocking question, user answers 'y' via `store.answer`, the
 * onQuestionAnswered hook routes to the dispatcher, the dispatcher fires
 * `gitOps.mergeBranch` against the real repo, then cleans the worktree.
 *
 * No mocking of anything covered by Known Gotchas — CLAUDE.md mandates
 * real git for integration coverage.
 */

const execFileAsync = promisify(execFile);

interface Fixture {
  readonly remoteDir: string;
  readonly localDir: string;
  readonly worktreePath: string;
  readonly branchName: string;
}

async function setupGitFixture(): Promise<Fixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sym-auto-merge-'));
  const remoteDir = path.join(root, 'remote.git');
  const localDir = path.join(root, 'local');

  // Bare remote.
  await execFileAsync('git', ['init', '-q', '--bare', '-b', 'master', remoteDir]);

  // Clone it.
  await execFileAsync('git', ['clone', '-q', remoteDir, localDir]);
  await execFileAsync('git', ['config', 'user.email', 't@t'], { cwd: localDir });
  await execFileAsync('git', ['config', 'user.name', 't'], { cwd: localDir });
  await execFileAsync('git', ['config', 'commit.gpgsign', 'false'], { cwd: localDir });

  // Seed master with a commit + push.
  await fs.writeFile(path.join(localDir, 'README.md'), 'seed\n', 'utf8');
  await execFileAsync('git', ['add', '.'], { cwd: localDir });
  await execFileAsync('git', ['commit', '-q', '-m', 'init'], { cwd: localDir });
  await execFileAsync('git', ['push', '-q', 'origin', 'master'], { cwd: localDir });

  // Create a worktree via WorktreeManager (Symphony's layout:
  // <project>/.symphony/worktrees/<id>). WorktreeManager auto-generates
  // the branch name from workerId + shortDescription; we read it back
  // from WorktreeInfo rather than passing one in.
  const wtm = new WorktreeManager();
  const info = await wtm.create({
    projectPath: localDir,
    workerId: 'wk-1',
    shortDescription: 'auto-merge-test',
  });
  const branchName = info.branch;
  const worktreePath = info.path;

  // Add a commit on the feature branch + push so the remote knows the branch.
  await fs.writeFile(path.join(worktreePath, 'feature.md'), 'work\n', 'utf8');
  await execFileAsync('git', ['add', '.'], { cwd: worktreePath });
  await execFileAsync('git', ['commit', '-q', '-m', 'feature work'], {
    cwd: worktreePath,
  });
  await execFileAsync('git', ['push', '-q', '-u', 'origin', branchName], {
    cwd: worktreePath,
  });

  return { remoteDir, localDir, worktreePath, branchName };
}

function fakeOkFinalize(branch: string): FinalizeRunResult {
  return {
    ok: true,
    featureBranch: branch,
    commitSha: 'c'.repeat(40),
    steps: [
      { step: 'audit', status: 'ok', durationMs: 5 },
      { step: 'commit', status: 'ok', durationMs: 10 },
      { step: 'push', status: 'ok', durationMs: 10 },
    ],
  };
}

describe('auto-merge end-to-end (integration)', () => {
  let fixture: Fixture | undefined;
  let cleanupDirs: string[] = [];

  beforeEach(() => {
    cleanupDirs = [];
  });

  afterEach(async () => {
    if (fixture !== undefined) {
      // Best effort — some tests already removed the worktree.
      await fs.rm(fixture.localDir, { recursive: true, force: true }).catch(() => {});
      await fs.rm(fixture.remoteDir, { recursive: true, force: true }).catch(() => {});
      fixture = undefined;
    }
    for (const d of cleanupDirs) {
      await fs.rm(d, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("mode='auto' merges + cleans up worktree + emits 'merged' event", async () => {
    fixture = await setupGitFixture();
    const broker = createAutoMergeBroker();
    const events: AutoMergeEvent[] = [];
    broker.subscribe((e) => events.push(e));

    const questionStore = new QuestionRegistry();
    const wtm = new WorktreeManager();

    const dispatcher = createAutoMergeDispatcher({
      loadConfig: async (): Promise<LoadResult> => ({
        config: { ...defaultConfig(), autoMerge: 'auto' },
        source: { kind: 'default' as const },
      }),
      questionStore,
      broker,
      gitOps,
      worktreeManager: wtm,
      getProjectName: () => 'fixture',
    });

    dispatcher.onFinalize(fakeOkFinalize(fixture.branchName), {
      workerId: 'wk-1',
      branch: fixture.branchName,
      projectPath: fixture.localDir,
      worktreePath: fixture.worktreePath,
      mergeToSpecified: false,
    });

    await dispatcher.shutdown();

    // The merged event should land — verify the sha is a real sha-1.
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe('merged');
    expect(events[0]!.mergeSha).toMatch(/^[0-9a-f]{40}$/);

    // Verify the merge actually landed in the remote (master should have
    // the merge commit).
    const { stdout: log } = await execFileAsync(
      'git',
      ['log', 'master', '--oneline', '--first-parent'],
      { cwd: fixture.remoteDir },
    );
    expect(log).toMatch(/Merge/);

    // Verify the worktree was removed.
    const worktreeStillExists = await fs
      .stat(fixture.worktreePath)
      .then(() => true)
      .catch(() => false);
    expect(worktreeStillExists).toBe(false);
  }, 30_000);

  it("mode='ask' enqueues a question, answer='y' triggers real merge", async () => {
    fixture = await setupGitFixture();
    const broker = createAutoMergeBroker();
    const events: AutoMergeEvent[] = [];
    broker.subscribe((e) => events.push(e));

    // Wire the question store's onAnswered hook to the dispatcher
    // (just like server.ts does via the autoMergeDispatcherRef holder).
    const dispatcherRef: { current?: ReturnType<typeof createAutoMergeDispatcher> } = {};
    const questionStore = new QuestionRegistry({
      onQuestionAnswered: (record) => dispatcherRef.current?.onQuestionAnswered(record),
    });
    const wtm = new WorktreeManager();

    const dispatcher = createAutoMergeDispatcher({
      loadConfig: async (): Promise<LoadResult> => ({
        config: { ...defaultConfig(), autoMerge: 'ask' },
        source: { kind: 'default' as const },
      }),
      questionStore,
      broker,
      gitOps,
      worktreeManager: wtm,
      getProjectName: () => 'fixture',
    });
    dispatcherRef.current = dispatcher;

    dispatcher.onFinalize(fakeOkFinalize(fixture.branchName), {
      workerId: 'wk-1',
      branch: fixture.branchName,
      projectPath: fixture.localDir,
      worktreePath: fixture.worktreePath,
      mergeToSpecified: false,
    });

    // Wait for the asked event so we know the question is enqueued.
    await vi.waitFor(() => {
      expect(events.find((e) => e.kind === 'asked')).toBeDefined();
    });

    const queued = questionStore.list({ answered: false });
    expect(queued).toHaveLength(1);
    expect(queued[0]!.urgency).toBe('blocking');

    // Answer 'y' — the store's onAnswered hook routes to the dispatcher.
    questionStore.answer(queued[0]!.id, 'y');

    await dispatcher.shutdown();

    const merged = events.find((e) => e.kind === 'merged');
    expect(merged).toBeDefined();
    expect(merged!.mergeSha).toMatch(/^[0-9a-f]{40}$/);
  }, 30_000);

  it("mode='ask' + answer='n' emits 'declined' without merging", async () => {
    fixture = await setupGitFixture();
    const broker = createAutoMergeBroker();
    const events: AutoMergeEvent[] = [];
    broker.subscribe((e) => events.push(e));

    const dispatcherRef: { current?: ReturnType<typeof createAutoMergeDispatcher> } = {};
    const questionStore = new QuestionRegistry({
      onQuestionAnswered: (record) => dispatcherRef.current?.onQuestionAnswered(record),
    });
    const wtm = new WorktreeManager();

    const dispatcher = createAutoMergeDispatcher({
      loadConfig: async (): Promise<LoadResult> => ({
        config: { ...defaultConfig(), autoMerge: 'ask' },
        source: { kind: 'default' as const },
      }),
      questionStore,
      broker,
      gitOps,
      worktreeManager: wtm,
      getProjectName: () => 'fixture',
    });
    dispatcherRef.current = dispatcher;

    dispatcher.onFinalize(fakeOkFinalize(fixture.branchName), {
      workerId: 'wk-1',
      branch: fixture.branchName,
      projectPath: fixture.localDir,
      worktreePath: fixture.worktreePath,
      mergeToSpecified: false,
    });
    await vi.waitFor(() => {
      expect(events.find((e) => e.kind === 'asked')).toBeDefined();
    });

    const q = questionStore.list({ answered: false })[0]!;
    questionStore.answer(q.id, 'n');
    await dispatcher.shutdown();

    expect(events.find((e) => e.kind === 'declined')).toBeDefined();
    expect(events.find((e) => e.kind === 'merged')).toBeUndefined();

    // Verify the worktree is STILL on disk (declined → preserve).
    const worktreeStillExists = await fs
      .stat(fixture.worktreePath)
      .then(() => true)
      .catch(() => false);
    expect(worktreeStillExists).toBe(true);

    // Verify the remote did NOT receive the merge.
    const { stdout: log } = await execFileAsync(
      'git',
      ['log', 'master', '--oneline'],
      { cwd: fixture.remoteDir },
    );
    expect(log).not.toMatch(/Merge/);
  }, 30_000);

  it("mode='never' emits 'ready' event without enqueueing a question", async () => {
    fixture = await setupGitFixture();
    const broker = createAutoMergeBroker();
    const events: AutoMergeEvent[] = [];
    broker.subscribe((e) => events.push(e));

    const questionStore = new QuestionRegistry();
    const wtm = new WorktreeManager();

    const dispatcher = createAutoMergeDispatcher({
      loadConfig: async (): Promise<LoadResult> => ({
        config: { ...defaultConfig(), autoMerge: 'never' },
        source: { kind: 'default' as const },
      }),
      questionStore,
      broker,
      gitOps,
      worktreeManager: wtm,
      getProjectName: () => 'fixture',
    });

    dispatcher.onFinalize(fakeOkFinalize(fixture.branchName), {
      workerId: 'wk-1',
      branch: fixture.branchName,
      projectPath: fixture.localDir,
      worktreePath: fixture.worktreePath,
      mergeToSpecified: false,
    });
    await dispatcher.shutdown();

    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe('ready');
    expect(questionStore.list().length).toBe(0);
  }, 30_000);
});
