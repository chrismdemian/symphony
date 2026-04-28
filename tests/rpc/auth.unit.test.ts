import { describe, expect, it } from 'vitest';
import { mkdtemp, stat, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  compareTokens,
  generateRpcToken,
  RPC_TOKEN_BYTES,
  RPC_TOKEN_ENV,
  UnauthorizedError,
  defaultRpcTokenFilePath,
  deleteRpcDescriptor,
  readRpcDescriptor,
  validateAuthHeader,
  validateQueryToken,
  writeRpcDescriptor,
  type RpcDescriptor,
} from '../../src/rpc/auth.js';

const isWin32 = process.platform === 'win32';

describe('rpc/auth — token generation', () => {
  it('returns 64 hex chars (32 bytes) when env is unset', () => {
    const token = generateRpcToken({});
    expect(token).toHaveLength(RPC_TOKEN_BYTES * 2);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it('returns the env override when SYMPHONY_RPC_TOKEN is set', () => {
    expect(generateRpcToken({ [RPC_TOKEN_ENV]: 'fixed-token' })).toBe('fixed-token');
  });

  it('trims whitespace around env-provided tokens', () => {
    expect(generateRpcToken({ [RPC_TOKEN_ENV]: '  abc  ' })).toBe('abc');
  });

  it('falls back to random generation when env value is empty/whitespace', () => {
    const token = generateRpcToken({ [RPC_TOKEN_ENV]: '   ' });
    expect(token).toHaveLength(RPC_TOKEN_BYTES * 2);
  });

  it('produces distinct tokens across calls', () => {
    expect(generateRpcToken({})).not.toBe(generateRpcToken({}));
  });
});

describe('rpc/auth — compareTokens (timingSafeEqual semantics)', () => {
  it('returns true on exact match', () => {
    expect(compareTokens('abc', 'abc')).toBe(true);
  });

  it('returns false on mismatch', () => {
    expect(compareTokens('abc', 'xyz')).toBe(false);
  });

  it('returns false on length mismatch (no throw)', () => {
    expect(compareTokens('abc', 'abcd')).toBe(false);
  });

  it('returns false on non-string inputs', () => {
    expect(compareTokens(null as unknown as string, 'abc')).toBe(false);
    expect(compareTokens('abc', undefined as unknown as string)).toBe(false);
  });
});

describe('rpc/auth — validateAuthHeader', () => {
  it('accepts a matching Bearer token', () => {
    expect(() => validateAuthHeader('Bearer secret', 'secret')).not.toThrow();
  });

  it('is case-insensitive on the Bearer scheme', () => {
    expect(() => validateAuthHeader('bearer secret', 'secret')).not.toThrow();
  });

  it('throws Unauthorized on missing header', () => {
    expect(() => validateAuthHeader(undefined, 'secret')).toThrowError(UnauthorizedError);
  });

  it('throws Unauthorized on malformed header', () => {
    expect(() => validateAuthHeader('Basic abc', 'secret')).toThrowError(UnauthorizedError);
  });

  it('throws Unauthorized on token mismatch', () => {
    expect(() => validateAuthHeader('Bearer wrong', 'secret')).toThrowError(/token mismatch/);
  });
});

describe('rpc/auth — validateQueryToken', () => {
  it('accepts a matching ?token= parameter', () => {
    expect(() => validateQueryToken('/?token=secret', 'secret')).not.toThrow();
  });

  it('throws on missing url', () => {
    expect(() => validateQueryToken(undefined, 'secret')).toThrowError(UnauthorizedError);
  });

  it('throws on missing query string', () => {
    expect(() => validateQueryToken('/', 'secret')).toThrowError(/token query parameter/);
  });

  it('throws on missing token parameter', () => {
    expect(() => validateQueryToken('/?other=1', 'secret')).toThrowError(/token query parameter/);
  });

  it('throws on token mismatch', () => {
    expect(() => validateQueryToken('/?token=wrong', 'secret')).toThrowError(/token mismatch/);
  });
});

describe('rpc/auth — descriptor file persistence', () => {
  async function tmpFile(): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), 'symphony-rpc-auth-'));
    return path.join(dir, 'rpc.json');
  }

  it('writes a descriptor with mode 0o600 (POSIX) — readable on round-trip', async () => {
    const file = await tmpFile();
    const desc: RpcDescriptor = {
      host: '127.0.0.1',
      port: 1234,
      token: 't',
      pid: 99,
      startedAt: '2026-04-28T00:00:00.000Z',
    };
    const written = await writeRpcDescriptor(desc, file);
    expect(path.resolve(file)).toBe(written);
    const round = await readRpcDescriptor(file);
    expect(round).toEqual(desc);
    if (!isWin32) {
      const info = await stat(file);
      // 0o600 → mode bits 0o600 in the lower 9.
      expect((info.mode & 0o777).toString(8)).toBe('600');
    }
    await unlink(file);
  });

  it.skipIf(isWin32)(
    'enforces 0o600 even when a pre-existing file has loose perms (Audit M1)',
    async () => {
      const file = await tmpFile();
      // Create a pre-existing 0o644 file (world-readable).
      const { writeFile, chmod } = await import('node:fs/promises');
      await writeFile(file, 'leftover', 'utf8');
      await chmod(file, 0o644);
      // writeRpcDescriptor must NOT inherit the loose mode.
      await writeRpcDescriptor(
        { host: '127.0.0.1', port: 1, token: 't', pid: 1, startedAt: '' },
        file,
      );
      const info = await stat(file);
      expect((info.mode & 0o777).toString(8)).toBe('600');
      await unlink(file);
    },
  );

  it('readRpcDescriptor throws on malformed JSON', async () => {
    const file = await tmpFile();
    const { writeFile } = await import('node:fs/promises');
    await writeFile(file, '"just a string"', 'utf8');
    await expect(readRpcDescriptor(file)).rejects.toThrow(/not an object/);
    await unlink(file);
  });

  it('readRpcDescriptor throws when fields are missing', async () => {
    const file = await tmpFile();
    await writeRpcDescriptor(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { host: 'x' } as any,
      file,
    );
    await expect(readRpcDescriptor(file)).rejects.toThrow(/malformed/);
    await unlink(file);
  });

  it('deleteRpcDescriptor removes the file', async () => {
    const file = await tmpFile();
    await writeRpcDescriptor(
      { host: '127.0.0.1', port: 1, token: 't', pid: 1, startedAt: '' },
      file,
    );
    await deleteRpcDescriptor(file);
    await expect(stat(file)).rejects.toThrow();
  });

  it('deleteRpcDescriptor is idempotent on missing files', async () => {
    const file = await tmpFile();
    await expect(deleteRpcDescriptor(file)).resolves.toBeUndefined();
  });

  it('defaultRpcTokenFilePath ends in .symphony/rpc.json', () => {
    const p = defaultRpcTokenFilePath('/tmp/home');
    expect(p).toBe(path.join('/tmp/home', '.symphony', 'rpc.json'));
  });
});
