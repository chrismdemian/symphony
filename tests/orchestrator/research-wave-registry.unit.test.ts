import { describe, expect, it } from 'vitest';
import {
  UnknownWaveError,
  WaveRegistry,
  toWaveSnapshot,
} from '../../src/orchestrator/research-wave-registry.js';

function fixedIdGenerator(seed: string[]): () => string {
  let i = 0;
  return () => {
    const next = seed[i];
    i += 1;
    if (next === undefined) throw new Error('seed exhausted');
    return next;
  };
}

describe('WaveRegistry.enqueue', () => {
  it('records topic + workerIds + startedAt', () => {
    const r = new WaveRegistry({ idGenerator: fixedIdGenerator(['wave-a']) });
    const w = r.enqueue({ topic: 'pnpm workspaces', workerIds: ['wk-1', 'wk-2'] });
    expect(w).toMatchObject({
      id: 'wave-a',
      topic: 'pnpm workspaces',
      workerIds: ['wk-1', 'wk-2'],
    });
    expect(w.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}/);
    expect(w.finishedAt).toBeUndefined();
  });

  it('stores optional projectId', () => {
    const r = new WaveRegistry({ idGenerator: fixedIdGenerator(['wave-b']) });
    const w = r.enqueue({ topic: 'x', workerIds: ['wk-1'], projectId: 'alpha' });
    expect(w.projectId).toBe('alpha');
  });

  it('rejects empty topic', () => {
    const r = new WaveRegistry();
    expect(() => r.enqueue({ topic: '', workerIds: ['wk-1'] })).toThrow(/required/);
    expect(() => r.enqueue({ topic: '  ', workerIds: ['wk-1'] })).toThrow(/required/);
  });

  it('rejects empty workerIds', () => {
    const r = new WaveRegistry();
    expect(() => r.enqueue({ topic: 'x', workerIds: [] })).toThrow(/workerId/);
  });

  it('rejects duplicate workerIds', () => {
    const r = new WaveRegistry();
    expect(() => r.enqueue({ topic: 'x', workerIds: ['wk-1', 'wk-1'] })).toThrow(/duplicate/);
  });

  it('copies workerIds (caller mutation does not leak)', () => {
    const r = new WaveRegistry({ idGenerator: fixedIdGenerator(['wave-a']) });
    const input = ['wk-1', 'wk-2'];
    const w = r.enqueue({ topic: 't', workerIds: input });
    input.push('wk-3');
    expect(w.workerIds).toEqual(['wk-1', 'wk-2']);
  });
});

describe('WaveRegistry.markFinished', () => {
  it('stamps finishedAt once; subsequent calls are idempotent', () => {
    let t = Date.UTC(2026, 3, 23, 10, 0, 0);
    const r = new WaveRegistry({
      idGenerator: fixedIdGenerator(['wave-a']),
      now: () => t,
    });
    const w = r.enqueue({ topic: 't', workerIds: ['wk-1'] });
    t += 5_000;
    const first = r.markFinished(w.id);
    expect(first.finishedAt).toBeDefined();
    const firstStamp = first.finishedAt;
    t += 5_000;
    const second = r.markFinished(w.id);
    expect(second.finishedAt).toBe(firstStamp);
  });

  it('throws for unknown wave', () => {
    const r = new WaveRegistry();
    expect(() => r.markFinished('wave-nope')).toThrow(UnknownWaveError);
  });
});

describe('WaveRegistry.list / snapshots', () => {
  it('filters by projectId and finished', () => {
    const r = new WaveRegistry({
      idGenerator: fixedIdGenerator(['wave-1', 'wave-2', 'wave-3']),
    });
    r.enqueue({ topic: 'a', workerIds: ['wk-1'], projectId: 'p1' });
    const w2 = r.enqueue({ topic: 'b', workerIds: ['wk-2'], projectId: 'p1' });
    r.enqueue({ topic: 'c', workerIds: ['wk-3'], projectId: 'p2' });
    r.markFinished(w2.id);

    expect(r.list({ projectId: 'p1' }).length).toBe(2);
    expect(r.list({ finished: true }).length).toBe(1);
    expect(r.list({ finished: false }).length).toBe(2);
    expect(r.list({ projectId: 'p1', finished: false }).length).toBe(1);
  });

  it('snapshot includes size', () => {
    const r = new WaveRegistry({ idGenerator: fixedIdGenerator(['wave-a']) });
    const w = r.enqueue({ topic: 't', workerIds: ['wk-1', 'wk-2', 'wk-3'] });
    const snap = r.snapshot(w.id);
    expect(snap?.size).toBe(3);
  });

  it('toWaveSnapshot omits undefined optionals', () => {
    const r = new WaveRegistry({ idGenerator: fixedIdGenerator(['wave-a']) });
    const w = r.enqueue({ topic: 't', workerIds: ['wk-1'] });
    const snap = toWaveSnapshot(w);
    expect('projectId' in snap).toBe(false);
    expect('finishedAt' in snap).toBe(false);
  });
});

describe('WaveRegistry id-generation', () => {
  it('retries on collision', () => {
    const r = new WaveRegistry({
      idGenerator: fixedIdGenerator(['wave-dup', 'wave-dup', 'wave-unique']),
    });
    r.enqueue({ topic: 'a', workerIds: ['wk-1'] });
    const second = r.enqueue({ topic: 'b', workerIds: ['wk-2'] });
    expect(second.id).toBe('wave-unique');
  });

  it('throws after 8 consecutive collisions', () => {
    const seed = Array.from({ length: 10 }, () => 'wave-stuck');
    const r = new WaveRegistry({ idGenerator: fixedIdGenerator(seed) });
    r.enqueue({ topic: 'a', workerIds: ['wk-1'] });
    expect(() => r.enqueue({ topic: 'b', workerIds: ['wk-2'] })).toThrow(/collisions/);
  });
});
