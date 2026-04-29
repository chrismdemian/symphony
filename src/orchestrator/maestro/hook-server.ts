import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { compareTokens } from '../../rpc/auth.js';

// 1 MiB body cap (1024 * 1024 — emdash uses the decimal 1_000_000 but the
// JSDoc on this server promises MiB; pick the binary boundary).
const MAX_BODY_BYTES = 1_048_576;
const HOOK_PATH = '/hook';
const TOKEN_HEADER = 'x-symphony-hook-token';
const EVENT_HEADER = 'x-symphony-hook-event';
const WWW_AUTH_VALUE = 'Bearer realm="symphony"';

export interface HookPayload {
  /** `session_id` from Claude Code's hook payload, when present. */
  sessionId?: string;
  /** `transcript_path` from Claude Code's hook payload. */
  transcriptPath?: string;
  /** `stop_reason` from Claude Code's hook payload (e.g. `'end_turn'`). */
  stopReason?: string;
  /** Full parsed JSON body — pass-through for fields we don't normalize. */
  raw: Record<string, unknown>;
}

export type HookEventType = 'stop';

export interface MaestroHookServerOptions {
  /** Override the bearer token (tests). Defaults to `crypto.randomUUID()`. */
  token?: string;
}

export interface MaestroHookServerStartResult {
  port: number;
  token: string;
}

/**
 * Local HTTP receiver for Claude Code's `Stop` hook on the long-lived Maestro
 * subprocess. Provides the launcher with a higher-fidelity "turn complete,
 * ready for next user input" signal than polling stream-json `result` events
 * (PLAN.md §3 design principle; emdash port from `AgentEventService.ts`).
 *
 * Lifecycle owned by the launcher (`runStart`). Token + port are passed into
 * Maestro via `extraEnv` (`SYMPHONY_HOOK_TOKEN`, `SYMPHONY_HOOK_PORT`); the
 * curl literal in Claude's `settings.local.json` reads them at runtime.
 *
 * Security envelope:
 *   - Binds 127.0.0.1 only.
 *   - Bearer token compared via `compareTokens` (sha256 + timingSafeEqual; 2B.2 m5).
 *   - 1 MiB body cap, `req.destroy()` on overflow.
 *   - 401/403 responses include `WWW-Authenticate: Bearer realm="symphony"` (RFC 7235; 2B.2 m4).
 *   - Non-POST or non-`/hook` → 404. Missing event header → 400. Bad JSON → 400.
 */
export class MaestroHookServer {
  private readonly token: string;
  private readonly emitter = new EventEmitter();
  private server: Server | undefined;
  private port = 0;

  constructor(options: MaestroHookServerOptions = {}) {
    this.token = options.token ?? randomUUID();
    // Phase 3 TUI fan-out: lift cap (mirror MaestroProcess `setMaxListeners(0)`).
    this.emitter.setMaxListeners(0);
  }

