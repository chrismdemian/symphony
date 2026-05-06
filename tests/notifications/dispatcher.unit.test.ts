import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  createNotificationDispatcher,
  formatTallyBody,
  truncateBody,
} from '../../src/notifications/dispatcher.js';
import type {
  DispatcherDeps,
  DispatcherHandle,
  ToastInput,
} from '../../src/notifications/types.js';
import type { LoadResult } from '../../src/utils/config.js';
import type { WorkerRecord } from '../../src/orchestrator/worker-registry.js';
import type { QuestionRecord } from '../../src/state/question-registry.js';
import { defaultConfig, type SymphonyConfig } from '../../src/utils/config-schema.js';

/**
 * Phase 3H.3 — dispatcher policy engine tests.
 *
 * The dispatcher is decoupled from the platform — these tests inject a
 * fake `loadConfig` (per-test config builder) + a vi.fn `spawnToast` and
 * assert on what would have been spawned (counts, titles, bodies). No
 * real PowerShell / osascript / notify-send is touched.
 *
 * Async-shape note: `onWorkerExit` and `onQuestion` are sync-fire-and-
 * forget from the lifecycle's perspective, but internally they `await
 * loadConfig()` (because the fresh-config-per-call rule). Tests use
 * `vi.waitFor` to settle the dispatcher's internal microtasks before
 * assertion. Real production has no such wait — the lifecycle's
 * `wireExit` already runs in a `.then` chain.
 */

// ── Helpers ──────────────────────────────────────────────────────────

interface Harness {
  dispatcher: DispatcherHandle;
  spawnToast: ReturnType<typeof vi.fn>;
  setConfig(patch: Partial<SymphonyConfig>): void;
  flushPending(): Promise<void>;
}

function buildConfig(patch: Partial<SymphonyConfig> = {}): SymphonyConfig {
  return { ...defaultConfig(), ...patch };
}

