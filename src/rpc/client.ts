import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import {
  MAX_FRAME_BYTES,
  decodeFrame,
  encodeFrame,
  type ErrorCode,
  type Frame,
  type RpcEnvelope,
} from './protocol.js';
import { createRPCClient, type IpcClient } from './router.js';

/**
 * WebSocket RPC client — Phase 2B.2.
 *
 * Connects to a Symphony orchestrator's RPC server, presents an
 * `IpcClient<Router>` proxy whose calls dispatch over the wire, and
 * exposes a `subscribe` method for server-pushed events.
 *
 * Used today by integration tests; Phase 3 TUI consumes the same surface.
 *
 * Connection lifetime: open on construction, close on `close()`. Any
 * pending RPC calls reject with `AbortError` when the connection drops.
 * Subscriptions emit no further events after close — callers should
 * inspect `client.closed` if they need a definitive state probe.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RouterMap = Record<string, Record<string, (...args: any[]) => unknown>>;

export interface RpcClientOptions {
  readonly url: string;
  readonly token: string;
  /** Connection-open timeout in ms. Default 5_000. */
  readonly openTimeoutMs?: number;
  /** Optional override for crypto.randomUUID — test seam. */
  readonly idGenerator?: () => string;
}

export interface SubscriptionHandle {
  readonly topic: string;
  unsubscribe(): Promise<void>;
}

export interface RpcCallError extends Error {
  code: ErrorCode;
}

