import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createAutoMergeDispatcher } from '../../src/orchestrator/auto-merge-dispatcher.js';
import { AutoMergeBrokerImpl } from '../../src/orchestrator/auto-merge-broker.js';
import {
  GitOpsError,
  MergeConflictError,
} from '../../src/orchestrator/git-ops.js';
import { QuestionRegistry } from '../../src/state/question-registry.js';
import { defaultConfig } from '../../src/utils/config-schema.js';
import type { AutoMergeEvent } from '../../src/orchestrator/auto-merge-types.js';
import type { AutoMergeGitOps, WorktreeRemover } from '../../src/orchestrator/auto-merge-helper.js';
import type { LoadResult } from '../../src/utils/config.js';
import type { FinalizeCallbackContext } from '../../src/orchestrator/tools/finalize.js';
import type { FinalizeRunResult } from '../../src/orchestrator/finalize-runner.js';

/**
 * Phase 3O.1 — AutoMergeDispatcher unit tests.
 *
 * The dispatcher composes config-read, question-store, broker, gitOps,
 * and worktree manager. All deps are injected so tests can exercise the
 * routing logic without real git / sqlite / disk.
 *
 * `resolveDefaultMergeTo` is called against the (fake) repoPath; we
 * stub it OUT by relying on the master fallback (since the fake
 * project paths aren't real git repos). Tests assert the dispatcher's
 * behavior, not the resolver's.
 */

interface Harness {
  readonly questionStore: QuestionRegistry;
  readonly broker: AutoMergeBrokerImpl;
  readonly events: AutoMergeEvent[];
  readonly merge: ReturnType<typeof vi.fn>;
  readonly remove: ReturnType<typeof vi.fn>;
  readonly getProjectName: ReturnType<typeof vi.fn>;
  readonly loadConfig: ReturnType<typeof vi.fn>;
  readonly onError: ReturnType<typeof vi.fn>;
  readonly dispatcher: ReturnType<typeof createAutoMergeDispatcher>;
}

function makeHarness(opts: {
  autoMerge?: 'ask' | 'auto' | 'never';
  mergeImpl?: AutoMergeGitOps['mergeBranch'];
  removeImpl?: WorktreeRemover['remove'];
}): Harness {
  const questionStore = new QuestionRegistry();
  const broker = new AutoMergeBrokerImpl();
  const events: AutoMergeEvent[] = [];
  broker.subscribe((e) => events.push(e));

  const merge = vi.fn(
    opts.mergeImpl ??
      (async () => ({
        mergeSha: 'm'.repeat(40),
        targetBranch: 'master',
        sourceBranch: 'feature/x',
        deletedRemoteBranch: true,
      })),
  );
  const remove = vi.fn(opts.removeImpl ?? (async () => undefined));
  const getProjectName = vi.fn(() => 'DemoProject');
  const loadConfig = vi.fn(
    async (): Promise<LoadResult> => ({
      config: { ...defaultConfig(), autoMerge: opts.autoMerge ?? 'ask' },
      source: { kind: 'default' as const },
    }),
  );
  const onError = vi.fn();

  // Wire the question store's onAnswered hook through the dispatcher.
  // QuestionRegistry has the option; we set it up by constructing
  // a new store and patching the hook after dispatcher creation —
  // since the dispatcher exposes the `onQuestionAnswered` method we
  // can directly invoke it OR wire it through the store.

  const dispatcher = createAutoMergeDispatcher({
    questionStore,
    broker,
    gitOps: { mergeBranch: merge as unknown as AutoMergeGitOps['mergeBranch'] },
    worktreeManager: { remove: remove as unknown as WorktreeRemover['remove'] },
    getProjectName,
    loadConfig,
    onError,
    now: () => 1_700_000_000_000,
  });

  return {
    questionStore,
    broker,
    events,
    merge,
    remove,
    getProjectName,
    loadConfig,
    onError,
    dispatcher,
  };
}

function okFinalize(): FinalizeRunResult {
  return {
    ok: true,
    featureBranch: 'feature/x',
    commitSha: 'c'.repeat(40),
    steps: [],
  };
}

function finalizeCtx(overrides: Partial<FinalizeCallbackContext> = {}): FinalizeCallbackContext {
  return {
    workerId: 'wk-1',
    branch: 'feature/x',
    projectPath: '/tmp/proj',
    worktreePath: '/tmp/wt',
    mergeToSpecified: false,
    ...overrides,
  };
}

