import { promises as fsp, type FSWatcher, watch } from 'node:fs';
import path from 'node:path';
import {
  defaultRpcTokenFilePath,
  readRpcDescriptor,
  type RpcDescriptor,
} from '../../rpc/auth.js';
import { RpcClient } from '../../rpc/client.js';
import type { SymphonyRouter } from '../../rpc/router-impl.js';

const DEFAULT_AWAIT_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 250;

export interface AwaitRpcReadyInput {
  /**
   * Override the descriptor path (default `~/.symphony/rpc.json`). Tests use
   * an isolated path so they don't race against a real Symphony instance.
   */
  descriptorPath?: string;
  /** Maximum wait for the descriptor to become readable. Default 30s. */
  timeoutMs?: number;
  /**
   * If set, skip descriptors with a different pid + an `acceptOnlyPid` value.
   * Used when the parent knows the exact pid of the mcp-server child it
   * spawned (or, transitively, that Claude spawned via mcp-config).
   */
  acceptOnlyPid?: number;
  /** Optional abort signal (e.g. parent shutting down mid-wait). */
  signal?: AbortSignal;
}

export interface RpcReadyDescriptor extends RpcDescriptor {
  descriptorPath: string;
}

export class RpcReadyTimeoutError extends Error {
  readonly descriptorPath: string;
  constructor(descriptorPath: string, timeoutMs: number) {
    super(
      `Timed out after ${timeoutMs}ms waiting for RPC descriptor at ${descriptorPath}. ` +
        `Verify that \`symphony mcp-server\` started successfully (check stderr for the ` +
        `"symphony.rpc.ready" advert).`,
    );
    this.name = 'RpcReadyTimeoutError';
    this.descriptorPath = descriptorPath;
  }
}

export class RpcReadyAbortedError extends Error {
  constructor() {
    super('awaitRpcReady aborted');
    this.name = 'RpcReadyAbortedError';
  }
}

/**
 * Block until the orchestrator-server child writes its RPC descriptor file,
 * then return the parsed descriptor. Uses `fs.watch` on the parent dir for
 * change events with a 250ms polling fallback (Win32 + WSL filesystem
 * watchers are flaky enough to warrant the belt-and-suspenders approach).
 *
 * The mcp-server child is spawned by Claude Code via `--mcp-config` — we
 * can't tap its stderr directly, so the descriptor file IS the synchronization
 * primitive.
 */
export async function awaitRpcReady(
  input: AwaitRpcReadyInput = {},
): Promise<RpcReadyDescriptor> {
  const descriptorPath = input.descriptorPath ?? defaultRpcTokenFilePath();
  const timeoutMs = input.timeoutMs ?? DEFAULT_AWAIT_TIMEOUT_MS;
  const absolute = path.resolve(descriptorPath);
  const dir = path.dirname(absolute);

  // mkdir parent so fs.watch has something to attach to. Cheap; idempotent.
  await fsp.mkdir(dir, { recursive: true }).catch(() => {});

  const tryRead = async (): Promise<RpcReadyDescriptor | undefined> => {
    try {
      const desc = await readRpcDescriptor(absolute);
      if (input.acceptOnlyPid !== undefined && desc.pid !== input.acceptOnlyPid) {
        return undefined;
      }
      return { ...desc, descriptorPath: absolute };
    } catch {
      return undefined;
    }
  };

  // Fast path: descriptor already on disk before we set up the watcher.
  const initial = await tryRead();
  if (initial !== undefined) return initial;

  return new Promise<RpcReadyDescriptor>((resolve, reject) => {
    // Resource handles are mutable across the resolution lifetime. The
    // cleanup closure (and a synchronous abort fired from a pre-aborted
    // signal) can run before they're populated, so initialize to undefined.
    /* eslint-disable prefer-const -- handles are reassigned across closures */
    let watcher: FSWatcher | undefined;
    let pollHandle: NodeJS.Timeout | undefined;
    let timeoutHandle: NodeJS.Timeout | undefined;
    let settled = false;
    /* eslint-enable prefer-const */
    const abortHandler = (): void => {
      settle({ kind: 'err', error: new RpcReadyAbortedError() });
    };
    const cleanup = (): void => {
      if (pollHandle !== undefined) clearInterval(pollHandle);
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
      try {
        watcher?.close();
      } catch {
        // already closed
      }
      input.signal?.removeEventListener('abort', abortHandler);
    };
    const settle = (
      result: { kind: 'ok'; value: RpcReadyDescriptor } | { kind: 'err'; error: Error },
    ): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (result.kind === 'ok') resolve(result.value);
      else reject(result.error);
    };

    const checkOnce = (): void => {
      void tryRead().then((desc) => {
        if (desc !== undefined) settle({ kind: 'ok', value: desc });
      });
    };

    if (input.signal !== undefined) {
      if (input.signal.aborted) {
        abortHandler();
        return;
      }
      input.signal.addEventListener('abort', abortHandler, { once: true });
    }

    try {
      watcher = watch(dir, { persistent: false }, (_event, name) => {
        if (typeof name === 'string' && name === path.basename(absolute)) checkOnce();
      });
      watcher.on('error', () => {
        // Swallow; the polling fallback covers it.
      });
    } catch {
      // Watcher unavailable (rare) — polling still works.
    }

    pollHandle = setInterval(checkOnce, POLL_INTERVAL_MS);
    timeoutHandle = setTimeout(() => {
      settle({ kind: 'err', error: new RpcReadyTimeoutError(absolute, timeoutMs) });
    }, timeoutMs);

    // One immediate check in case the descriptor landed between our initial
    // read and the watcher/polling setup.
    checkOnce();
  });
}

export interface ConnectMaestroRpcInput {
  descriptor: Pick<RpcDescriptor, 'host' | 'port' | 'token'>;
  /** Connection-open timeout in ms. Default 5_000. */
  openTimeoutMs?: number;
}

/**
 * Open an `RpcClient<SymphonyRouter>` connected to the orchestrator-server
 * child. The parent uses this in 2C.1 to populate `{registered_projects}`
 * via `projects.list` before composing Maestro's CLAUDE.md. Phase 3 TUI
 * will use it for status panels.
 */
export async function connectMaestroRpc(
  input: ConnectMaestroRpcInput,
): Promise<RpcClient<SymphonyRouter>> {
  const url = `ws://${input.descriptor.host}:${input.descriptor.port}/`;
  const opts = {
    url,
    token: input.descriptor.token,
    ...(input.openTimeoutMs !== undefined ? { openTimeoutMs: input.openTimeoutMs } : {}),
  } as const;
  return RpcClient.connect<SymphonyRouter>(opts);
}
