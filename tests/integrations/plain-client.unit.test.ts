import { describe, expect, it } from 'vitest';
import { createPlainClient, PlainApiError } from '../../src/integrations/plain-client.js';

interface GqlCall {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly op: string;
  readonly variables: Record<string, unknown>;
}

type OpName = 'workspace' | 'list' | 'threadCustomer' | 'markDone' | 'createNote' | 'unknown';

function detectOp(query: string): OpName {
  if (query.includes('MyWorkspace')) return 'workspace';
  if (query.includes('ListThreads')) return 'list';
  if (query.includes('ThreadCustomer')) return 'threadCustomer';
  if (query.includes('MarkThreadAsDone')) return 'markDone';
  if (query.includes('CreateNote')) return 'createNote';
  return 'unknown';
}

function makeFetch(
  handler: (op: OpName, variables: Record<string, unknown>, index: number) => Response,
): { fetchImpl: typeof fetch; calls: GqlCall[] } {
  const calls: GqlCall[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
    const op = detectOp(String(body.query ?? ''));
    const variables = (body.variables ?? {}) as Record<string, unknown>;
    const index = calls.length;
    calls.push({ url: String(url), method: init?.method ?? 'GET', headers, op, variables });
    return handler(op, variables, index);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function jsonResponse(body: unknown, init: { status?: number } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json' },
  });
}

// A fresh Response per call — Response bodies are single-use, so a shared
// constant would be consumed by the first reader and read empty thereafter.
function wsOk(): Response {
  return jsonResponse({ data: { myWorkspace: { id: 'ws_1', name: 'Acme Support' } } });
}

function rawThread(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 't_1',
    ref: 'T-1',
    title: 'Login bug',
    previewText: 'cannot login',
    status: 'TODO',
    priority: 1,
    customer: { id: 'c_1' },
    labels: [{ labelType: { name: 'bug' } }],
    updatedAt: { iso8601: '2026-06-01T00:00:00Z' },
    ...over,
  };
}

function threadsPage(
  nodes: Array<Record<string, unknown>>,
  pageInfo: { hasNextPage: boolean; endCursor: string | null },
): Response {
  return jsonResponse({
    data: { threads: { edges: nodes.map((node) => ({ node })), pageInfo } },
  });
}

describe('createPlainClient.listOpenThreads', () => {
  it('sends Bearer auth, fetches the workspace, then threads; maps a node + builds the URL', async () => {
    const { fetchImpl, calls } = makeFetch((op) => {
      if (op === 'workspace') return wsOk();
      return threadsPage([rawThread()], { hasNextPage: false, endCursor: null });
    });
    const client = createPlainClient('plain-key', { fetchImpl });
    const threads = await client.listOpenThreads(['TODO'], 50);

    expect(calls[0]!.headers.authorization).toBe('Bearer plain-key');
    expect(calls[0]!.op).toBe('workspace');
    expect(calls[1]!.op).toBe('list');
    expect(calls[1]!.method).toBe('POST');
    expect(calls[1]!.variables.statuses).toEqual(['TODO']);

    expect(threads).toHaveLength(1);
    expect(threads[0]).toMatchObject({
      id: 't_1',
      ref: 'T-1',
      title: 'Login bug',
      status: 'TODO',
      priority: 1, // raw Plain priority (connector inverts)
      customerId: 'c_1',
      labels: ['bug'],
      updatedAt: '2026-06-01T00:00:00Z',
      url: 'https://app.plain.com/workspace/ws_1/thread/t_1',
    });
  });

  it('paginates via pageInfo.endCursor → after', async () => {
    const { fetchImpl, calls } = makeFetch((op, _vars, index) => {
      if (op === 'workspace') return wsOk();
      if (index === 1) {
        return threadsPage(
          [rawThread({ id: 't_1' }), rawThread({ id: 't_2' }), rawThread({ id: 't_3' })],
          { hasNextPage: true, endCursor: 'cur1' },
        );
      }
      return threadsPage([rawThread({ id: 't_4' }), rawThread({ id: 't_5' })], {
        hasNextPage: false,
        endCursor: null,
      });
    });
    const client = createPlainClient('k', { fetchImpl });
    const threads = await client.listOpenThreads(['TODO'], 5);
    expect(threads.map((t) => t.id)).toEqual(['t_1', 't_2', 't_3', 't_4', 't_5']);
    // workspace(1) + 2 list pages
    expect(calls.filter((c) => c.op === 'list')).toHaveLength(2);
    expect(calls[2]!.variables.after).toBe('cur1');
  });

  it('caches the workspace id across calls (one workspace fetch)', async () => {
    const { fetchImpl, calls } = makeFetch((op) => {
      if (op === 'workspace') return wsOk();
      return threadsPage([], { hasNextPage: false, endCursor: null });
    });
    const client = createPlainClient('k', { fetchImpl });
    await client.listOpenThreads(['TODO'], 10);
    await client.listOpenThreads(['TODO'], 10);
    expect(calls.filter((c) => c.op === 'workspace')).toHaveLength(1);
  });

  it('degrades the URL to null when the workspace probe fails (does not abort the list)', async () => {
    const { fetchImpl } = makeFetch((op) => {
      if (op === 'workspace') return jsonResponse({ data: { myWorkspace: null } });
      return threadsPage([rawThread()], { hasNextPage: false, endCursor: null });
    });
    const client = createPlainClient('k', { fetchImpl });
    const threads = await client.listOpenThreads(['TODO'], 10);
    expect(threads).toHaveLength(1);
    expect(threads[0]!.url).toBeNull();
  });
});

