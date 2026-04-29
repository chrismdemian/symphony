import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { request } from 'node:http';
import {
  MaestroHookServer,
  type HookPayload,
} from '../../src/orchestrator/maestro/hook-server.js';

interface PostResponse {
  status: number;
  headers: NodeJS.Dict<string | string[]>;
  body: string;
}

interface PostInput {
  port: number;
  path?: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
  destroyAfterBytes?: number;
}

async function http(input: PostInput): Promise<PostResponse> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port: input.port,
        path: input.path ?? '/hook',
        method: input.method ?? 'POST',
        headers: input.headers ?? {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
        res.on('error', reject);
      },
    );
    req.on('error', (err) => {
      // Connection-reset is expected for the oversized-body test.
      if ((err as NodeJS.ErrnoException).code === 'ECONNRESET') {
        resolve({ status: 0, headers: {}, body: '' });
        return;
      }
      reject(err);
    });
    if (input.body !== undefined) {
      req.write(input.body);
    }
    req.end();
  });
}

let server: MaestroHookServer | undefined;

beforeEach(() => {
  server = undefined;
});

afterEach(async () => {
  await server?.stop();
  server = undefined;
});

describe('MaestroHookServer.start', () => {
  it('binds an ephemeral port and exposes a UUID-shaped token', async () => {
    server = new MaestroHookServer();
    const result = await server.start();
    expect(result.port).toBeGreaterThan(0);
    expect(result.token).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(server.getPort()).toBe(result.port);
    expect(server.getToken()).toBe(result.token);
  });

  it('is idempotent — second start returns the same port', async () => {
    server = new MaestroHookServer();
    const first = await server.start();
    const second = await server.start();
    expect(second.port).toBe(first.port);
    expect(second.token).toBe(first.token);
  });

  it('honors a constructor-supplied token', async () => {
    server = new MaestroHookServer({ token: 'fixed-token-for-test' });
    const { token } = await server.start();
    expect(token).toBe('fixed-token-for-test');
  });
});

