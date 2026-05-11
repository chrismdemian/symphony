import { describe, expect, it } from 'vitest';
import {
  CircularBuffer,
  WorkerRegistry,
  toPersisted,
  type WorkerRecord,
} from '../../src/orchestrator/worker-registry.js';
import type {
  PersistedWorkerRecord,
  WorkerStore,
  WorkerStoreUpdatePatch,
} from '../../src/state/sqlite-worker-store.js';
import type { StreamEvent, TokenUsage, Worker, WorkerExitInfo } from '../../src/workers/types.js';

function makeFakeWorker(id = 'wk-test'): Worker {
  return {
    id,
    sessionId: undefined,
    status: 'spawning',
    events: (async function* () {})(),
    sendFollowup() {},
    endInput() {},
    kill() {},
    waitForExit: async () => ({
      status: 'completed',
      exitCode: 0,
      signal: null,
      durationMs: 0,
    }),
  };
}

function makeRecord(overrides: Partial<WorkerRecord> = {}): WorkerRecord {
  return {
    id: overrides.id ?? 'wk-1',
    projectPath: overrides.projectPath ?? '/tmp/p',
    projectId: overrides.projectId ?? 'p1',
    taskId: overrides.taskId ?? null,
    worktreePath: overrides.worktreePath ?? '/tmp/p/.symphony/worktrees/wk-1',
    role: overrides.role ?? 'implementer',
    featureIntent: overrides.featureIntent ?? 'do-thing',
    taskDescription: overrides.taskDescription ?? 'do thing',
    autonomyTier: overrides.autonomyTier ?? 1,
    dependsOn: overrides.dependsOn ?? [],
    createdAt: overrides.createdAt ?? '2026-04-25T00:00:00.000Z',
    status: overrides.status ?? 'spawning',
    worker: overrides.worker ?? makeFakeWorker(overrides.id ?? 'wk-1'),
    buffer: overrides.buffer ?? new CircularBuffer<StreamEvent>(10),
    detach: overrides.detach ?? (() => {}),
    ...(overrides.sessionId !== undefined ? { sessionId: overrides.sessionId } : {}),
    ...(overrides.model !== undefined ? { model: overrides.model } : {}),
    ...(overrides.completedAt !== undefined ? { completedAt: overrides.completedAt } : {}),
    ...(overrides.lastEventAt !== undefined ? { lastEventAt: overrides.lastEventAt } : {}),
    ...(overrides.exitInfo !== undefined ? { exitInfo: overrides.exitInfo } : {}),
  };
}

interface SpyCall {
  readonly op: 'insert' | 'update' | 'delete';
  readonly id: string;
  readonly payload: PersistedWorkerRecord | WorkerStoreUpdatePatch | undefined;
}

function makeSpyStore(): {
  store: WorkerStore;
  calls: SpyCall[];
  rows: Map<string, PersistedWorkerRecord>;
} {
  const calls: SpyCall[] = [];
  const rows = new Map<string, PersistedWorkerRecord>();
  const store: WorkerStore = {
    insert(record) {
      calls.push({ op: 'insert', id: record.id, payload: record });
      rows.set(record.id, record);
    },
    update(id, patch) {
      calls.push({ op: 'update', id, payload: patch });
      const existing = rows.get(id);
      if (!existing) return;
      // Test fake honors the production store's explicit-null semantics:
      // `null` clears the column; absent keys preserve.
      const merged: { -readonly [K in keyof PersistedWorkerRecord]: PersistedWorkerRecord[K] } = {
        ...existing,
      };
      if (patch.status !== undefined) merged.status = patch.status;
      if (patch.sessionId !== undefined) {
        if (patch.sessionId === null) delete (merged as { sessionId?: string }).sessionId;
        else merged.sessionId = patch.sessionId;
      }
      if (patch.completedAt !== undefined) {
        if (patch.completedAt === null) delete (merged as { completedAt?: string }).completedAt;
        else merged.completedAt = patch.completedAt;
      }
      if (patch.lastEventAt !== undefined) {
        if (patch.lastEventAt === null) delete (merged as { lastEventAt?: string }).lastEventAt;
        else merged.lastEventAt = patch.lastEventAt;
      }
      if (patch.exitCode !== undefined) {
        if (patch.exitCode === null) delete (merged as { exitCode?: number | null }).exitCode;
        else merged.exitCode = patch.exitCode;
      }
      if (patch.exitSignal !== undefined) {
        if (patch.exitSignal === null) delete (merged as { exitSignal?: NodeJS.Signals }).exitSignal;
        else merged.exitSignal = patch.exitSignal;
      }
      if (patch.costUsd !== undefined) {
        if (patch.costUsd === null) delete (merged as { costUsd?: number }).costUsd;
        else merged.costUsd = patch.costUsd;
      }
      if (patch.sessionUsage !== undefined) {
        if (patch.sessionUsage === null) {
          delete (merged as { sessionUsage?: TokenUsage }).sessionUsage;
        } else {
          merged.sessionUsage = patch.sessionUsage;
        }
      }
      rows.set(id, merged);
    },
    delete(id) {
      calls.push({ op: 'delete', id, payload: undefined });
      rows.delete(id);
    },
    get(id) {
      return rows.get(id);
    },
    list() {
      return Array.from(rows.values());
    },
    size() {
      return rows.size;
    },
  };
  return { store, calls, rows };
}

