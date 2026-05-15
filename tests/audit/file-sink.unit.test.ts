import { describe, it, expect, vi } from 'vitest';
import {
  createAuditFileSink,
  defaultAuditLogPath,
  formatAuditLine,
} from '../../src/audit/file-sink.js';
import type { AuditEntry } from '../../src/state/audit-store.js';

function entry(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    id: 1,
    ts: '2026-05-14T14:23:01.234Z',
    kind: 'worker_spawned',
    severity: 'info',
    projectId: null,
    workerId: null,
    taskId: null,
    toolName: null,
    headline: 'h',
    payload: {},
    ...overrides,
  };
}

describe('formatAuditLine', () => {
  it('formats a minimal entry', () => {
    const line = formatAuditLine(entry({ headline: 'spawn' }));
    expect(line).toBe('2026-05-14T14:23:01.234Z  worker_spawned  info  "spawn"');
  });

  it('includes optional fields when present', () => {
    const line = formatAuditLine(
      entry({
        projectId: 'p1',
        workerId: 'w-abc',
        taskId: 'tk-xyz',
        toolName: 'spawn_worker',
        headline: 'spawn Violin',
      }),
    );
    expect(line).toContain('project=p1');
    expect(line).toContain('worker=w-abc');
    expect(line).toContain('task=tk-xyz');
    expect(line).toContain('tool=spawn_worker');
    expect(line).toContain('"spawn Violin"');
  });

  it('flattens newlines in headline', () => {
    const line = formatAuditLine(entry({ headline: 'line one\nline two\r\nline three' }));
    expect(line).not.toContain('\n');
    expect(line).not.toContain('\r');
    expect(line).toContain('line one line two line three');
  });

  it('escapes double quotes in headline', () => {
    const line = formatAuditLine(entry({ headline: 'said "hello" to user' }));
    expect(line).toContain('\\"hello\\"');
  });

  it('omits empty optional fields', () => {
    const line = formatAuditLine(entry({}));
    expect(line).not.toContain('project=');
    expect(line).not.toContain('worker=');
    expect(line).not.toContain('tool=');
  });
});

describe('createAuditFileSink', () => {
  it('write resolves once the injected writer succeeds', async () => {
    const writer = vi.fn(async () => undefined);
    const sink = createAuditFileSink({ filePath: '/tmp/audit.log', writer });
    await sink.write('line1');
    expect(writer).toHaveBeenCalledWith('/tmp/audit.log', 'line1');
  });

  it('serializes concurrent writes in submission order', async () => {
    const order: string[] = [];
    const writer = vi.fn(async (_filePath: string, line: string) => {
      // Stagger: first write takes longer to ensure ordering matters.
      const delay = line === 'a' ? 10 : 1;
      await new Promise((r) => setTimeout(r, delay));
      order.push(line);
    });
    const sink = createAuditFileSink({ filePath: '/tmp/audit.log', writer });
    await Promise.all([sink.write('a'), sink.write('b'), sink.write('c')]);
    expect(order).toEqual(['a', 'b', 'c']);
  });

  it('write rejection on one line does not poison subsequent writes', async () => {
    let count = 0;
    const writer = vi.fn(async (_filePath: string, line: string) => {
      count += 1;
      if (line === 'fail') throw new Error('boom');
    });
    const sink = createAuditFileSink({ filePath: '/tmp/audit.log', writer });
    await expect(sink.write('ok')).resolves.toBeUndefined();
    await expect(sink.write('fail')).rejects.toThrow('boom');
    await expect(sink.write('after')).resolves.toBeUndefined();
    expect(count).toBe(3);
  });

  it('write becomes a no-op after shutdown', async () => {
    const writer = vi.fn(async () => undefined);
    const sink = createAuditFileSink({ filePath: '/tmp/audit.log', writer });
    await sink.shutdown();
    await sink.write('post-shutdown');
    expect(writer).not.toHaveBeenCalled();
  });

  it('shutdown awaits inflight writes', async () => {
    let resolveWrite: () => void = () => undefined;
    const writer = vi.fn(
      () =>
        new Promise<void>((r) => {
          resolveWrite = r;
        }),
    );
    const sink = createAuditFileSink({ filePath: '/tmp/audit.log', writer });
    const writePromise = sink.write('slow');
    let shutdownResolved = false;
    const shutdownPromise = sink.shutdown().then(() => {
      shutdownResolved = true;
    });
    await new Promise((r) => setImmediate(r));
    expect(shutdownResolved).toBe(false);
    resolveWrite();
    await writePromise;
    await shutdownPromise;
    expect(shutdownResolved).toBe(true);
  });
});

describe('defaultAuditLogPath', () => {
  it('joins symphony data dir with audit.log filename', () => {
    const p = defaultAuditLogPath('/home/test');
    expect(p).toMatch(/audit\.log$/);
    expect(p.replace(/\\/g, '/')).toContain('.symphony');
  });
});
