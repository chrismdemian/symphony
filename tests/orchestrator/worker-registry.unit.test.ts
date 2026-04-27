import { describe, expect, it } from 'vitest';
import {
  CircularBuffer,
  WorkerRegistry,
  toSnapshot,
  type WorkerRecord,
} from '../../src/orchestrator/worker-registry.js';
import type { StreamEvent, Worker, WorkerExitInfo } from '../../src/workers/types.js';

function makeFakeWorker(id = 'wk-test'): Worker {
  return {
    id,
    sessionId: undefined,
    status: 'spawning',
    events: (async function* () {
      /* none */
    })(),
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
    projectId: overrides.projectId ?? null,
    taskId: overrides.taskId ?? null,
    worktreePath: overrides.worktreePath ?? '/tmp/p/.symphony/worktrees/wk-1',
    role: overrides.role ?? 'implementer',
    featureIntent: overrides.featureIntent ?? 'refactor-auth',
    taskDescription: overrides.taskDescription ?? 'refactor auth',
    autonomyTier: overrides.autonomyTier ?? 1,
    dependsOn: overrides.dependsOn ?? [],
    createdAt: overrides.createdAt ?? '2026-04-23T00:00:00.000Z',
    status: overrides.status ?? 'spawning',
    worker: overrides.worker ?? makeFakeWorker(),
    buffer: overrides.buffer ?? new CircularBuffer<StreamEvent>(10),
    detach: overrides.detach ?? (() => {}),
    ...(overrides.sessionId !== undefined ? { sessionId: overrides.sessionId } : {}),
    ...(overrides.model !== undefined ? { model: overrides.model } : {}),
    ...(overrides.completedAt !== undefined ? { completedAt: overrides.completedAt } : {}),
    ...(overrides.exitInfo !== undefined ? { exitInfo: overrides.exitInfo } : {}),
  };
}

describe('CircularBuffer', () => {
  it('rejects non-positive capacity', () => {
    expect(() => new CircularBuffer(0)).toThrow();
    expect(() => new CircularBuffer(-1)).toThrow();
    expect(() => new CircularBuffer(NaN)).toThrow();
  });

  it('keeps only the most recent N items and tracks total seen', () => {
    const buf = new CircularBuffer<number>(3);
    for (let i = 1; i <= 5; i++) buf.push(i);
    expect(buf.size()).toBe(3);
    expect(buf.total()).toBe(5);
    expect(buf.tail(3)).toEqual([3, 4, 5]);
    expect(buf.tail(2)).toEqual([4, 5]);
    expect(buf.tail(10)).toEqual([3, 4, 5]);
    expect(buf.tail(0)).toEqual([]);
  });

  it('clear() resets contents but not total', () => {
    const buf = new CircularBuffer<number>(3);
    buf.push(1);
    buf.push(2);
    buf.clear();
    expect(buf.size()).toBe(0);
    expect(buf.total()).toBe(2); // total is a stream counter, not size
  });
});