describe('WorkerRegistry — write-through to WorkerStore', () => {
  it('register inserts into the store', () => {
    const { store, calls, rows } = makeSpyStore();
    const reg = new WorkerRegistry({ store });
    reg.register(makeRecord({ id: 'wk-1' }));
    expect(calls.length).toBe(1);
    expect(calls[0]?.op).toBe('insert');
    expect(calls[0]?.id).toBe('wk-1');
    expect(rows.get('wk-1')?.status).toBe('spawning');
  });

  it('replace updates status to spawning + forwards sessionId', () => {
    const { store, calls } = makeSpyStore();
    const reg = new WorkerRegistry({ store });
    reg.register(makeRecord({ id: 'wk-1', status: 'completed' }));
    const newWorker = makeFakeWorker('wk-1');
    reg.replace('wk-1', {
      worker: newWorker,
      buffer: new CircularBuffer<StreamEvent>(10),
      detach: () => {},
      sessionId: 'sess-new',
    });
    const update = calls.find((c) => c.op === 'update' && c.id === 'wk-1');
    expect(update?.payload).toMatchObject({
      status: 'spawning',
      sessionId: 'sess-new',
    });
  });

  it('replace clears prior costUsd in memory and SQL (followups M1 audit fix)', () => {
    const { store, calls } = makeSpyStore();
    const reg = new WorkerRegistry({ store });
    reg.register(makeRecord({ id: 'wk-1' }));
    // Simulate the prior run accumulating cost then completing.
    reg.updateCostUsd('wk-1', 0.42);
    const exit: WorkerExitInfo = {
      status: 'completed',
      exitCode: 0,
      signal: null,
      durationMs: 100,
    };
    reg.markCompleted('wk-1', exit, () => 1_000_000_000);
    expect(reg.get('wk-1')?.costUsd).toBe(0.42);

    // Resume — without the fix, record.costUsd would carry the 0.42
    // forward and be re-persisted on the next markCompleted.
    reg.replace('wk-1', {
      worker: makeFakeWorker('wk-1'),
      buffer: new CircularBuffer<StreamEvent>(10),
      detach: () => {},
      sessionId: 'sess-resumed',
    });
    expect(reg.get('wk-1')?.costUsd).toBeUndefined();
    const replaceCall = calls
      .filter((c) => c.op === 'update' && c.id === 'wk-1')
      .at(-1);
    expect(replaceCall?.payload).toMatchObject({
      status: 'spawning',
      completedAt: null,
      exitCode: null,
      exitSignal: null,
      costUsd: null,
    });
  });

  it('updateSessionUsage captures cumulative tokens in memory (Phase 3N.1)', () => {
    const { store } = makeSpyStore();
    const reg = new WorkerRegistry({ store });
    reg.register(makeRecord({ id: 'wk-1' }));
    const usage: TokenUsage = {
      inputTokens: 100,
      outputTokens: 250,
      cacheReadTokens: 50,
      cacheWriteTokens: 10,
    };
    reg.updateSessionUsage('wk-1', usage);
    expect(reg.get('wk-1')?.sessionUsage).toEqual(usage);
  });

  it('updateSessionUsage rejects negatives + non-finite without throwing (3N.1)', () => {
    const reg = new WorkerRegistry();
    reg.register(makeRecord({ id: 'wk-1' }));
    // Negative on any field → reject the whole payload (consistency).
    reg.updateSessionUsage('wk-1', {
      inputTokens: -1,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(reg.get('wk-1')?.sessionUsage).toBeUndefined();
    // Non-finite (Infinity / NaN) → reject.
    reg.updateSessionUsage('wk-1', {
      inputTokens: Number.POSITIVE_INFINITY,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(reg.get('wk-1')?.sessionUsage).toBeUndefined();
    // Valid → accepted.
    reg.updateSessionUsage('wk-1', {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(reg.get('wk-1')?.sessionUsage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  });

  it('markCompleted persists sessionUsage alongside costUsd (3N.1)', () => {
    const { store, calls } = makeSpyStore();
    const reg = new WorkerRegistry({ store });
    reg.register(makeRecord({ id: 'wk-1' }));
    reg.updateCostUsd('wk-1', 0.31);
    reg.updateSessionUsage('wk-1', {
      inputTokens: 12_000,
      outputTokens: 3_400,
      cacheReadTokens: 8_900,
      cacheWriteTokens: 1_100,
    });
    reg.markCompleted(
      'wk-1',
      { status: 'completed', exitCode: 0, signal: null, durationMs: 1234 },
      () => 1_000_000_000,
    );
    const update = calls
      .filter((c) => c.op === 'update' && c.id === 'wk-1')
      .at(-1);
    expect(update?.payload).toMatchObject({
      status: 'completed',
      costUsd: 0.31,
      sessionUsage: {
        inputTokens: 12_000,
        outputTokens: 3_400,
        cacheReadTokens: 8_900,
        cacheWriteTokens: 1_100,
      },
    });
  });

  it('markCompleted writes sessionUsage:null when never observed (3N.1)', () => {
    const { store, calls } = makeSpyStore();
    const reg = new WorkerRegistry({ store });
    reg.register(makeRecord({ id: 'wk-early-crash' }));
    // No updateSessionUsage call — worker died before any `result` event.
    reg.markCompleted(
      'wk-early-crash',
      { status: 'crashed', exitCode: null, signal: 'SIGKILL', durationMs: 50 },
      () => 1_000_000_000,
    );
    const update = calls
      .filter((c) => c.op === 'update' && c.id === 'wk-early-crash')
      .at(-1);
    // Explicit null so a stale row from a prior session can't carry over
    // — mirrors costUsd's null-clear semantics.
    expect((update?.payload as { sessionUsage?: unknown }).sessionUsage).toBeNull();
    expect((update?.payload as { costUsd?: unknown }).costUsd).toBeNull();
  });

  it('replace clears prior sessionUsage in memory and SQL (3N.1, mirrors costUsd)', () => {
    const { store, calls, rows } = makeSpyStore();
    const reg = new WorkerRegistry({ store });
    reg.register(makeRecord({ id: 'wk-1' }));
    reg.updateSessionUsage('wk-1', {
      inputTokens: 1,
      outputTokens: 2,
      cacheReadTokens: 3,
      cacheWriteTokens: 4,
    });
    reg.markCompleted(
      'wk-1',
      { status: 'completed', exitCode: 0, signal: null, durationMs: 1 },
      () => 1_000_000_000,
    );
    expect(rows.get('wk-1')?.sessionUsage).toEqual({
      inputTokens: 1,
      outputTokens: 2,
      cacheReadTokens: 3,
      cacheWriteTokens: 4,
    });
    reg.replace('wk-1', {
      worker: makeFakeWorker('wk-1'),
      buffer: new CircularBuffer<StreamEvent>(10),
      detach: () => {},
      sessionId: 'sess-resumed',
    });
    expect(reg.get('wk-1')?.sessionUsage).toBeUndefined();
    expect(rows.get('wk-1')?.sessionUsage).toBeUndefined();
    const replaceCall = calls
      .filter((c) => c.op === 'update' && c.id === 'wk-1')
      .at(-1);
    expect(replaceCall?.payload).toMatchObject({
      status: 'spawning',
      sessionUsage: null,
    });
  });

  it('markCompleted writes terminal status + exit info', () => {
    const { store, calls } = makeSpyStore();
    const reg = new WorkerRegistry({ store });
    reg.register(makeRecord({ id: 'wk-1' }));
    const exit: WorkerExitInfo = {
      status: 'failed',
      exitCode: 1,
      signal: null,
      sessionId: 'sess-final',
      durationMs: 100,
    };
    reg.markCompleted('wk-1', exit, () => 1_000_000_000);
    const update = calls.find((c) => c.op === 'update' && c.id === 'wk-1');
    expect(update?.payload).toMatchObject({
      status: 'failed',
      exitCode: 1,
      sessionId: 'sess-final',
    });
    expect((update?.payload as WorkerStoreUpdatePatch).completedAt).toBeDefined();
  });

  it('updateSessionId + updateStatus write through; updateLastEventAt is in-memory only (M4 fix)', () => {
    const { store, calls } = makeSpyStore();
    const reg = new WorkerRegistry({ store });
    reg.register(makeRecord({ id: 'wk-1' }));
    reg.updateSessionId('wk-1', 'sess-1');
    reg.updateStatus('wk-1', 'running');
    reg.updateLastEventAt('wk-1', '2026-04-25T00:01:00.000Z');
    const updates = calls.filter((c) => c.op === 'update' && c.id === 'wk-1');
    // Only sessionId + status write through. lastEventAt stays in-memory
    // to avoid a per-event SQL write storm under chatty workers.
    expect(updates.length).toBe(2);
    expect(updates[0]?.payload).toEqual({ sessionId: 'sess-1' });
    expect(updates[1]?.payload).toEqual({ status: 'running' });
    // In-memory was updated; SQL store wasn't asked about lastEventAt.
    expect(reg.get('wk-1')?.lastEventAt).toBe('2026-04-25T00:01:00.000Z');
  });

  it('remove() deletes from the store', () => {
    const { store, calls, rows } = makeSpyStore();
    const reg = new WorkerRegistry({ store });
    reg.register(makeRecord({ id: 'wk-1' }));
    reg.remove('wk-1');
    expect(calls.find((c) => c.op === 'delete' && c.id === 'wk-1')).toBeDefined();
    expect(rows.has('wk-1')).toBe(false);
  });

  it('clear() does NOT touch the store (preserves rows for next-startup recovery)', () => {
    const { store, calls, rows } = makeSpyStore();
    const reg = new WorkerRegistry({ store });
    reg.register(makeRecord({ id: 'wk-1' }));
    reg.register(makeRecord({ id: 'wk-2' }));
    expect(calls.filter((c) => c.op === 'insert').length).toBe(2);
    reg.clear();
    // No deletes from clear — rows are preserved.
    expect(calls.filter((c) => c.op === 'delete').length).toBe(0);
    expect(rows.size).toBe(2);
  });

  it('getStore() exposes the configured store', () => {
    const { store } = makeSpyStore();
    const reg = new WorkerRegistry({ store });
    expect(reg.getStore()).toBe(store);
  });

  it('no-store mode: all mutations work, no writes attempted', () => {
    const reg = new WorkerRegistry();
    reg.register(makeRecord({ id: 'wk-1' }));
    reg.updateStatus('wk-1', 'running');
    reg.markCompleted(
      'wk-1',
      { status: 'completed', exitCode: 0, signal: null, durationMs: 0 },
      () => 0,
    );
    reg.remove('wk-1');
    expect(reg.getStore()).toBeUndefined();
  });
});

describe('toPersisted', () => {
  it('converts a live record to the persisted shape, dropping live-only fields', () => {
    const rec = makeRecord({
      id: 'wk-1',
      projectId: 'p1',
      taskId: 't1',
      sessionId: 'sess',
      model: 'opus',
      lastEventAt: '2026-04-25T00:01:00.000Z',
    });
    const p = toPersisted(rec);
    expect(p).toMatchObject({
      id: 'wk-1',
      projectId: 'p1',
      taskId: 't1',
      sessionId: 'sess',
      model: 'opus',
      lastEventAt: '2026-04-25T00:01:00.000Z',
      worktreePath: rec.worktreePath,
      role: rec.role,
      featureIntent: rec.featureIntent,
    });
    // Type-level: live fields are absent.
    expect((p as unknown as { worker?: unknown }).worker).toBeUndefined();
    expect((p as unknown as { buffer?: unknown }).buffer).toBeUndefined();
    expect((p as unknown as { detach?: unknown }).detach).toBeUndefined();
  });

  it('preserves exitCode/exitSignal from exitInfo when present', () => {
    const rec = makeRecord({
      id: 'wk-1',
      exitInfo: {
        status: 'failed',
        exitCode: 1,
        signal: 'SIGTERM',
        durationMs: 0,
      },
    });
    const p = toPersisted(rec);
    expect(p.exitCode).toBe(1);
    expect(p.exitSignal).toBe('SIGTERM');
  });
});
