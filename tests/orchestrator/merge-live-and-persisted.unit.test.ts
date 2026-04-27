import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ProjectRegistry } from '../../src/projects/registry.js';
import {
  CircularBuffer,
  WorkerRegistry,
  mergeLiveAndPersisted,
  type WorkerRecord,
} from '../../src/orchestrator/worker-registry.js';
import type {
  PersistedWorkerRecord,
  WorkerStore,
  WorkerStoreUpdatePatch,
} from '../../src/state/sqlite-worker-store.js';
import type { StreamEvent, Worker } from '../../src/workers/types.js';

function makeFakeWorker(id = 'wk-test'): Worker {
  return {
    id,
    sessionId: undefined,
    status: 'spawning',
    events: (async function* () {})(),
    sendFollowup() {},
    endInput() {},
    kill() {},
    waitForExit: async () => ({ status: 'completed', exitCode: 0, signal: null, durationMs: 0 }),
  };
}

function makeRecord(overrides: Partial<WorkerRecord> = {}): WorkerRecord {
  return {
    id: overrides.id ?? 'wk-1',
    projectPath: overrides.projectPath ?? '/tmp/p1',
    projectId: overrides.projectId ?? 'p1',
    taskId: overrides.taskId ?? null,
    worktreePath: overrides.worktreePath ?? '/tmp/p1/.symphony/worktrees/wk-1',
    role: overrides.role ?? 'implementer',
    featureIntent: overrides.featureIntent ?? 'do',
    taskDescription: overrides.taskDescription ?? 'do',
    autonomyTier: overrides.autonomyTier ?? 1,
    dependsOn: overrides.dependsOn ?? [],
    createdAt: overrides.createdAt ?? '2026-04-25T00:00:00.000Z',
    status: overrides.status ?? 'running',
    worker: overrides.worker ?? makeFakeWorker(overrides.id ?? 'wk-1'),
    buffer: overrides.buffer ?? new CircularBuffer<StreamEvent>(10),
    detach: overrides.detach ?? (() => {}),
  };
}

function makeStore(initial: PersistedWorkerRecord[] = []): WorkerStore {
  const rows = new Map<string, PersistedWorkerRecord>();
  for (const r of initial) rows.set(r.id, r);
  return {
    insert(record) {
      rows.set(record.id, record);
    },
    update(id, patch: WorkerStoreUpdatePatch) {
      const existing = rows.get(id);
      if (!existing) return;
      const merged: { -readonly [K in keyof PersistedWorkerRecord]: PersistedWorkerRecord[K] } = {
        ...existing,
      };
      if (patch.status !== undefined) merged.status = patch.status;
      if (patch.sessionId !== undefined && patch.sessionId !== null)
        merged.sessionId = patch.sessionId;
      if (patch.completedAt !== undefined && patch.completedAt !== null)
        merged.completedAt = patch.completedAt;
      rows.set(id, merged);
    },
    delete(id) {
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
}

function persistedRow(id: string, overrides: Partial<PersistedWorkerRecord> = {}): PersistedWorkerRecord {
  return {
    id,
    projectId: 'p1',
    taskId: null,
    worktreePath: `/tmp/p1/.symphony/worktrees/${id}`,
    role: 'implementer',
    featureIntent: 'do',
    taskDescription: 'do',
    autonomyTier: 1,
    dependsOn: [],
    status: 'crashed',
    createdAt: '2026-04-24T00:00:00.000Z',
    completedAt: '2026-04-24T00:01:00.000Z',
    ...overrides,
  };
}

describe('mergeLiveAndPersisted', () => {
  it('returns only live snapshots when no store is configured', () => {
    const reg = new WorkerRegistry();
    reg.register(makeRecord({ id: 'wk-live' }));
    const merged = mergeLiveAndPersisted(reg);
    expect(merged.map((r) => r.id)).toEqual(['wk-live']);
  });

  it('merges persisted-only rows (live wins on collision)', () => {
    const store = makeStore([
      persistedRow('wk-historical'),
      persistedRow('wk-live', { status: 'crashed' }), // also exists live
    ]);
    const reg = new WorkerRegistry({ store });
    // Reset insert counter for live record (re-insertion attempts upsert).
    // Use direct register without re-inserting into the store.
    const liveRec = makeRecord({ id: 'wk-live', status: 'running' });
    reg['records'].set(liveRec.id, liveRec);
    const merged = mergeLiveAndPersisted(reg);
    const ids = merged.map((r) => r.id).sort();
    expect(ids).toEqual(['wk-historical', 'wk-live']);
    const live = merged.find((m) => m.id === 'wk-live')!;
    expect(live.status).toBe('running'); // live wins
  });

  it('respects projectPath filter when a projectStore is supplied', () => {
    const p1Path = path.resolve('/tmp/p1');
    const p2Path = path.resolve('/tmp/p2');
    const store = makeStore([
      persistedRow('wk-a', { projectId: 'p1' }),
      persistedRow('wk-b', { projectId: 'p2' }),
    ]);
    const reg = new WorkerRegistry({ store });
    const projectStore = new ProjectRegistry();
    projectStore.register({ id: 'p1', name: 'p1', path: p1Path, createdAt: '' });
    projectStore.register({ id: 'p2', name: 'p2', path: p2Path, createdAt: '' });

    const filteredP1 = mergeLiveAndPersisted(reg, {
      projectStore,
      projectPath: p1Path,
    });
    expect(filteredP1.map((r) => r.id)).toEqual(['wk-a']);
    const filteredP2 = mergeLiveAndPersisted(reg, {
      projectStore,
      projectPath: p2Path,
    });
    expect(filteredP2.map((r) => r.id)).toEqual(['wk-b']);
  });

  it('synthesizes (unregistered) projectPath for orphaned persisted rows', () => {
    const store = makeStore([persistedRow('wk-orphan', { projectId: null })]);
    const reg = new WorkerRegistry({ store });
    const merged = mergeLiveAndPersisted(reg);
    expect(merged.length).toBe(1);
    expect(merged[0]?.projectPath).toBe('(unregistered)');
  });

  it('includeTerminal=false drops persisted-only terminal rows', () => {
    const store = makeStore([
      persistedRow('wk-completed', { status: 'completed' }),
      persistedRow('wk-failed', { status: 'failed' }),
      persistedRow('wk-crashed', { status: 'crashed' }),
      persistedRow('wk-running', { status: 'running' }),
    ]);
    const reg = new WorkerRegistry({ store });
    const onlyActive = mergeLiveAndPersisted(reg, { includeTerminal: false });
    expect(onlyActive.map((r) => r.id)).toEqual(['wk-running']);
  });
});