describe('WorkerRegistry', () => {
  it('registers + retrieves a record', () => {
    const reg = new WorkerRegistry();
    const r = makeRecord();
    reg.register(r);
    expect(reg.has('wk-1')).toBe(true);
    expect(reg.get('wk-1')).toBe(r);
  });

  it('rejects duplicate id', () => {
    const reg = new WorkerRegistry();
    reg.register(makeRecord());
    expect(() => reg.register(makeRecord())).toThrow(/duplicate worker id/);
  });

  it('list filters by projectPath', () => {
    const reg = new WorkerRegistry();
    reg.register(makeRecord({ id: 'wk-1', projectPath: '/a' }));
    reg.register(makeRecord({ id: 'wk-2', projectPath: '/b' }));
    expect(reg.list({ projectPath: '/a' }).map((r) => r.id)).toEqual(['wk-1']);
    expect(reg.list({ projectPath: '/b' }).map((r) => r.id)).toEqual(['wk-2']);
    expect(reg.list().map((r) => r.id).sort()).toEqual(['wk-1', 'wk-2']);
  });

  it('list filters by status (single or array)', () => {
    const reg = new WorkerRegistry();
    reg.register(makeRecord({ id: 'a', status: 'running' }));
    reg.register(makeRecord({ id: 'b', status: 'completed' }));
    reg.register(makeRecord({ id: 'c', status: 'failed' }));
    expect(reg.list({ status: 'running' }).map((r) => r.id)).toEqual(['a']);
    expect(
      reg
        .list({ status: ['completed', 'failed'] })
        .map((r) => r.id)
        .sort(),
    ).toEqual(['b', 'c']);
  });

  it('find matches on id or featureIntent (case-insensitive)', () => {
    const reg = new WorkerRegistry();
    reg.register(makeRecord({ id: 'wk-auth', featureIntent: 'auth-refactor' }));
    reg.register(makeRecord({ id: 'wk-2', featureIntent: 'liquid-glass-hero' }));
    const byIntent = reg.find('liquid');
    expect(byIntent.map((m) => m.id)).toEqual(['wk-2']);
    expect(byIntent[0]?.matchedBy).toBe('featureIntent');
    const byId = reg.find('wk-auth');
    expect(byId[0]?.matchedBy).toBe('id');
    const noHit = reg.find('nonexistent');
    expect(noHit).toEqual([]);
  });

  it('find returns empty for empty or whitespace query', () => {
    const reg = new WorkerRegistry();
    reg.register(makeRecord({ id: 'wk-1', featureIntent: 'anything' }));
    expect(reg.find('')).toEqual([]);
    expect(reg.find('   ')).toEqual([]);
  });

  it('markCompleted flips status, records exit info, captures sessionId', () => {
    const reg = new WorkerRegistry();
    reg.register(makeRecord({ id: 'wk-x' }));
    const exit: WorkerExitInfo = {
      status: 'completed',
      exitCode: 0,
      signal: null,
      sessionId: 'abc',
      durationMs: 500,
    };
    reg.markCompleted('wk-x', exit, () => 1_700_000_000_000);
    const snap = reg.snapshot('wk-x')!;
    expect(snap.status).toBe('completed');
    expect(snap.sessionId).toBe('abc');
    expect(snap.exitCode).toBe(0);
    expect(snap.completedAt).toBe(new Date(1_700_000_000_000).toISOString());
  });

  it('markCompleted is a no-op on unknown id', () => {
    const reg = new WorkerRegistry();
    expect(() =>
      reg.markCompleted('missing', {
        status: 'completed',
        exitCode: 0,
        signal: null,
        durationMs: 0,
      }),
    ).not.toThrow();
  });

  it('remove() calls detach and removes the record', () => {
    const reg = new WorkerRegistry();
    let detached = 0;
    reg.register(
      makeRecord({
        id: 'wk-r',
        detach: () => {
          detached += 1;
        },
      }),
    );
    reg.remove('wk-r');
    expect(reg.has('wk-r')).toBe(false);
    expect(detached).toBe(1);
    // second remove is a no-op
    expect(() => reg.remove('wk-r')).not.toThrow();
  });

  it('replace() swaps worker handle + resets buffer and status', () => {
    const reg = new WorkerRegistry();
    const buffer = new CircularBuffer<StreamEvent>(10);
    buffer.push({
      type: 'assistant_text',
      text: 'old',
    } as StreamEvent);
    let oldDetach = 0;
    reg.register(
      makeRecord({
        id: 'wk-s',
        status: 'completed',
        buffer,
        detach: () => {
          oldDetach += 1;
        },
        sessionId: 'old-session',
        completedAt: '2026-01-01T00:00:00.000Z',
      }),
    );
    const newWorker = makeFakeWorker('wk-s');
    let newDetach = 0;
    reg.replace('wk-s', {
      worker: newWorker,
      buffer,
      detach: () => {
        newDetach += 1;
      },
      sessionId: 'new-session',
    });
    expect(oldDetach).toBe(1);
    expect(newDetach).toBe(0); // detach not called yet
    const snap = reg.snapshot('wk-s')!;
    expect(snap.status).toBe('spawning');
    expect(snap.sessionId).toBe('new-session');
    expect(snap.completedAt).toBeUndefined();
    expect(buffer.size()).toBe(0);
  });

  it('replace() throws on unknown id', () => {
    const reg = new WorkerRegistry();
    expect(() =>
      reg.replace('nope', { worker: makeFakeWorker(), buffer: new CircularBuffer(2), detach: () => {} }),
    ).toThrow(/unknown worker id/);
  });

  it('clear() detaches every record and empties the map', () => {
    const reg = new WorkerRegistry();
    let detaches = 0;
    for (let i = 0; i < 3; i++) {
      reg.register(
        makeRecord({
          id: `wk-${i}`,
          detach: () => {
            detaches += 1;
          },
        }),
      );
    }
    reg.clear();
    expect(detaches).toBe(3);
    expect(reg.list().length).toBe(0);
  });

  it('snapshot includes sessionId + exit info only when present', () => {
    const reg = new WorkerRegistry();
    reg.register(makeRecord({ id: 'w', sessionId: 'abc' }));
    const snap = reg.snapshot('w')!;
    expect(snap.sessionId).toBe('abc');
    expect(snap.exitCode).toBeUndefined();
    expect(snap.exitSignal).toBeUndefined();
  });
});

describe('toSnapshot', () => {
  it('omits optional fields that are unset', () => {
    const r = makeRecord();
    const s = toSnapshot(r);
    expect(s.sessionId).toBeUndefined();
    expect(s.completedAt).toBeUndefined();
    expect(s.model).toBeUndefined();
  });
});
