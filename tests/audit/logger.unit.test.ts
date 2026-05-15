import { describe, it, expect, vi } from 'vitest';
import { createAuditLogger } from '../../src/audit/logger.js';
import type {
  AuditAppendInput,
  AuditEntry,
  AuditListFilter,
  AuditStore,
} from '../../src/state/audit-store.js';
import type { AuditFileSink } from '../../src/audit/types.js';

function fakeStore(): AuditStore & { rows: AuditEntry[] } {
  const rows: AuditEntry[] = [];
  let nextId = 1;
  return {
    rows,
    append(input: AuditAppendInput): AuditEntry {
      const entry: AuditEntry = {
        id: nextId++,
        ts: input.ts,
        kind: input.kind,
        severity: input.severity ?? 'info',
        projectId: input.projectId ?? null,
        workerId: input.workerId ?? null,
        taskId: input.taskId ?? null,
        toolName: input.toolName ?? null,
        headline: input.headline,
        payload: Object.freeze({ ...(input.payload ?? {}) }),
      };
      rows.push(entry);
      return entry;
    },
    list(_filter?: AuditListFilter): AuditEntry[] {
      return [...rows].reverse();
    },
    count(_filter?: AuditListFilter): number {
      return rows.length;
    },
  };
}

function fakeFileSink(): AuditFileSink & { writes: string[] } {
  const writes: string[] = [];
  return {
    writes,
    write: async (line: string) => {
      writes.push(line);
    },
    shutdown: async () => undefined,
  };
}