export class RpcClient<Router extends RouterMap> {
  readonly call: IpcClient<Router>;
  private readonly ws: WebSocket;
  private readonly pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (cause: Error) => void }
  >();
  private readonly subscriptions = new Map<
    string,
    { topic: string; onEvent: (payload: unknown) => void }
  >();
  private readonly idGen: () => string;
  private closedFlag = false;

  private constructor(ws: WebSocket, opts: RpcClientOptions) {
    this.ws = ws;
    this.idGen = opts.idGenerator ?? defaultIdGenerator;
    this.call = createRPCClient<Router>((channel, ...args) => {
      const dot = channel.indexOf('.');
      if (dot < 0) {
        return Promise.reject(rpcError('bad_args', `invalid channel '${channel}'`));
      }
      const namespace = channel.slice(0, dot);
      const procedure = channel.slice(dot + 1);
      return this.invoke(namespace, procedure, args);
    });

    ws.on('message', (data) => {
      const text =
        typeof data === 'string'
          ? data
          : Buffer.isBuffer(data)
            ? data.toString('utf8')
            : Array.isArray(data)
              ? Buffer.concat(data as Buffer[]).toString('utf8')
              : Buffer.from(data as ArrayBuffer).toString('utf8');
      this.dispatch(text);
    });
    ws.on('close', (code, reason) => {
      this.closedFlag = true;
      const detail = reason && reason.length > 0 ? `: ${reason.toString('utf8')}` : '';
      const closeError = rpcError('aborted', `connection closed (${code})${detail}`);
      for (const entry of this.pending.values()) entry.reject(closeError);
      this.pending.clear();
      this.subscriptions.clear();
    });
    ws.on('error', () => {
      // Forward to close handler — `ws` emits 'close' after 'error'.
    });
  }

  static async connect<Router extends RouterMap>(
    opts: RpcClientOptions,
  ): Promise<RpcClient<Router>> {
    const timeoutMs = opts.openTimeoutMs ?? 5_000;
    const ws = new WebSocket(opts.url, {
      headers: { Authorization: `Bearer ${opts.token}` },
      handshakeTimeout: timeoutMs,
      maxPayload: MAX_FRAME_BYTES,
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        ws.removeAllListeners();
        try {
          ws.terminate();
        } catch {
          // already gone
        }
        reject(new Error(`RPC client open timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      ws.once('open', () => {
        clearTimeout(timer);
        ws.removeAllListeners('error');
        resolve();
      });
      ws.once('error', (cause) => {
        clearTimeout(timer);
        ws.removeAllListeners('open');
        reject(cause);
      });
    });
    return new RpcClient<Router>(ws, opts);
  }

  /**
   * Subscribe to a server-pushed event topic. Resolves once the server
   * acks the subscribe (so the caller knows it's live).
   */
  async subscribe(
    topic: string,
    args: unknown,
    onEvent: (payload: unknown) => void,
  ): Promise<SubscriptionHandle> {
    const id = this.idGen();
    const ack = this.deferred(id);
    const frame: Frame = { kind: 'subscribe', id, topic, args };
    // Audit M4: same pending-leak guard as `invoke`.
    try {
      this.send(frame);
    } catch (cause) {
      this.pending.delete(id);
      throw cause;
    }
    const data = (await ack) as { topic: string };
    this.subscriptions.set(id, { topic: data.topic, onEvent });
    return {
      topic: data.topic,
      unsubscribe: async () => {
        if (this.closedFlag) return;
        if (!this.subscriptions.has(id)) return;
        const unsubAck = this.deferred(id);
        try {
          this.send({ kind: 'unsubscribe', id, topic: data.topic });
        } catch (cause) {
          this.pending.delete(id);
          this.subscriptions.delete(id);
          throw cause;
        }
        try {
          await unsubAck;
        } finally {
          this.subscriptions.delete(id);
        }
      },
    };
  }

  get closed(): boolean {
    return this.closedFlag;
  }

  async close(): Promise<void> {
    if (this.closedFlag) return;
    await new Promise<void>((resolve) => {
      this.ws.once('close', () => resolve());
      try {
        this.ws.close();
      } catch {
        resolve();
      }
    });
  }

  private async invoke(
    namespace: string,
    procedure: string,
    args: readonly unknown[],
  ): Promise<unknown> {
    if (this.closedFlag) {
      throw rpcError('aborted', 'connection already closed');
    }
    const id = this.idGen();
    const promise = this.deferred(id);
    const frame: Frame = { kind: 'rpc-call', id, namespace, procedure, args };
    // Audit M4: clean up the pending entry if `send` throws synchronously
    // (e.g. encoding fails on circular args). Without this, the deferred
    // never resolves and any caller awaiting the returned `promise` hangs.
    try {
      this.send(frame);
    } catch (cause) {
      this.pending.delete(id);
      throw cause;
    }
    return promise;
  }

  private deferred(id: string): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }

  private send(frame: Frame): void {
    if (this.ws.readyState !== this.ws.OPEN) {
      throw rpcError('aborted', 'connection not open');
    }
    this.ws.send(encodeFrame(frame));
  }

  private dispatch(text: string): void {
    let frame: Frame;
    try {
      frame = decodeFrame(text);
    } catch {
      // Server sent garbage — close the connection.
      try {
        this.ws.close(1002, 'protocol error');
      } catch {
        // already closed
      }
      return;
    }
    if (frame.kind === 'rpc-result') {
      const pending = this.pending.get(frame.id);
      if (pending === undefined) return;
      this.pending.delete(frame.id);
      if (frame.result.success) {
        pending.resolve(frame.result.data);
      } else {
        pending.reject(rpcError(frame.result.error.code, frame.result.error.message));
      }
      return;
    }
    if (frame.kind === 'event') {
      for (const sub of this.subscriptions.values()) {
        if (sub.topic === frame.topic) {
          try {
            sub.onEvent(frame.payload);
          } catch {
            // Listener errors are swallowed — same convention as broker.
          }
        }
      }
      return;
    }
    // Other frame kinds shouldn't reach the client.
  }
}

export type { RpcEnvelope };

function defaultIdGenerator(): string {
  return randomUUID();
}

function rpcError(code: ErrorCode, message: string): RpcCallError {
  const err = new Error(message) as RpcCallError;
  err.name = 'RpcCallError';
  err.code = code;
  return err;
}
