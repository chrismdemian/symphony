import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * RPC token persistence + validation — Phase 2B.2.
 *
 * The orchestrator binds the WS server to 127.0.0.1 (single-machine trust)
 * and additionally requires a per-process token in the `Authorization`
 * header. Two independent gates: a foreign machine can't reach the socket;
 * a co-resident process can't connect without reading the token file.
 *
 * The token is generated fresh on every orchestrator startup unless
 * `SYMPHONY_RPC_TOKEN` is set in env (CI / scripted clients). Both the
 * port (after bind) and the token are written to `~/.symphony/rpc.json` so
 * peer clients on the same machine can discover the running orchestrator.
 *
 * Safety choices:
 *   - 32 bytes / 256 bits of entropy → hex-encoded for header transport.
 *   - File is created with `mode: 0o600` at open (NOT chmod-after-write)
 *     so the bytes never exist on disk world-readable.
 *   - Comparison uses `crypto.timingSafeEqual` over equal-length buffers;
 *     length mismatch returns false WITHOUT calling `timingSafeEqual` (the
 *     stdlib throws on length mismatch).
 */

export const RPC_TOKEN_BYTES = 32;
export const RPC_TOKEN_ENV = 'SYMPHONY_RPC_TOKEN' as const;

export interface RpcDescriptor {
  readonly host: string;
  readonly port: number;
  readonly token: string;
  readonly pid: number;
  readonly startedAt: string;
}

export class UnauthorizedError extends Error {
  constructor(reason: string) {
    super(`RPC unauthorized: ${reason}`);
    this.name = 'UnauthorizedError';
  }
}

/**
 * Generate a fresh hex-encoded token, or use `SYMPHONY_RPC_TOKEN` when
 * present. Empty / whitespace-only env values are ignored (caller should
 * unset the env var, not blank it, if they want a fresh token).
 */
export function generateRpcToken(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env[RPC_TOKEN_ENV];
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) {
    return fromEnv.trim();
  }
  return randomBytes(RPC_TOKEN_BYTES).toString('hex');
}

/**
 * Default token-file path: `~/.symphony/rpc.json`. Parent directory is
 * created with mode 0o700 if missing.
 */
export function defaultRpcTokenFilePath(home: string = os.homedir()): string {
  return path.join(home, '.symphony', 'rpc.json');
}

/**
 * Persist a descriptor to disk with 0o600 perms enforced regardless of
 * pre-existing file state. Returns the absolute path written.
 *
 * Audit M1 (2B.2 review): `fs.writeFile(..., { mode: 0o600 })` only
 * applies the mode on FILE CREATION. A pre-existing 0o644 token file
 * silently keeps its mode, defeating the security model. Defense:
 * unlink-best-effort, write fresh, then `fchmod` defensively. The mode
 * passed to `open(..., 'w', 0o600)` covers the create case; the chmod
 * after write covers any pre-existing-file-with-loose-mode case missed
 * by the kernel.
 *
 * Win32: `chmod` on Win32 is a no-op for ACL purposes. Documented as a
 * known gotcha — file is FS-permission-only on Windows v1.
 */
export async function writeRpcDescriptor(
  descriptor: RpcDescriptor,
  filePath: string = defaultRpcTokenFilePath(),
): Promise<string> {
  const absolute = path.resolve(filePath);
  await fsp.mkdir(path.dirname(absolute), { recursive: true, mode: 0o700 });
  // Best-effort unlink: if a previous file with a permissive mode exists,
  // remove it so the subsequent open(..., 'w', 0o600) creates fresh and
  // mode is honored.
  try {
    await fsp.unlink(absolute);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw cause;
    }
  }
  const handle = await fsp.open(absolute, 'w', 0o600);
  try {
    await handle.writeFile(JSON.stringify(descriptor, null, 2), { encoding: 'utf8' });
    // Defensive `fchmod` — covers any platform/edge case where the
    // open mode wasn't honored exactly.
    if (process.platform !== 'win32') {
      await handle.chmod(0o600);
    }
  } finally {
    await handle.close();
  }
  return absolute;
}

export async function readRpcDescriptor(
  filePath: string = defaultRpcTokenFilePath(),
): Promise<RpcDescriptor> {
  const text = await fsp.readFile(path.resolve(filePath), 'utf8');
  const parsed = JSON.parse(text) as unknown;
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`RPC descriptor at ${filePath} is not an object`);
  }
  const obj = parsed as Record<string, unknown>;
  const host = obj['host'];
  const port = obj['port'];
  const token = obj['token'];
  const pid = obj['pid'];
  const startedAt = obj['startedAt'];
  if (
    typeof host !== 'string' ||
    typeof port !== 'number' ||
    typeof token !== 'string' ||
    typeof pid !== 'number' ||
    typeof startedAt !== 'string'
  ) {
    throw new Error(`RPC descriptor at ${filePath} is malformed`);
  }
  return { host, port, token, pid, startedAt };
}

export async function deleteRpcDescriptor(
  filePath: string = defaultRpcTokenFilePath(),
): Promise<void> {
  try {
    await fsp.unlink(path.resolve(filePath));
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw cause;
  }
}

/**
 * Compare two tokens in constant time. Hashes both sides to a fixed
 * 32-byte digest first so length mismatch (e.g. an env-override token of
 * a different length than the random default) doesn't leak via timing
 * (Audit m5). Returns true on match, false otherwise. Throws nothing.
 */
export function compareTokens(provided: string, expected: string): boolean {
  if (typeof provided !== 'string' || typeof expected !== 'string') return false;
  const a = createHash('sha256').update(provided, 'utf8').digest();
  const b = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(a, b);
}

const BEARER_RE = /^Bearer\s+(.+)$/i;

/**
 * Extract a bearer token from an `Authorization` header value, then
 * compare to `expected`. Throws `UnauthorizedError` on any mismatch — the
 * caller (upgrade handler) catches this and returns HTTP 401.
 */
export function validateAuthHeader(headerValue: string | undefined, expected: string): void {
  if (!headerValue) {
    throw new UnauthorizedError('missing Authorization header');
  }
  const match = BEARER_RE.exec(headerValue);
  if (!match) {
    throw new UnauthorizedError('Authorization header must be Bearer <token>');
  }
  const provided = match[1]?.trim() ?? '';
  if (!compareTokens(provided, expected)) {
    throw new UnauthorizedError('token mismatch');
  }
}

/**
 * Check the WS subprotocol-style query parameter `?token=...` as a fallback
 * for clients that can't set arbitrary headers (browsers can't set
 * `Authorization` on `new WebSocket()` — Phase 3 may need this).
 */
export function validateQueryToken(url: string | undefined, expected: string): void {
  if (!url) {
    throw new UnauthorizedError('missing request URL');
  }
  const queryIdx = url.indexOf('?');
  if (queryIdx === -1) {
    throw new UnauthorizedError('missing token query parameter');
  }
  const params = new URLSearchParams(url.slice(queryIdx + 1));
  const provided = params.get('token');
  if (!provided) {
    throw new UnauthorizedError('missing token query parameter');
  }
  if (!compareTokens(provided, expected)) {
    throw new UnauthorizedError('token mismatch');
  }
}