describe('AuditLogger', () => {
  it('sanitizes string payload values by default', () => {
    const store = fakeStore();
    const logger = createAuditLogger({ store });
    logger.append({
      ts: 't1',
      kind: 'tool_called',
      headline: 'h',
      payload: { secret: 'sk_test_a1b2c3d4e5f6g7h8' },
    });
    const row = store.rows[0];
    expect(row?.payload['secret']).toMatch(/^\w{3,4}\*{3}\w{3,4}$/);
    expect(row?.payload['secret']).not.toContain('a1b2c3d4');
  });

  it('rawKeys bypass sanitization', () => {
    const store = fakeStore();
    const logger = createAuditLogger({ store });
    logger.append(
      {
        ts: 't1',
        kind: 'merge_performed',
        headline: 'merged',
        payload: { sha: 'a1b2c3d4e5f6g7h8', projectName: 'MathScrabble' },
      },
      { rawKeys: ['sha', 'projectName'] },
    );
    expect(store.rows[0]?.payload['sha']).toBe('a1b2c3d4e5f6g7h8');
    expect(store.rows[0]?.payload['projectName']).toBe('MathScrabble');
  });

  it('sanitizes nested object payloads recursively', () => {
    const store = fakeStore();
    const logger = createAuditLogger({ store });
    logger.append({
      ts: 't1',
      kind: 'tool_called',
      headline: 'h',
      payload: {
        meta: {
          token: 'sk_test_a1b2c3d4e5f6g7h8',
          email: 'john.doe@example.com',
        },
      },
    });
    const meta = store.rows[0]?.payload['meta'] as Record<string, string>;
    expect(meta.token).not.toContain('a1b2c3d4');
    expect(meta.email).toBe('j***e@example.com');
  });

  it('sanitizes arrays element-wise', () => {
    const store = fakeStore();
    const logger = createAuditLogger({ store });
    logger.append({
      ts: 't1',
      kind: 'tool_called',
      headline: 'h',
      payload: { tokens: ['ok_word', 'sk_test_a1b2c3d4e5f6g7h8'] },
    });
    const tokens = store.rows[0]?.payload['tokens'] as string[];
    expect(tokens[0]).toBe('ok_word');
    expect(tokens[1]).not.toContain('a1b2c3d4');
  });

  it('preserves headline as-is (caller responsibility)', () => {
    const store = fakeStore();
    const logger = createAuditLogger({ store });
    logger.append({
      ts: 't1',
      kind: 'worker_spawned',
      headline: 'spawn Violin in MathScrabble (priority 1)',
    });
    expect(store.rows[0]?.headline).toBe('spawn Violin in MathScrabble (priority 1)');
  });

  it('appends a line to the file sink on success', async () => {
    const store = fakeStore();
    const fileSink = fakeFileSink();
    const logger = createAuditLogger({ store, fileSink });
    logger.append({
      ts: '2026-05-14T12:00:00.000Z',
      kind: 'worker_spawned',
      headline: 'spawn',
    });
    // file sink is fire-and-forget; flush via microtask
    await new Promise((r) => setImmediate(r));
    expect(fileSink.writes).toHaveLength(1);
    expect(fileSink.writes[0]).toContain('worker_spawned');
    expect(fileSink.writes[0]).toContain('"spawn"');
  });

  it('returns null and skips writes after shutdown', async () => {
    const store = fakeStore();
    const fileSink = fakeFileSink();
    const logger = createAuditLogger({ store, fileSink });
    await logger.shutdown();
    const result = logger.append({
      ts: 't1',
      kind: 'worker_spawned',
      headline: 'h',
    });
    expect(result).toBeNull();
    await new Promise((r) => setImmediate(r));
    expect(store.rows).toHaveLength(0);
    expect(fileSink.writes).toHaveLength(0);
  });

  it('store throw surfaces through onError and returns null', () => {
    const store: AuditStore = {
      append: () => {
        throw new Error('boom');
      },
      list: () => [],
      count: () => 0,
    };
    const onError = vi.fn();
    const logger = createAuditLogger({ store, onError });
    const result = logger.append({ ts: 't1', kind: 'error', headline: 'h' });
    expect(result).toBeNull();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(Error);
  });

  it('file-sink throw surfaces through onError but entry still persists', async () => {
    const store = fakeStore();
    const fileSink: AuditFileSink = {
      write: async () => {
        throw new Error('disk full');
      },
      shutdown: async () => undefined,
    };
    const onError = vi.fn();
    const logger = createAuditLogger({ store, fileSink, onError });
    const entry = logger.append({ ts: 't1', kind: 'worker_spawned', headline: 'h' });
    expect(entry).not.toBeNull();
    expect(store.rows).toHaveLength(1);
    await new Promise((r) => setImmediate(r));
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('uses deps.now() when input.ts is empty', () => {
    const store = fakeStore();
    const logger = createAuditLogger({ store, now: () => '2030-01-01T00:00:00.000Z' });
    logger.append({ ts: '', kind: 'worker_spawned', headline: 'h' });
    expect(store.rows[0]?.ts).toBe('2030-01-01T00:00:00.000Z');
  });

  it('M1: cyclic payload does not blow the stack — emits [Circular]', () => {
    const store = fakeStore();
    const logger = createAuditLogger({ store });
    const cyclic: Record<string, unknown> = { name: 'root' };
    cyclic['self'] = cyclic;
    const entry = logger.append({
      ts: 't1',
      kind: 'error',
      headline: 'h',
      payload: { data: cyclic },
    });
    expect(entry).not.toBeNull();
    const data = store.rows[0]?.payload['data'] as Record<string, unknown>;
    expect(data['self']).toBe('[Circular]');
  });

  it('M1: a shared sibling (DAG, not cycle) is NOT flagged circular', () => {
    const store = fakeStore();
    const logger = createAuditLogger({ store });
    const shared = { v: 'leaf_word' };
    logger.append({
      ts: 't1',
      kind: 'error',
      headline: 'h',
      payload: { a: shared, b: shared },
    });
    const p = store.rows[0]?.payload as Record<string, Record<string, string>>;
    expect(p['a']?.['v']).toBe('leaf_word');
    expect(p['b']?.['v']).toBe('leaf_word');
  });

  it('M1: over-deep nesting is truncated to [too deep]', () => {
    const store = fakeStore();
    const logger = createAuditLogger({ store });
    // 10 levels deep; cap is 8.
    let deep: Record<string, unknown> = { leaf: 'x' };
    for (let i = 0; i < 10; i += 1) deep = { child: deep };
    logger.append({ ts: 't1', kind: 'error', headline: 'h', payload: { deep } });
    const serialized = JSON.stringify(store.rows[0]?.payload);
    expect(serialized).toContain('[too deep]');
  });

  it('M2: Date / Error / Map non-plain objects are labelled, not mangled to {}', () => {
    const store = fakeStore();
    const logger = createAuditLogger({ store });
    logger.append({
      ts: 't1',
      kind: 'error',
      headline: 'h',
      payload: {
        when: new Date('2026-05-14T12:00:00.000Z'),
        err: new Error('disk full'),
        m: new Map([['k', 'v']]),
      },
    });
    const p = store.rows[0]?.payload as Record<string, unknown>;
    expect(p['when']).toBe('2026-05-14T12:00:00.000Z');
    expect(String(p['err'])).toContain('disk full');
    expect(String(p['m'])).toContain('Map size=1');
  });

  it('shutdown is idempotent', async () => {
    const fileSink = fakeFileSink();
    const shutdownSpy = vi.spyOn(fileSink, 'shutdown');
    const logger = createAuditLogger({ store: fakeStore(), fileSink });
    await logger.shutdown();
    await logger.shutdown();
    expect(shutdownSpy).toHaveBeenCalledTimes(1);
  });
});