function makeHarness(initial: Partial<SymphonyConfig> = {}): Harness {
  let current: SymphonyConfig = buildConfig({
    notifications: { enabled: true },
    ...initial,
  });
  const spawnToast = vi.fn().mockResolvedValue(undefined);
  const deps: DispatcherDeps = {
    loadConfig: async (): Promise<LoadResult> => ({
      config: current,
      source: { kind: 'default' },
    }),
    spawnToast: spawnToast as unknown as (input: ToastInput) => Promise<void>,
    getProjectName: (id) => (id === null ? '(default)' : `proj-${id}`),
    isTTY: () => true,
    isCI: () => false,
  };
  const dispatcher = createNotificationDispatcher(deps);
  return {
    dispatcher,
    spawnToast,
    setConfig: (patch) => {
      current = buildConfig({ ...current, ...patch });
    },
    flushPending: async () => {
      // Walk a few microtasks + a setImmediate to drain the
      // probe→dispatch chain. Mirrors the harness shape used in the
      // 3D.1 / 3E unit tests.
      for (let i = 0; i < 16; i += 1) {
         
        await Promise.resolve();
      }
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

function makeRecord(overrides: Partial<WorkerRecord> = {}): WorkerRecord {
  // Cast through `unknown` because we only need the fields the
  // dispatcher reads — production WorkerRecord is much wider.
  return {
    id: 'wk-test',
    projectPath: '/proj',
    projectId: 'proj-1',
    taskId: null,
    worktreePath: '/proj/.symphony/worktrees/wk-test',
    role: 'implementer',
    featureIntent: 'wire friend system endpoints',
    taskDescription: 'Friend system',
    autonomyTier: 1 as const,
    dependsOn: [],
    createdAt: new Date(0).toISOString(),
    status: 'completed',
    buffer: { total: () => 0 } as never,
    worker: {} as never,
    detach: () => {},
    ...overrides,
  } as WorkerRecord;
}

function makeQuestion(overrides: Partial<QuestionRecord> = {}): QuestionRecord {
  return {
    id: 'q-test',
    question: 'Pick a port?',
    urgency: 'blocking',
    askedAt: new Date(0).toISOString(),
    answered: false,
    ...overrides,
  } as QuestionRecord;
}

// ── Helper-fn coverage ───────────────────────────────────────────────

describe('formatTallyBody', () => {
  it('omits zero-count parts', () => {
    expect(formatTallyBody({ completed: 3, failed: 0, questions: 0 })).toBe('3 completed');
    expect(formatTallyBody({ completed: 0, failed: 1, questions: 0 })).toBe('1 failed');
    expect(formatTallyBody({ completed: 0, failed: 0, questions: 1 })).toBe('1 question');
  });

  it('joins multiple parts with comma-space', () => {
    expect(formatTallyBody({ completed: 2, failed: 1, questions: 3 })).toBe(
      '2 completed, 1 failed, 3 questions',
    );
  });

  it('pluralizes questions but not completed/failed (which are participles)', () => {
    expect(formatTallyBody({ completed: 1, failed: 1, questions: 1 })).toBe(
      '1 completed, 1 failed, 1 question',
    );
    expect(formatTallyBody({ completed: 5, failed: 5, questions: 5 })).toBe(
      '5 completed, 5 failed, 5 questions',
    );
  });
});

describe('truncateBody', () => {
  it('passes through bodies at or below the 120-char cap', () => {
    expect(truncateBody('a'.repeat(120))).toBe('a'.repeat(120));
  });

  it('truncates with an ellipsis at exactly 120 chars total', () => {
    const out = truncateBody('a'.repeat(200));
    expect(out).toHaveLength(120);
    expect(out.endsWith('…')).toBe(true);
  });
});

// ── Suppression matrix ───────────────────────────────────────────────

describe('dispatcher — hard suppression', () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });

  it('skips when notifications.enabled is false', async () => {
    h.setConfig({ notifications: { enabled: false } });
    h.dispatcher.onWorkerExit(makeRecord({ status: 'failed' }), 0);
    await h.flushPending();
    expect(h.spawnToast).not.toHaveBeenCalled();
  });

  it('skips when isTTY returns false (parent is non-TTY)', async () => {
    const spawnToast = vi.fn().mockResolvedValue(undefined);
    const dispatcher = createNotificationDispatcher({
      loadConfig: async () => ({
        config: buildConfig({ notifications: { enabled: true } }),
        source: { kind: 'default' },
      }),
      spawnToast,
      getProjectName: () => 'p',
      isTTY: () => false,
      isCI: () => false,
    });
    dispatcher.onWorkerExit(makeRecord({ status: 'failed' }), 0);
    for (let i = 0; i < 16; i += 1) {
       
      await Promise.resolve();
    }
    await new Promise((resolve) => setImmediate(resolve));
    expect(spawnToast).not.toHaveBeenCalled();
  });

  it('skips when isCI returns true', async () => {
    const spawnToast = vi.fn().mockResolvedValue(undefined);
    const dispatcher = createNotificationDispatcher({
      loadConfig: async () => ({
        config: buildConfig({ notifications: { enabled: true } }),
        source: { kind: 'default' },
      }),
      spawnToast,
      getProjectName: () => 'p',
      isTTY: () => true,
      isCI: () => true,
    });
    dispatcher.onWorkerExit(makeRecord({ status: 'failed' }), 0);
    for (let i = 0; i < 16; i += 1) {
       
      await Promise.resolve();
    }
    await new Promise((resolve) => setImmediate(resolve));
    expect(spawnToast).not.toHaveBeenCalled();
  });

  it('failed config-load is silently swallowed and routed to onError', async () => {
    const spawnToast = vi.fn().mockResolvedValue(undefined);
    const onError = vi.fn();
    const dispatcher = createNotificationDispatcher({
      loadConfig: async () => {
        throw new Error('disk full');
      },
      spawnToast,
      getProjectName: () => 'p',
      isTTY: () => true,
      isCI: () => false,
      onError,
    });
    dispatcher.onWorkerExit(makeRecord({ status: 'failed' }), 0);
    for (let i = 0; i < 16; i += 1) {
       
      await Promise.resolve();
    }
    await new Promise((resolve) => setImmediate(resolve));
    expect(spawnToast).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalled();
  });
});