describe('createPlainClient.searchThreads', () => {
  it('filters a fetched window client-side by title/ref/preview', async () => {
    const { fetchImpl } = makeFetch((op) => {
      if (op === 'workspace') return wsOk();
      return threadsPage(
        [
          rawThread({ id: 't_1', title: 'Login crash', previewText: 'a' }),
          rawThread({ id: 't_2', title: 'Billing', previewText: 'b' }),
          rawThread({ id: 't_3', title: 'Other', previewText: 'crash on save' }),
        ],
        { hasNextPage: false, endCursor: null },
      );
    });
    const client = createPlainClient('k', { fetchImpl });
    const matches = await client.searchThreads('crash', 10, ['TODO']);
    expect(matches.map((t) => t.id)).toEqual(['t_1', 't_3']);
  });

  it('returns [] for a blank term without hitting the API', async () => {
    const { fetchImpl, calls } = makeFetch(() => wsOk());
    const client = createPlainClient('k', { fetchImpl });
    expect(await client.searchThreads('   ', 10, ['TODO'])).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

describe('createPlainClient.getThreadCustomerId', () => {
  it('returns the customer id', async () => {
    const { fetchImpl } = makeFetch(() =>
      jsonResponse({ data: { thread: { id: 't_1', customer: { id: 'c_9' } } } }),
    );
    const client = createPlainClient('k', { fetchImpl });
    expect(await client.getThreadCustomerId('t_1')).toBe('c_9');
  });

  it('returns null when the thread is not found', async () => {
    const { fetchImpl } = makeFetch(() => jsonResponse({ data: { thread: null } }));
    const client = createPlainClient('k', { fetchImpl });
    expect(await client.getThreadCustomerId('t_missing')).toBeNull();
  });
});

describe('createPlainClient.addNote / markThreadDone', () => {
  it('createNote sends customerId + threadId + text + markdown', async () => {
    const { fetchImpl, calls } = makeFetch(() =>
      jsonResponse({ data: { createNote: { note: { id: 'n_1' }, error: null } } }),
    );
    const client = createPlainClient('k', { fetchImpl });
    await client.addNote('t_1', 'c_1', 'Completed by Symphony.');
    expect(calls[0]!.op).toBe('createNote');
    expect(calls[0]!.variables).toMatchObject({
      customerId: 'c_1',
      threadId: 't_1',
      text: 'Completed by Symphony.',
      markdown: 'Completed by Symphony.',
    });
  });

  it('addNote throws on a mutation payload error', async () => {
    const { fetchImpl } = makeFetch(() =>
      jsonResponse({ data: { createNote: { note: null, error: { message: 'nope' } } } }),
    );
    const client = createPlainClient('k', { fetchImpl });
    await expect(client.addNote('t_1', 'c_1', 'x')).rejects.toBeInstanceOf(PlainApiError);
  });

  it('markThreadDone sends threadId and succeeds with no payload error', async () => {
    const { fetchImpl, calls } = makeFetch(() =>
      jsonResponse({ data: { markThreadAsDone: { thread: { id: 't_1' }, error: null } } }),
    );
    const client = createPlainClient('k', { fetchImpl });
    await client.markThreadDone('t_1');
    expect(calls[0]!.op).toBe('markDone');
    expect(calls[0]!.variables.threadId).toBe('t_1');
  });

  it('markThreadDone throws on a mutation payload error', async () => {
    const { fetchImpl } = makeFetch(() =>
      jsonResponse({ data: { markThreadAsDone: { thread: null, error: { code: 'forbidden' } } } }),
    );
    const client = createPlainClient('k', { fetchImpl });
    await expect(client.markThreadDone('t_1')).rejects.toBeInstanceOf(PlainApiError);
  });
});

describe('createPlainClient.getWorkspace + error mapping', () => {
  it('returns the workspace id + name', async () => {
    const { fetchImpl } = makeFetch(() => wsOk());
    const client = createPlainClient('k', { fetchImpl });
    expect(await client.getWorkspace()).toEqual({ id: 'ws_1', name: 'Acme Support' });
  });

  it('maps 401 → auth failed', async () => {
    const { fetchImpl } = makeFetch(() => new Response('bad key', { status: 401 }));
    const client = createPlainClient('k', { fetchImpl });
    await expect(client.getWorkspace()).rejects.toMatchObject({ status: 401 });
  });

  it('throws on a GraphQL errors[] payload', async () => {
    const { fetchImpl } = makeFetch(() =>
      jsonResponse({ errors: [{ message: 'Field "threads" not found' }] }),
    );
    const client = createPlainClient('k', { fetchImpl });
    await expect(client.getWorkspace()).rejects.toBeInstanceOf(PlainApiError);
  });

  it('wraps a network throw in PlainApiError', async () => {
    const fetchImpl = (async () => {
      throw new Error('ECONNRESET');
    }) as unknown as typeof fetch;
    const client = createPlainClient('k', { fetchImpl });
    await expect(client.getWorkspace()).rejects.toBeInstanceOf(PlainApiError);
  });

  it('honors a custom apiUrl', async () => {
    const { fetchImpl, calls } = makeFetch(() => wsOk());
    const client = createPlainClient('k', { fetchImpl, apiUrl: 'https://core-api.eu.plain.com/graphql/v1' });
    await client.getWorkspace();
    expect(calls[0]!.url).toBe('https://core-api.eu.plain.com/graphql/v1');
  });
});
