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
