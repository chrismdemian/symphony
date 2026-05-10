import { createServer, type IncomingMessage, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import { Dispatcher, type DispatcherSendOptions } from './dispatcher.js';
import { UnauthorizedError, validateAuthHeader, validateQueryToken } from './auth.js';
import type { WorkerEventBroker } from './event-broker.js';
import type { CompletionsBroker } from '../orchestrator/completion-summarizer-types.js';
import { MAX_FRAME_BYTES } from './protocol.js';

/**
 * WebSocket RPC server — Phase 2B.2.
 *
 * Binds 127.0.0.1 only (loopback is the security boundary for v1) and
 * gates upgrades on a Bearer token. Bad tokens get HTTP 401 BEFORE the
 * WebSocket handshake completes — closing post-handshake leaves clients
 * in a half-state.
 *
 * Each accepted connection gets its own `Dispatcher` and per-connection
 * `AbortController`. When the WS closes, the abort fires, in-flight
 * handlers are cancelled, and all subscriptions are torn down.
 *
 * Bound HTTP server returns 404 on every non-upgrade request — Symphony's
 * RPC server is WS-only.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RouterMap = Record<string, Record<string, (...args: any[]) => unknown>>;

export interface RpcServerOptions {
  readonly router: RouterMap;
  readonly broker: WorkerEventBroker;
  readonly token: string;
  /** Bind host. Default 127.0.0.1. DO NOT change without explicit user intent. */
  readonly host?: string;
  /** Bind port. 0 = OS-assigned ephemeral. */
  readonly port?: number;
  /** Per-connection bounded send queue (frames). Default 1024. */
  readonly sendQueueLimit?: number;
  /**
   * 2B.2 m6: optional `workers.events` workerId existence probe. When
   * supplied, subscribes against unknown ids return `not_found` instead
   * of silently never receiving events. Phase 2C wires this from the
   * `WorkerRegistry`; unit tests omit it.
   */
  readonly workerExists?: (workerId: string) => boolean;
  /**
   * Phase 3K — global completions broker. When supplied, per-connection
   * dispatchers accept `subscribe('completions.events')`. When omitted,
   * subscribes to that topic resolve `not_found` (preserves prior
   * behavior for unit tests).
   */
  readonly completionsBroker?: CompletionsBroker;
}

export interface RpcServerHandle {
  readonly host: string;
  readonly port: number;
  /** Active connections — test seam. */
  readonly connectionCount: () => number;
  close(): Promise<void>;
}

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_SEND_QUEUE = 1024;