async function waitForEvent(events: AutoMergeEvent[], min = 1, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (events.length < min && Date.now() - start < timeoutMs) {
    await new Promise((r) => setImmediate(r));
  }
}

describe('AutoMergeDispatcher — onFinalize routing', () => {
  it("mode='never' emits 'ready' event; no merge call", async () => {
    const h = makeHarness({ autoMerge: 'never' });
    h.dispatcher.onFinalize(okFinalize(), finalizeCtx());
    await waitForEvent(h.events);
    expect(h.events).toHaveLength(1);
    expect(h.events[0]!.kind).toBe('ready');
    expect(h.events[0]!.headline).toMatch(/manual merge/);
    expect(h.merge).not.toHaveBeenCalled();
  });

  it("mode='auto' invokes merge + remove on success; emits 'merged' with sha", async () => {
    const h = makeHarness({ autoMerge: 'auto' });
    h.dispatcher.onFinalize(okFinalize(), finalizeCtx());
    await h.dispatcher.shutdown(); // drains inflight merge
    expect(h.merge).toHaveBeenCalledTimes(1);
    expect(h.remove).toHaveBeenCalledTimes(1);
    expect(h.remove).toHaveBeenCalledWith('/tmp/wt', { deleteBranch: true });
    expect(h.events).toHaveLength(1);
    expect(h.events[0]!.kind).toBe('merged');
    expect(h.events[0]!.mergeSha).toBe('m'.repeat(40));
    expect(h.events[0]!.headline).toMatch(/Merged/);
  });

  it("mode='auto' on MergeConflictError emits 'failed'; worktree NOT removed", async () => {
    const h = makeHarness({
      autoMerge: 'auto',
      mergeImpl: async () => {
        throw new MergeConflictError('conflict', 'CONFLICT', 1);
      },
    });
    h.dispatcher.onFinalize(okFinalize(), finalizeCtx());
    await h.dispatcher.shutdown();
    expect(h.events).toHaveLength(1);
    expect(h.events[0]!.kind).toBe('failed');
    expect(h.events[0]!.reason).toMatch(/MergeConflictError/);
    expect(h.remove).not.toHaveBeenCalled();
  });

  it("mode='auto' with cleanup failure emits 'merged' with cleanupWarning (merge wins)", async () => {
    const h = makeHarness({
      autoMerge: 'auto',
      removeImpl: async () => {
        throw new Error('worktree busy');
      },
    });
    h.dispatcher.onFinalize(okFinalize(), finalizeCtx());
    await h.dispatcher.shutdown();
    expect(h.events).toHaveLength(1);
    expect(h.events[0]!.kind).toBe('merged');
    expect(h.events[0]!.cleanupWarning).toMatch(/worktree busy/);
  });

  it("mode='ask' enqueues a blocking question + emits 'asked' event", async () => {
    const h = makeHarness({ autoMerge: 'ask' });
    h.dispatcher.onFinalize(okFinalize(), finalizeCtx());
    await waitForEvent(h.events);
    expect(h.events).toHaveLength(1);
    expect(h.events[0]!.kind).toBe('asked');
    expect(h.events[0]!.headline).toMatch(/Merge into/);
    const queued = h.questionStore.list({ answered: false });
    expect(queued).toHaveLength(1);
    expect(queued[0]!.urgency).toBe('blocking');
    expect(queued[0]!.workerId).toBe('wk-1');
    expect(h.merge).not.toHaveBeenCalled();
  });

  it("mode='ask' + answer='y' triggers merge; emits 'merged'", async () => {
    const h = makeHarness({ autoMerge: 'ask' });
    h.dispatcher.onFinalize(okFinalize(), finalizeCtx());
    await waitForEvent(h.events);
    const queued = h.questionStore.list({ answered: false });
    const q = queued[0]!;
    // Simulate the QuestionStore → dispatcher answer hook.
    const answered = h.questionStore.answer(q.id, 'y');
    h.dispatcher.onQuestionAnswered(answered);
    await h.dispatcher.shutdown();
    expect(h.merge).toHaveBeenCalledTimes(1);
    const mergedEvent = h.events.find((e) => e.kind === 'merged');
    expect(mergedEvent).toBeDefined();
    expect(mergedEvent!.mergeSha).toBe('m'.repeat(40));
  });

  it("mode='ask' + answer='no' emits 'declined'; NO merge call", async () => {
    const h = makeHarness({ autoMerge: 'ask' });
    h.dispatcher.onFinalize(okFinalize(), finalizeCtx());
    await waitForEvent(h.events);
    const q = h.questionStore.list({ answered: false })[0]!;
    const answered = h.questionStore.answer(q.id, 'no');
    h.dispatcher.onQuestionAnswered(answered);
    await h.dispatcher.shutdown();
    expect(h.merge).not.toHaveBeenCalled();
    const declined = h.events.find((e) => e.kind === 'declined');
    expect(declined).toBeDefined();
    expect(declined!.unclearAnswer).toBeUndefined();
  });

  it("mode='ask' + unclear answer ('maybe') fail-safes to 'declined' with unclearAnswer", async () => {
    const h = makeHarness({ autoMerge: 'ask' });
    h.dispatcher.onFinalize(okFinalize(), finalizeCtx());
    await waitForEvent(h.events);
    const q = h.questionStore.list({ answered: false })[0]!;
    const answered = h.questionStore.answer(q.id, 'maybe');
    h.dispatcher.onQuestionAnswered(answered);
    await h.dispatcher.shutdown();
    expect(h.merge).not.toHaveBeenCalled();
    const declined = h.events.find((e) => e.kind === 'declined');
    expect(declined).toBeDefined();
    expect(declined!.unclearAnswer).toBe('maybe');
    expect(declined!.headline).toMatch(/Couldn't parse 'maybe'/);
  });

  it('mergeToSpecified=true short-circuits the dispatcher (Maestro already merged)', async () => {
    const h = makeHarness({ autoMerge: 'auto' });
    h.dispatcher.onFinalize(okFinalize(), finalizeCtx({ mergeToSpecified: true }));
    await h.dispatcher.shutdown();
    expect(h.merge).not.toHaveBeenCalled();
    expect(h.events).toHaveLength(0);
    expect(h.loadConfig).not.toHaveBeenCalled();
  });

  it('result.ok=false short-circuits the dispatcher (defensive)', async () => {
    const h = makeHarness({ autoMerge: 'auto' });
    h.dispatcher.onFinalize(
      { ok: false, featureBranch: 'feature/x', steps: [], failedAt: 'test' },
      finalizeCtx(),
    );
    await h.dispatcher.shutdown();
    expect(h.merge).not.toHaveBeenCalled();
    expect(h.events).toHaveLength(0);
  });

  it('answer to an unknown question id is silently ignored (not ours)', async () => {
    const h = makeHarness({ autoMerge: 'ask' });
    // No prior onFinalize → pendingAsks is empty.
    h.questionStore.enqueue({ question: 'unrelated question' });
    const q = h.questionStore.list({ answered: false })[0]!;
    const answered = h.questionStore.answer(q.id, 'y');
    h.dispatcher.onQuestionAnswered(answered);
    await h.dispatcher.shutdown();
    expect(h.merge).not.toHaveBeenCalled();
    expect(h.events).toHaveLength(0);
  });
});

describe('AutoMergeDispatcher — disposed/shutdown', () => {
  it('post-shutdown onFinalize is a no-op', async () => {
    const h = makeHarness({ autoMerge: 'auto' });
    await h.dispatcher.shutdown();
    h.dispatcher.onFinalize(okFinalize(), finalizeCtx());
    // Microtask flush to let any rogue async chain run.
    await new Promise((r) => setImmediate(r));
    expect(h.merge).not.toHaveBeenCalled();
    expect(h.events).toHaveLength(0);
  });

  it('post-shutdown onQuestionAnswered is a no-op', async () => {
    const h = makeHarness({ autoMerge: 'ask' });
    h.dispatcher.onFinalize(okFinalize(), finalizeCtx());
    await waitForEvent(h.events);
    const q = h.questionStore.list({ answered: false })[0]!;
    await h.dispatcher.shutdown();
    const answered = h.questionStore.answer(q.id, 'y');
    h.dispatcher.onQuestionAnswered(answered);
    await new Promise((r) => setImmediate(r));
    expect(h.merge).not.toHaveBeenCalled();
  });

  it('shutdown awaits in-flight merges', async () => {
    let resolveMerge: (() => void) | undefined;
    const h = makeHarness({
      autoMerge: 'auto',
      mergeImpl: () =>
        new Promise((r) => {
          resolveMerge = (): void =>
            r({
              mergeSha: 'a'.repeat(40),
              targetBranch: 'master',
              sourceBranch: 'feature/x',
              deletedRemoteBranch: true,
            });
        }),
    });
    h.dispatcher.onFinalize(okFinalize(), finalizeCtx());
    // Let the dispatcher reach the merge call.
    await new Promise((r) => setImmediate(r));
    let shutdownResolved = false;
    const shutdownPromise = h.dispatcher.shutdown().then(() => {
      shutdownResolved = true;
    });
    await new Promise((r) => setImmediate(r));
    expect(shutdownResolved).toBe(false);
    resolveMerge!();
    await shutdownPromise;
    expect(shutdownResolved).toBe(true);
  });

  it('shutdown is idempotent', async () => {
    const h = makeHarness({ autoMerge: 'auto' });
    await h.dispatcher.shutdown();
    await expect(h.dispatcher.shutdown()).resolves.toBeUndefined();
  });
});

describe('AutoMergeDispatcher — config-load failure path', () => {
  let originalConsoleError: typeof console.error;
  beforeEach(() => {
    originalConsoleError = console.error;
    console.error = (): void => undefined;
  });

  it('loadConfig throw routes to onError without crashing', async () => {
    const onError = vi.fn();
    const dispatcher = createAutoMergeDispatcher({
      questionStore: new QuestionRegistry(),
      broker: new AutoMergeBrokerImpl(),
      gitOps: { mergeBranch: vi.fn() as unknown as AutoMergeGitOps['mergeBranch'] },
      worktreeManager: { remove: vi.fn() as unknown as WorktreeRemover['remove'] },
      getProjectName: () => 'p',
      loadConfig: vi.fn(async () => {
        throw new Error('config read borked');
      }),
      onError,
    });
    dispatcher.onFinalize(okFinalize(), finalizeCtx());
    await dispatcher.shutdown();
    expect(onError).toHaveBeenCalled();
    console.error = originalConsoleError;
  });

  it('onFinalize a GitOpsError (push reject) emits failed', async () => {
    const h = makeHarness({
      autoMerge: 'auto',
      mergeImpl: async () => {
        throw new GitOpsError('git push rejected', {
          stderr: '! [rejected] master',
          exitCode: 1,
        });
      },
    });
    h.dispatcher.onFinalize(okFinalize(), finalizeCtx());
    await h.dispatcher.shutdown();
    expect(h.events).toHaveLength(1);
    expect(h.events[0]!.kind).toBe('failed');
    expect(h.events[0]!.reason).toMatch(/GitOpsError/);
  });
});

describe('AutoMergeBroker (3O.1)', () => {
  it('fans out to multiple subscribers in registration order', () => {
    const b = new AutoMergeBrokerImpl();
    const order: number[] = [];
    b.subscribe(() => order.push(1));
    b.subscribe(() => order.push(2));
    b.subscribe(() => order.push(3));
    b.publish({
      kind: 'ready',
      workerId: 'w',
      branch: 'b',
      projectName: 'p',
      mergeTo: 'master',
      headline: 'h',
      ts: '2026-05-12T00:00:00.000Z',
    });
    expect(order).toEqual([1, 2, 3]);
  });

  it('unsubscribe drops the listener', () => {
    const b = new AutoMergeBrokerImpl();
    const seen: AutoMergeEvent[] = [];
    const off = b.subscribe((e) => seen.push(e));
    off();
    b.publish({
      kind: 'ready',
      workerId: 'w',
      branch: 'b',
      projectName: 'p',
      mergeTo: 'master',
      headline: 'h',
      ts: '2026-05-12T00:00:00.000Z',
    });
    expect(seen).toHaveLength(0);
  });

  it('faulty listener does NOT poison fan-out for siblings', () => {
    const b = new AutoMergeBrokerImpl();
    const good: AutoMergeEvent[] = [];
    b.subscribe(() => {
      throw new Error('boom');
    });
    b.subscribe((e) => good.push(e));
    b.publish({
      kind: 'ready',
      workerId: 'w',
      branch: 'b',
      projectName: 'p',
      mergeTo: 'master',
      headline: 'h',
      ts: '2026-05-12T00:00:00.000Z',
    });
    expect(good).toHaveLength(1);
  });

  it('clear() drops all listeners', () => {
    const b = new AutoMergeBrokerImpl();
    b.subscribe(() => {});
    b.subscribe(() => {});
    expect(b.subscriberCount()).toBe(2);
    b.clear();
    expect(b.subscriberCount()).toBe(0);
  });
});