// ── Restraint policy ─────────────────────────────────────────────────

describe('dispatcher — restraint policy', () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });

  it('failed: fires individual toast immediately', async () => {
    h.dispatcher.onWorkerExit(makeRecord({ status: 'failed', featureIntent: 'foo' }), 1);
    await h.flushPending();
    expect(h.spawnToast).toHaveBeenCalledTimes(1);
    expect(h.spawnToast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Symphony · proj-proj-1',
        body: 'failed: foo',
      }),
    );
  });

  it('crashed: fires individual toast immediately (treated as failure)', async () => {
    h.dispatcher.onWorkerExit(makeRecord({ status: 'crashed', featureIntent: 'foo' }), 1);
    await h.flushPending();
    expect(h.spawnToast).toHaveBeenCalledTimes(1);
    expect(h.spawnToast).toHaveBeenCalledWith(
      expect.objectContaining({ body: 'crashed: foo' }),
    );
  });

  it('timeout: fires with "timed out" verb', async () => {
    h.dispatcher.onWorkerExit(makeRecord({ status: 'timeout', featureIntent: 'foo' }), 1);
    await h.flushPending();
    expect(h.spawnToast).toHaveBeenCalledTimes(1);
    expect(h.spawnToast).toHaveBeenCalledWith(
      expect.objectContaining({ body: 'timed out: foo' }),
    );
  });

  it('completed: does NOT fire individually (counts toward all-done only)', async () => {
    h.dispatcher.onWorkerExit(makeRecord({ status: 'completed', featureIntent: 'foo' }), 1);
    await h.flushPending();
    expect(h.spawnToast).not.toHaveBeenCalled();
  });

  it('killed: fires nothing (user-initiated)', async () => {
    h.dispatcher.onWorkerExit(makeRecord({ status: 'killed' }), 0);
    await h.flushPending();
    expect(h.spawnToast).not.toHaveBeenCalled();
  });
});

// ── All-done semantics ───────────────────────────────────────────────

describe('dispatcher — all-done emit', () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });

  it('fires "Symphony · all done" when totalRunning hits 0 with non-empty tally', async () => {
    h.dispatcher.onWorkerExit(makeRecord({ id: 'wk-1', status: 'completed' }), 2);
    h.dispatcher.onWorkerExit(makeRecord({ id: 'wk-2', status: 'completed' }), 1);
    h.dispatcher.onWorkerExit(makeRecord({ id: 'wk-3', status: 'completed' }), 0);
    await h.flushPending();
    // Only the all-done toast fires (no individual completion toasts).
    expect(h.spawnToast).toHaveBeenCalledTimes(1);
    expect(h.spawnToast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Symphony · all done',
        body: '3 completed',
      }),
    );
  });

  it('combines failures + completions + questions into the all-done body', async () => {
    h.dispatcher.onQuestion(makeQuestion());
    h.dispatcher.onWorkerExit(makeRecord({ id: 'wk-1', status: 'failed', featureIntent: 'a' }), 2);
    h.dispatcher.onWorkerExit(makeRecord({ id: 'wk-2', status: 'completed' }), 1);
    h.dispatcher.onWorkerExit(makeRecord({ id: 'wk-3', status: 'completed' }), 0);
    await h.flushPending();
    // Question fired individually (1) + failure fired individually (2) + all-done (3)
    expect(h.spawnToast).toHaveBeenCalledTimes(3);
    expect(h.spawnToast).toHaveBeenLastCalledWith(
      expect.objectContaining({
        title: 'Symphony · all done',
        body: '2 completed, 1 failed, 1 question',
      }),
    );
  });

  it('resets tally after emit so a second batch reports its own counts', async () => {
    h.dispatcher.onWorkerExit(makeRecord({ id: 'wk-1', status: 'completed' }), 0);
    await h.flushPending();
    expect(h.spawnToast).toHaveBeenCalledTimes(1);
    expect(h.spawnToast).toHaveBeenLastCalledWith(
      expect.objectContaining({ body: '1 completed' }),
    );
    h.dispatcher.onWorkerExit(makeRecord({ id: 'wk-2', status: 'completed' }), 0);
    await h.flushPending();
    expect(h.spawnToast).toHaveBeenCalledTimes(2);
    expect(h.spawnToast).toHaveBeenLastCalledWith(
      expect.objectContaining({ body: '1 completed' }),
    );
  });

  it('does NOT fire all-done when totalRunning > 0', async () => {
    h.dispatcher.onWorkerExit(makeRecord({ status: 'completed' }), 1);
    await h.flushPending();
    expect(h.spawnToast).not.toHaveBeenCalled();
  });

  it('does NOT fire all-done when tally is empty (e.g. only killed workers exited)', async () => {
    h.dispatcher.onWorkerExit(makeRecord({ id: 'wk-1', status: 'killed' }), 0);
    await h.flushPending();
    expect(h.spawnToast).not.toHaveBeenCalled();
  });
});