export async function startRpcServer(opts: RpcServerOptions): Promise<RpcServerHandle> {
  const host = opts.host ?? DEFAULT_HOST;
  const port = opts.port ?? 0;
  const sendQueueLimit = opts.sendQueueLimit ?? DEFAULT_SEND_QUEUE;
  const httpServer: HttpServer = createServer((_req, res) => {
    res.statusCode = 404;
    res.setHeader('content-type', 'text/plain');
    res.end('Symphony RPC: WebSocket only');
  });
  // `maxPayload` bounds the largest frame the WS layer will buffer; the
  // dispatcher still re-validates via `MAX_FRAME_BYTES` (Audit M2).
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
  const connections = new Set<WebSocket>();

  httpServer.on('upgrade', (req, socket, head) => {
    try {
      authorizeUpgrade(req, opts.token);
    } catch (cause) {
      const reason = cause instanceof UnauthorizedError ? cause.message : 'unauthorized';
      // 401 BEFORE the WS handshake completes (Phase 2B.2 known gotcha).
      // RFC 7235 requires `WWW-Authenticate` on 401s (Audit m4).
      socket.write(
        `HTTP/1.1 401 Unauthorized\r\n` +
          `Connection: close\r\n` +
          `Content-Type: text/plain\r\n` +
          `WWW-Authenticate: Bearer realm="symphony"\r\n` +
          `Content-Length: ${Buffer.byteLength(reason)}\r\n` +
          `\r\n` +
          reason,
      );
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      attachConnection(ws);
    });
  });

  function attachConnection(ws: WebSocket): void {
    connections.add(ws);
    const controller = new AbortController();
    let queued = 0;
    const send = (text: string, options?: DispatcherSendOptions): void => {
      if (ws.readyState !== ws.OPEN) return;
      if (queued >= sendQueueLimit) {
        if (options?.dropOnBackpressure) {
          // Slow client — silently drop. Phase 3 may surface a metric.
          return;
        }
        // RPC envelopes (non-event) MUST land — close the slow client.
        ws.close(1011, 'send queue saturated');
        return;
      }
      queued += 1;
      ws.send(text, (err) => {
        queued -= 1;
        // The `ws` library passes `null` on success and an Error on
        // failure. `undefined` is also possible across versions, so
        // treat "anything truthy" as failure.
        if (err && ws.readyState === ws.OPEN) {
          ws.close(1011, 'send error');
        }
      });
    };
    const dispatcher = new Dispatcher({
      router: opts.router,
      broker: opts.broker,
      send,
      signal: controller.signal,
      closeOnProtocolError: (code, reason) => {
        if (ws.readyState === ws.OPEN) ws.close(code, reason);
      },
      ...(opts.workerExists !== undefined ? { workerExists: opts.workerExists } : {}),
      ...(opts.completionsBroker !== undefined
        ? { completionsBroker: opts.completionsBroker }
        : {}),
    });
    ws.on('message', (data) => {
      const text = typeof data === 'string' ? data : Buffer.isBuffer(data) ? data.toString('utf8')
        : Array.isArray(data) ? Buffer.concat(data as Buffer[]).toString('utf8')
        : Buffer.from(data as ArrayBuffer).toString('utf8');
      void dispatcher.handle(text);
    });
    const teardown = (): void => {
      controller.abort();
      dispatcher.close();
      connections.delete(ws);
    };
    ws.on('close', teardown);
    ws.on('error', () => {
      try {
        ws.close();
      } catch {
        // already closed
      }
      teardown();
    });
  }

  await new Promise<void>((resolve, reject) => {
    const onError = (cause: Error): void => {
      httpServer.off('listening', onListening);
      reject(cause);
    };
    const onListening = (): void => {
      httpServer.off('error', onError);
      resolve();
    };
    httpServer.once('error', onError);
    httpServer.once('listening', onListening);
    httpServer.listen({ host, port });
  });

  const address = httpServer.address() as AddressInfo;
  const boundPort = address.port;

  return {
    host,
    port: boundPort,
    connectionCount: () => connections.size,
    async close(): Promise<void> {
      // Stop accepting new connections first.
      for (const ws of connections) {
        try {
          ws.close(1001, 'server shutdown');
        } catch {
          // already closed
        }
      }
      await new Promise<void>((resolve) => {
        wss.close(() => resolve());
      });
      await new Promise<void>((resolve, reject) => {
        httpServer.close((err) => (err === undefined ? resolve() : reject(err)));
      });
    },
  };
}

function authorizeUpgrade(req: IncomingMessage, expected: string): void {
  const header = req.headers['authorization'];
  if (typeof header === 'string') {
    // 2B.2 m3: an empty Authorization header (e.g. `Authorization:`) used
    // to fall through to the query-token branch silently. A client in a
    // half-broken state where the auth header is dropped to "" but a
    // stale `?token=` lingers shouldn't authenticate via the wrong path.
    // Reject explicitly so the misconfiguration surfaces.
    if (header.length === 0) {
      throw new UnauthorizedError('empty Authorization header');
    }
    validateAuthHeader(header, expected);
    return;
  }
  // Fallback for clients that can't set arbitrary headers
  // (e.g. browser `new WebSocket(url)`). Documented in Phase 3
  // when the TUI/Tauri shell needs it.
  validateQueryToken(req.url, expected);
}
