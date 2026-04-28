import { describe, expect, it, vi } from 'vitest';
import {
  createRPCController,
  createRPCRouter,
  createRPCClient,
  resolveProcedure,
  type IpcClient,
} from '../../src/rpc/router.js';

describe('rpc/router — type-pattern identity functions', () => {
  it('createRPCController returns the same handlers it received', () => {
    const handlers = {
      ping: () => 'pong',
      echo: (x: string) => x,
    };
    expect(createRPCController(handlers)).toBe(handlers);
  });

  it('createRPCRouter returns the same routers it received', () => {
    const routers = {
      ns: createRPCController({ go: () => 1 }),
    };
    expect(createRPCRouter(routers)).toBe(routers);
  });
});

describe('rpc/router — resolveProcedure', () => {
  const router = {
    projects: { list: () => [], get: (_id: string) => null },
    tasks: { create: (_x: number) => 0 },
  };

  it('returns the handler for a valid namespace+procedure', () => {
    expect(resolveProcedure(router, 'projects', 'list')).toBe(router.projects.list);
  });

  it('returns undefined for unknown namespace', () => {
    expect(resolveProcedure(router, 'bogus', 'list')).toBeUndefined();
  });

  it('returns undefined for unknown procedure within a namespace', () => {
    expect(resolveProcedure(router, 'projects', 'bogus')).toBeUndefined();
  });
});

describe('rpc/router — IpcClient proxy', () => {
  type RouterShape = {
    projects: { list: () => Promise<string[]>; get: (id: string) => Promise<{ id: string }> };
    tasks: { create: (x: number) => Promise<number> };
  };

  it('proxies a call into the invoke function with namespace.procedure channel', async () => {
    const invoke = vi.fn().mockResolvedValue([]);
    const client = createRPCClient<RouterShape>(invoke);
    await client.projects.list();
    expect(invoke).toHaveBeenCalledWith('projects.list');
  });

  it('forwards args verbatim', async () => {
    const invoke = vi.fn().mockResolvedValue({ id: 'p-1' });
    const client = createRPCClient<RouterShape>(invoke);
    await client.projects.get('p-1');
    expect(invoke).toHaveBeenCalledWith('projects.get', 'p-1');
  });

  it('returns whatever invoke resolves to', async () => {
    const invoke = vi.fn().mockResolvedValue(7);
    const client = createRPCClient<RouterShape>(invoke);
    const result = await client.tasks.create(3);
    expect(result).toBe(7);
  });

  it('guards against `then` lookup at the namespace level (no phantom call)', () => {
    const invoke = vi.fn();
    const client = createRPCClient<RouterShape>(invoke);
    // Awaiting a namespace would otherwise trigger a `then` channel call.
    expect((client.projects as unknown as { then?: unknown }).then).toBeUndefined();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('guards against `then` lookup at the root proxy level', () => {
    const invoke = vi.fn();
    const client = createRPCClient<RouterShape>(invoke);
    expect((client as unknown as { then?: unknown }).then).toBeUndefined();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('guards against JSON.stringify phantom RPC via toJSON (Audit M3)', () => {
    const invoke = vi.fn();
    const client = createRPCClient<RouterShape>(invoke);
    JSON.stringify(client.projects);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('guards against String/Number coercion phantom RPC (Audit M3)', () => {
    const invoke = vi.fn();
    const client = createRPCClient<RouterShape>(invoke);
    // The proxy returns undefined for toString/valueOf/Symbol.toPrimitive,
    // so JS engine throws "Cannot convert object to primitive value"
    // rather than silently dispatching a phantom RPC. Either outcome
    // — throw OR returning a non-callable — is acceptable; the
    // invariant we care about is that NO procedure call dispatched.
    try {
      String(client.projects);
    } catch {
      // expected — primitive conversion not supported
    }
    try {
      Number(client.projects);
    } catch {
      // expected — primitive conversion not supported
    }
    expect(invoke).not.toHaveBeenCalled();
  });

  it('guards against valueOf coercion phantom RPC (Audit M3)', () => {
    const invoke = vi.fn();
    const client = createRPCClient<RouterShape>(invoke);
    void (client.projects as unknown as { valueOf?: unknown }).valueOf;
    expect(invoke).not.toHaveBeenCalled();
  });

  it('IpcClient mapped type collapses sync handlers to Promise returns at the call site', async () => {
    type SyncRouter = { ns: { sync: () => number } };
    const invoke = vi.fn().mockResolvedValue(5);
    const client: IpcClient<SyncRouter> = createRPCClient<SyncRouter>(invoke);
    const result = await client.ns.sync();
    expect(result).toBe(5);
  });
});