// ── Question handling ────────────────────────────────────────────────

describe('dispatcher — questions', () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });

  it('blocking question fires individual toast', async () => {
    h.dispatcher.onQuestion(
      makeQuestion({ projectId: 'proj-1', question: 'Auth method?' }),
    );
    await h.flushPending();
    expect(h.spawnToast).toHaveBeenCalledTimes(1);
    expect(h.spawnToast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Symphony · proj-proj-1',
        body: 'needs input: Auth method?',
      }),
    );
  });

  it('non-blocking urgency does not fire', async () => {
    h.dispatcher.onQuestion(makeQuestion({ urgency: 'advisory' }));
    await h.flushPending();
    expect(h.spawnToast).not.toHaveBeenCalled();
  });
});

// ── Away mode ────────────────────────────────────────────────────────

describe('dispatcher — awayMode', () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness({ awayMode: true });
  });

  it('does not fire individually while awayMode is on', async () => {
    h.dispatcher.onWorkerExit(makeRecord({ status: 'failed' }), 1);
    h.dispatcher.onWorkerExit(makeRecord({ status: 'completed' }), 0);
    h.dispatcher.onQuestion(makeQuestion());
    await h.flushPending();
    expect(h.spawnToast).not.toHaveBeenCalled();
  });

  it('flushAwayDigest emits one digest summarizing the buffered counts', async () => {
    h.dispatcher.onWorkerExit(makeRecord({ status: 'failed' }), 2);
    h.dispatcher.onWorkerExit(makeRecord({ status: 'completed' }), 1);
    h.dispatcher.onWorkerExit(makeRecord({ status: 'completed' }), 0);
    h.dispatcher.onQuestion(makeQuestion());
    await h.flushPending();
    await h.dispatcher.flushAwayDigest();
    expect(h.spawnToast).toHaveBeenCalledTimes(1);
    expect(h.spawnToast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Symphony · digest',
        body: '2 completed, 1 failed, 1 question',
      }),
    );
  });

  it('flushAwayDigest is a no-op on empty buffer', async () => {
    await h.dispatcher.flushAwayDigest();
    expect(h.spawnToast).not.toHaveBeenCalled();
  });

  it('flushAwayDigest resets tally — a second flush is a no-op', async () => {
    h.dispatcher.onWorkerExit(makeRecord({ status: 'failed' }), 0);
    await h.flushPending();
    await h.dispatcher.flushAwayDigest();
    expect(h.spawnToast).toHaveBeenCalledTimes(1);
    await h.dispatcher.flushAwayDigest();
    expect(h.spawnToast).toHaveBeenCalledTimes(1);
  });

  it('toggling awayMode off does NOT auto-flush — TUI must call flushAwayDigest', async () => {
    h.dispatcher.onWorkerExit(makeRecord({ status: 'failed' }), 0);
    await h.flushPending();
    expect(h.spawnToast).not.toHaveBeenCalled();
    h.setConfig({ awayMode: false });
    // No new event arrives — the dispatcher does NOT poll.
    await h.flushPending();
    expect(h.spawnToast).not.toHaveBeenCalled();
  });
});

// ── Shutdown ─────────────────────────────────────────────────────────