  /**
   * Bind 127.0.0.1:0 and begin accepting requests. Idempotent — repeated
   * calls return the same `{ port, token }` without rebinding.
   */
  async start(): Promise<MaestroHookServerStartResult> {
    if (this.server !== undefined) {
      return { port: this.port, token: this.token };
    }
    const server = createServer((req, res) => {
      this.handleRequest(req, res);
    });
    server.on('clientError', (_err, socket) => {
      try {
        socket.destroy();
      } catch {
        // already closed
      }
    });
    await new Promise<void>((resolve, reject) => {
      const onError = (cause: Error): void => {
        server.off('listening', onListening);
        reject(cause);
      };
      const onListening = (): void => {
        server.off('error', onError);
        const addr = server.address();
        if (addr === null || typeof addr === 'string') {
          reject(new Error('MaestroHookServer: unexpected address shape from listen()'));
          return;
        }
        this.port = addr.port;
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(0, '127.0.0.1');
    });
    // Don't keep the event loop alive solely for the hook server — vitest
    // cleanup paths sometimes forget to call `stop()` (audit m13).
    server.unref();
    this.server = server;
    return { port: this.port, token: this.token };
  }

  /** Close the server. Idempotent. Drains in-flight requests. */
  async stop(): Promise<void> {
    if (this.server === undefined) return;
    const server = this.server;
    this.server = undefined;
    this.port = 0;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }

  getPort(): number {
    return this.port;
  }

  getToken(): string {
    return this.token;
  }

  on(type: HookEventType, listener: (payload: HookPayload) => void): this {
    this.emitter.on(type, listener as (payload: HookPayload) => void);
    return this;
  }

  off(type: HookEventType, listener: (payload: HookPayload) => void): this {
    this.emitter.off(type, listener as (payload: HookPayload) => void);
    return this;
  }

  // ── internals ──────────────────────────────────────────────────────────

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    if (req.method !== 'POST' || req.url !== HOOK_PATH) {
      res.writeHead(404);
      res.end();
      // Drain to avoid leaking the connection in keep-alive scenarios.
      req.resume();
      return;
    }

    const tokenHeader = readSingleHeader(req, TOKEN_HEADER);
    if (tokenHeader === undefined || tokenHeader.length === 0) {
      res.writeHead(401, { 'WWW-Authenticate': WWW_AUTH_VALUE });
      res.end();
      req.resume();
      return;
    }
    if (!compareTokens(tokenHeader, this.token)) {
      res.writeHead(403, { 'WWW-Authenticate': WWW_AUTH_VALUE });
      res.end();
      req.resume();
      return;
    }

    const eventHeader = readSingleHeader(req, EVENT_HEADER);
    if (eventHeader === undefined || eventHeader.length === 0) {
      res.writeHead(400);
      res.end('missing X-Symphony-Hook-Event header');
      req.resume();
      return;
    }

    const chunks: Buffer[] = [];
    let total = 0;
    let destroyed = false;
    req.on('data', (chunk: Buffer) => {
      if (destroyed) return;
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        destroyed = true;
        try {
          req.destroy();
        } catch {
          // already destroyed
        }
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (destroyed) return;
      const body = Buffer.concat(chunks).toString('utf8');
      let raw: Record<string, unknown>;
      if (body.length === 0) {
        raw = {};
      } else {
        try {
          const parsed = JSON.parse(body) as unknown;
          if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
            res.writeHead(400);
            res.end('body must be a JSON object');
            return;
          }
          raw = parsed as Record<string, unknown>;
        } catch {
          res.writeHead(400);
          res.end('invalid JSON body');
          return;
        }
      }
      const payload = normalizePayload(raw);
      // Respond first; defer emit via `setImmediate` so a synchronous slow
      // listener can't stall Claude Code's `curl -sf` (audit C2).
      res.writeHead(200);
      res.end();
      setImmediate(() => {
        this.emitter.emit(eventHeader, payload);
      });
    });
    req.on('error', () => {
      // Connection-reset / abort. Respond is best-effort.
      try {
        res.writeHead(400);
        res.end();
      } catch {
        // already responded or torn down
      }
    });
  }
}

function readSingleHeader(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  if (v === undefined) return undefined;
  if (Array.isArray(v)) return v[0];
  return v;
}

function normalizePayload(raw: Record<string, unknown>): HookPayload {
  const sessionId = stringOrUndefined(raw['session_id'] ?? raw['sessionId']);
  const transcriptPath = stringOrUndefined(raw['transcript_path'] ?? raw['transcriptPath']);
  const stopReason = stringOrUndefined(raw['stop_reason'] ?? raw['stopReason']);
  const out: HookPayload = { raw };
  if (sessionId !== undefined) out.sessionId = sessionId;
  if (transcriptPath !== undefined) out.transcriptPath = transcriptPath;
  if (stopReason !== undefined) out.stopReason = stopReason;
  return out;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
