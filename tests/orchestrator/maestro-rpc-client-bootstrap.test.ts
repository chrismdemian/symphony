import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  awaitRpcReady,
  RpcReadyTimeoutError,
  RpcReadyAbortedError,
} from '../../src/orchestrator/maestro/rpc-client-bootstrap.js';
import type { RpcDescriptor } from '../../src/rpc/auth.js';

let sandbox: string;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'symphony-rpc-bootstrap-'));
});

afterEach(() => {
  try {
    rmSync(sandbox, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

const SAMPLE: RpcDescriptor = {
  host: '127.0.0.1',
  port: 12345,
  token: 'tok-abc',
  pid: process.pid,
  startedAt: new Date('2026-04-29T00:00:00Z').toISOString(),
};

function writeDescriptor(filePath: string, descriptor: RpcDescriptor = SAMPLE): void {
  mkdirSync(join(sandbox, '.symphony'), { recursive: true });
  writeFileSync(filePath, JSON.stringify(descriptor, null, 2), 'utf8');
}

describe('awaitRpcReady', () => {
  it('returns the descriptor immediately when the file already exists', async () => {
    const descriptorPath = join(sandbox, '.symphony', 'rpc.json');
    writeDescriptor(descriptorPath);
    const desc = await awaitRpcReady({ descriptorPath, timeoutMs: 1_000 });
    expect(desc.port).toBe(SAMPLE.port);
    expect(desc.token).toBe(SAMPLE.token);
    expect(desc.descriptorPath).toBe(descriptorPath);
  });

  it('waits for the descriptor to be written and returns it', async () => {
    const descriptorPath = join(sandbox, '.symphony', 'rpc.json');
    const promise = awaitRpcReady({ descriptorPath, timeoutMs: 5_000 });
    setTimeout(() => writeDescriptor(descriptorPath), 200);
    const desc = await promise;
    expect(desc.port).toBe(SAMPLE.port);
  });

  it('throws RpcReadyTimeoutError when the file never appears', async () => {
    const descriptorPath = join(sandbox, '.symphony', 'rpc.json');
    await expect(awaitRpcReady({ descriptorPath, timeoutMs: 250 })).rejects.toBeInstanceOf(
      RpcReadyTimeoutError,
    );
  });

  it('honors AbortSignal pre-aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    const descriptorPath = join(sandbox, '.symphony', 'rpc.json');
    await expect(
      awaitRpcReady({ descriptorPath, timeoutMs: 5_000, signal: ac.signal }),
    ).rejects.toBeInstanceOf(RpcReadyAbortedError);
  });

  it('aborts mid-wait when the signal fires', async () => {
    const ac = new AbortController();
    const descriptorPath = join(sandbox, '.symphony', 'rpc.json');
    const promise = awaitRpcReady({ descriptorPath, timeoutMs: 5_000, signal: ac.signal });
    setTimeout(() => ac.abort(), 100);
    await expect(promise).rejects.toBeInstanceOf(RpcReadyAbortedError);
  });

  it('tolerates and ignores a malformed descriptor (treats as not-yet-ready)', async () => {
    const descriptorPath = join(sandbox, '.symphony', 'rpc.json');
    mkdirSync(join(sandbox, '.symphony'), { recursive: true });
    writeFileSync(descriptorPath, '{ this is not json', 'utf8');
    // Then write a valid one shortly after.
    setTimeout(() => writeDescriptor(descriptorPath), 200);
    const desc = await awaitRpcReady({ descriptorPath, timeoutMs: 5_000 });
    expect(desc.port).toBe(SAMPLE.port);
  });

  it('skips descriptors whose pid does not match acceptOnlyPid', async () => {
    const descriptorPath = join(sandbox, '.symphony', 'rpc.json');
    writeDescriptor(descriptorPath, { ...SAMPLE, pid: 99999 });
    setTimeout(() => writeDescriptor(descriptorPath, { ...SAMPLE, pid: 12345 }), 200);
    const desc = await awaitRpcReady({
      descriptorPath,
      timeoutMs: 5_000,
      acceptOnlyPid: 12345,
    });
    expect(desc.pid).toBe(12345);
  });

  it('surfaces the captured advert in RpcReadyTimeoutError (audit M2)', async () => {
    const descriptorPath = join(sandbox, '.symphony', 'rpc.json');
    let calls = 0;
    const advert = { event: 'symphony.rpc.ready', host: '127.0.0.1', port: 4242 };
    let err: unknown;
    try {
      await awaitRpcReady({
        descriptorPath,
        timeoutMs: 250,
        capturedAdvert: () => {
          calls += 1;
          return advert;
        },
      });
    } catch (caught) {
      err = caught;
    }
    expect(err).toBeInstanceOf(RpcReadyTimeoutError);
    expect((err as RpcReadyTimeoutError).capturedAdvert).toEqual(advert);
    expect((err as Error).message).toContain('"symphony.rpc.ready"');
    expect((err as Error).message).toContain('"port":4242');
    expect(calls).toBeGreaterThan(0);
  });

  it('omits advert text when capturedAdvert returns undefined', async () => {
    const descriptorPath = join(sandbox, '.symphony', 'rpc.json');
    let err: unknown;
    try {
      await awaitRpcReady({
        descriptorPath,
        timeoutMs: 250,
        capturedAdvert: () => undefined,
      });
    } catch (caught) {
      err = caught;
    }
    expect(err).toBeInstanceOf(RpcReadyTimeoutError);
    expect((err as RpcReadyTimeoutError).capturedAdvert).toBeUndefined();
    expect((err as Error).message).toContain('No `symphony.rpc.ready` advert was captured');
  });

  it('fires onStaleDescriptor when pid mismatch persists (audit 2C.1 m7)', async () => {
    const descriptorPath = join(sandbox, '.symphony', 'rpc.json');
    writeDescriptor(descriptorPath, { ...SAMPLE, pid: 99999 });
    const stale: Array<{ foundPid: number; expectedPid: number }> = [];
    setTimeout(() => writeDescriptor(descriptorPath, { ...SAMPLE, pid: 12345 }), 350);
    const desc = await awaitRpcReady({
      descriptorPath,
      timeoutMs: 5_000,
      acceptOnlyPid: 12345,
      onStaleDescriptor: (info) => stale.push(info),
    });
    expect(desc.pid).toBe(12345);
    // We expect at least one mismatch observation while pid was 99999.
    expect(stale.length).toBeGreaterThan(0);
    expect(stale[0]?.foundPid).toBe(99999);
    expect(stale[0]?.expectedPid).toBe(12345);
  });

  it('handles a unlink-then-rewrite (stale descriptor cleared by mcp-server restart)', async () => {
    const descriptorPath = join(sandbox, '.symphony', 'rpc.json');
    writeDescriptor(descriptorPath, { ...SAMPLE, pid: 11111 });
    setTimeout(() => {
      try {
        unlinkSync(descriptorPath);
      } catch {
        // ignore
      }
      setTimeout(() => writeDescriptor(descriptorPath, { ...SAMPLE, pid: 22222 }), 50);
    }, 100);
    const desc = await awaitRpcReady({
      descriptorPath,
      timeoutMs: 5_000,
      acceptOnlyPid: 22222,
    });
    expect(desc.pid).toBe(22222);
  });
});