describe('dispatcher — shutdown', () => {
  it('shutdown flushes a non-empty tally as a final digest (awayMode on)', async () => {
    const h = makeHarness({ awayMode: true });
    h.dispatcher.onWorkerExit(makeRecord({ status: 'failed' }), 0);
    await h.flushPending();
    expect(h.spawnToast).not.toHaveBeenCalled();
    await h.dispatcher.shutdown();
    expect(h.spawnToast).toHaveBeenCalledTimes(1);
    expect(h.spawnToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Symphony · digest' }),
    );
  });

  it('shutdown emits all-done style when awayMode is off but tally has entries', async () => {
    // Edge case: a worker exited with completed but totalRunning was
    // non-zero at that moment (e.g. another spawn raced). Shutdown
    // should drain the leftover tally as an all-done.
    const h = makeHarness({ awayMode: false });
    h.dispatcher.onWorkerExit(makeRecord({ status: 'completed' }), 1);
    await h.flushPending();
    expect(h.spawnToast).not.toHaveBeenCalled();
    await h.dispatcher.shutdown();
    expect(h.spawnToast).toHaveBeenCalledTimes(1);
    expect(h.spawnToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Symphony · all done' }),
    );
  });

  it('shutdown resets tally even when probe fails', async () => {
    const spawnToast = vi.fn().mockResolvedValue(undefined);
    let throwOnLoad = false;
    const dispatcher = createNotificationDispatcher({
      loadConfig: async () => {
        if (throwOnLoad) throw new Error('disk');
        return {
          config: buildConfig({ notifications: { enabled: true } }),
          source: { kind: 'default' },
        };
      },
      spawnToast,
      getProjectName: () => 'p',
      isTTY: () => true,
      isCI: () => false,
    });
    dispatcher.onWorkerExit(makeRecord({ status: 'failed' }), 1);
    for (let i = 0; i < 16; i += 1) {
       
      await Promise.resolve();
    }
    await new Promise((resolve) => setImmediate(resolve));
    // One immediate failure-fire, none yet for all-done.
    expect(spawnToast).toHaveBeenCalledTimes(1);
    throwOnLoad = true;
    await dispatcher.shutdown();
    // Probe failed in shutdown → no extra emit, tally still gets reset.
    expect(spawnToast).toHaveBeenCalledTimes(1);
  });

  it('post-shutdown calls are short-circuited (audit Major-2)', async () => {
    // Workers that fail during the close window between
    // dispatcher.shutdown() and lifecycle.shutdown()'s SIGTERM round
    // would otherwise re-enter the dispatcher and spawn orphan toast
    // processes after the orchestrator is otherwise tearing down.
    const h = makeHarness({ awayMode: false });
    await h.dispatcher.shutdown();
    h.spawnToast.mockClear();
    h.dispatcher.onWorkerExit(makeRecord({ status: 'failed' }), 0);
    h.dispatcher.onQuestion(makeQuestion());
    await h.flushPending();
    expect(h.spawnToast).not.toHaveBeenCalled();
    // flushAwayDigest is also a no-op post-shutdown.
    await h.dispatcher.flushAwayDigest();
    expect(h.spawnToast).not.toHaveBeenCalled();
    // Idempotent: a second shutdown is a no-op (no double-flush).
    await h.dispatcher.shutdown();
    expect(h.spawnToast).not.toHaveBeenCalled();
  });
});

// ── Body truncation ──────────────────────────────────────────────────

describe('dispatcher — body truncation', () => {
  it('passes truncated body to spawnToast (>120 → 120 with ellipsis)', async () => {
    const h = makeHarness();
    const long = 'a'.repeat(200);
    h.dispatcher.onWorkerExit(makeRecord({ status: 'failed', featureIntent: long }), 0);
    await h.flushPending();
    // Failure fire + all-done both happened; the failure body is the
    // truncated one (verb+intent), the all-done body is "1 failed".
    expect(h.spawnToast).toHaveBeenCalledTimes(2);
    const failedCall = h.spawnToast.mock.calls[0]![0] as ToastInput;
    expect(failedCall.body.length).toBeLessThanOrEqual(120);
    expect(failedCall.body.endsWith('…')).toBe(true);
  });
});