describe('MaestroHookServer POST /hook', () => {
  it('accepts a valid request and emits the parsed payload', async () => {
    server = new MaestroHookServer({ token: 'tok' });
    const { port } = await server.start();
    const payloads: HookPayload[] = [];
    server.on('stop', (p) => payloads.push(p));

    const res = await http({
      port,
      headers: {
        'content-type': 'application/json',
        'x-symphony-hook-token': 'tok',
        'x-symphony-hook-event': 'stop',
      },
      body: JSON.stringify({
        session_id: 'sess-123',
        transcript_path: '/tmp/transcript.jsonl',
        stop_reason: 'end_turn',
        custom_field: 42,
      }),
    });
    expect(res.status).toBe(200);
    // Allow microtask flush.
    await new Promise((r) => setImmediate(r));
    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.sessionId).toBe('sess-123');
    expect(payloads[0]?.transcriptPath).toBe('/tmp/transcript.jsonl');
    expect(payloads[0]?.stopReason).toBe('end_turn');
    expect(payloads[0]?.raw['custom_field']).toBe(42);
  });

  it('returns 403 with WWW-Authenticate when the token does not match', async () => {
    server = new MaestroHookServer({ token: 'right' });
    const { port } = await server.start();
    const res = await http({
      port,
      headers: {
        'x-symphony-hook-token': 'wrong',
        'x-symphony-hook-event': 'stop',
      },
      body: '{}',
    });
    expect(res.status).toBe(403);
    expect(res.headers['www-authenticate']).toBe('Bearer realm="symphony"');
  });

  it('returns 401 with WWW-Authenticate when the token header is missing', async () => {
    server = new MaestroHookServer({ token: 'tok' });
    const { port } = await server.start();
    const res = await http({
      port,
      headers: {
        'x-symphony-hook-event': 'stop',
      },
      body: '{}',
    });
    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toBe('Bearer realm="symphony"');
  });

  it('returns 400 when the event header is missing', async () => {
    server = new MaestroHookServer({ token: 'tok' });
    const { port } = await server.start();
    const res = await http({
      port,
      headers: {
        'x-symphony-hook-token': 'tok',
      },
      body: '{}',
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 when the body is not valid JSON', async () => {
    server = new MaestroHookServer({ token: 'tok' });
    const { port } = await server.start();
    const res = await http({
      port,
      headers: {
        'x-symphony-hook-token': 'tok',
        'x-symphony-hook-event': 'stop',
      },
      body: 'not-json',
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 when the body is a JSON array (must be object)', async () => {
    server = new MaestroHookServer({ token: 'tok' });
    const { port } = await server.start();
    const res = await http({
      port,
      headers: {
        'x-symphony-hook-token': 'tok',
        'x-symphony-hook-event': 'stop',
      },
      body: '[1,2,3]',
    });
    expect(res.status).toBe(400);
  });

  it('destroys the connection when the body exceeds 1 MiB', async () => {
    server = new MaestroHookServer({ token: 'tok' });
    const { port } = await server.start();
    const payloads: HookPayload[] = [];
    server.on('stop', (p) => payloads.push(p));
    const oversized = Buffer.alloc(1_500_000, 0x7b); // 1.5 MB of `{`
    const res = await http({
      port,
      headers: {
        'x-symphony-hook-token': 'tok',
        'x-symphony-hook-event': 'stop',
        'content-length': String(oversized.length),
      },
      body: oversized,
    });
    // m4 tightens this: either a 413 (server replied + closed) or a 0
    // (socket destroyed before headers landed). 400 is no longer accepted.
    expect([0, 413]).toContain(res.status);
    // The handler must NEVER fire on oversized bodies.
    await new Promise((r) => setImmediate(r));
    expect(payloads).toHaveLength(0);
  });

  it('parses an empty body as `{}` (audit m12)', async () => {
    server = new MaestroHookServer({ token: 'tok' });
    const { port } = await server.start();
    const payloads: HookPayload[] = [];
    server.on('stop', (p) => payloads.push(p));
    const res = await http({
      port,
      headers: {
        'x-symphony-hook-token': 'tok',
        'x-symphony-hook-event': 'stop',
      },
      // body omitted entirely
    });
    expect(res.status).toBe(200);
    await new Promise((r) => setImmediate(r));
    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.raw).toEqual({});
    expect(payloads[0]?.sessionId).toBeUndefined();
  });

  it('passes the event-type literal as the listener second argument (audit m11)', async () => {
    server = new MaestroHookServer({ token: 'tok' });
    const { port } = await server.start();
    const captured: Array<[HookPayload, string]> = [];
    server.on('stop', (p, t) => captured.push([p, t]));
    await http({
      port,
      headers: {
        'x-symphony-hook-token': 'tok',
        'x-symphony-hook-event': 'stop',
      },
      body: '{}',
    });
    await new Promise((r) => setImmediate(r));
    expect(captured).toHaveLength(1);
    expect(captured[0]?.[1]).toBe('stop');
  });

  it('returns 404 for GET /hook', async () => {
    server = new MaestroHookServer({ token: 'tok' });
    const { port } = await server.start();
    const res = await http({ port, method: 'GET' });
    expect(res.status).toBe(404);
  });

  it('returns 404 for POST to a different path', async () => {
    server = new MaestroHookServer({ token: 'tok' });
    const { port } = await server.start();
    const res = await http({
      port,
      path: '/other',
      headers: {
        'x-symphony-hook-token': 'tok',
        'x-symphony-hook-event': 'stop',
      },
      body: '{}',
    });
    expect(res.status).toBe(404);
  });
});

describe('MaestroHookServer.stop', () => {
  it('is idempotent', async () => {
    server = new MaestroHookServer();
    await server.start();
    await server.stop();
    await expect(server.stop()).resolves.toBeUndefined();
  });

  it('lets a fresh start() bind a new port after stop()', async () => {
    server = new MaestroHookServer();
    const _first = await server.start();
    void _first;
    await server.stop();
    const second = await server.start();
    expect(second.port).toBeGreaterThan(0);
    // Could collide by chance — if it does, just assert it's bound.
    expect(server.getPort()).toBe(second.port);
  });
});
