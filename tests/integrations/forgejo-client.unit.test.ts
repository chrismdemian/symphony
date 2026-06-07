import { describe, expect, it } from 'vitest';
import { createForgejoClient, ForgejoApiError } from '../../src/integrations/forgejo-client.js';

interface Call {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body?: string;
}

/** A fetch fake driven by a per-call handler; records every request. */
function makeFetch(
  handler: (call: Call, index: number) => Response,
): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const call: Call = {
      url: String(url),
      method: init?.method ?? 'GET',
      headers,
      ...(typeof init?.body === 'string' ? { body: init.body } : {}),
    };
    const index = calls.length;
    calls.push(call);
    return handler(call, index);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function jsonResponse(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
}

const SITE = 'https://code.acme.com';

const ISSUE = {
  id: 9001,
  number: 42,
  title: 'A bug',
  body: 'desc',
  state: 'open',
  html_url: 'https://code.acme.com/acme/app/issues/42',
  updated_at: '2026-06-01T00:00:00Z',
  labels: [{ name: 'bug' }, { name: 'priority/high' }],
  assignee: { login: 'dana', full_name: 'Dana Q' },
  pull_request: null,
};

describe('createForgejoClient.listOpenIssues', () => {
  it('sends `token` auth + /api/v1 path + correct query, maps the issue', async () => {
    const { fetchImpl, calls } = makeFetch(() => jsonResponse([ISSUE]));
    const client = createForgejoClient('fj-secret', { fetchImpl, siteUrl: SITE });
    const issues = await client.listOpenIssues('acme/app', 50);

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.method).toBe('GET');
    expect(call.url).toContain('https://code.acme.com/api/v1/repos/acme/app/issues');
    expect(call.url).toContain('state=open');
    expect(call.url).toContain('type=issues');
    expect(call.url).toContain('limit=50');
    expect(call.headers.authorization).toBe('token fj-secret'); // Gitea scheme, NOT Bearer

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      repo: 'acme/app',
      id: 9001,
      number: 42,
      title: 'A bug',
      state: 'open',
      labels: ['bug', 'priority/high'],
      assignee: 'dana',
    });
  });

  it('filters out pull requests (non-null pull_request field)', async () => {
    const pr = { ...ISSUE, id: 1, number: 7, pull_request: { merged: false } };
    const { fetchImpl } = makeFetch(() => jsonResponse([pr, ISSUE]));
    const client = createForgejoClient('t', { fetchImpl, siteUrl: SITE });
    const issues = await client.listOpenIssues('acme/app', 50);
    expect(issues.map((i) => i.number)).toEqual([42]);
  });

  it('normalizes a trailing slash on the site URL', async () => {
    const { fetchImpl, calls } = makeFetch(() => jsonResponse([]));
    const client = createForgejoClient('t', { fetchImpl, siteUrl: 'https://code.acme.com/' });
    await client.listOpenIssues('acme/app', 10);
    expect(calls[0]!.url).toContain('https://code.acme.com/api/v1/repos/acme/app/issues');
    expect(calls[0]!.url).not.toContain('//api/v1'); // trailing slash normalized
  });

  it('caches by ETag and returns the cached result on 304', async () => {
    let n = 0;
    const { fetchImpl, calls } = makeFetch((call) => {
      n += 1;
      if (n === 1) return jsonResponse([ISSUE], { headers: { etag: 'W/"abc"' } });
      expect(call.headers['if-none-match']).toBe('W/"abc"');
      return new Response(null, { status: 304, headers: { etag: 'W/"abc"' } });
    });
    const client = createForgejoClient('t', { fetchImpl, siteUrl: SITE });
    const first = await client.listOpenIssues('acme/app', 50);
    const second = await client.listOpenIssues('acme/app', 50);
    expect(first).toEqual(second);
    expect(second[0]!.number).toBe(42);
    expect(calls).toHaveLength(2);
  });

  it('paginates by page when limit exceeds one page', async () => {
    const page1 = Array.from({ length: 50 }, (_, i) => ({ ...ISSUE, id: i + 1, number: i + 1 }));
    const page2 = [{ ...ISSUE, id: 101, number: 101 }];
    const { fetchImpl, calls } = makeFetch((_call, index) =>
      jsonResponse(index === 0 ? page1 : page2),
    );
    const client = createForgejoClient('t', { fetchImpl, siteUrl: SITE });
    const issues = await client.listOpenIssues('acme/app', 60);
    expect(issues).toHaveLength(51);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.url).toContain('page=2');
    expect(calls[1]!.url).toContain('limit=50');
  });

  it('does NOT use the ETag cache for multi-page (limit > one page) requests', async () => {
    const page1 = Array.from({ length: 50 }, (_, i) => ({ ...ISSUE, id: i + 1, number: i + 1 }));
    const { fetchImpl, calls } = makeFetch((_call, index) =>
      index % 2 === 0
        ? jsonResponse(page1, { headers: { etag: 'W/"p1"' } })
        : jsonResponse([{ ...ISSUE, id: 101, number: 101 }]),
    );
    const client = createForgejoClient('t', { fetchImpl, siteUrl: SITE });
    await client.listOpenIssues('acme/app', 60);
    await client.listOpenIssues('acme/app', 60);
    expect(calls).toHaveLength(4);
    expect(calls.every((c) => c.headers['if-none-match'] === undefined)).toBe(true);
  });
});

describe('createForgejoClient.searchIssues', () => {
  it('builds a `q` query scoped to the repo and excludes PRs', async () => {
    const { fetchImpl, calls } = makeFetch(() => jsonResponse([ISSUE]));
    const client = createForgejoClient('t', { fetchImpl, siteUrl: SITE });
    const issues = await client.searchIssues('crash', 20, 'acme/app');
    expect(calls[0]!.url).toContain('/api/v1/repos/acme/app/issues');
    const decoded = decodeURIComponent(calls[0]!.url);
    expect(decoded).toContain('q=crash');
    expect(decoded).toContain('type=issues');
    expect(issues[0]!.number).toBe(42);
  });
});

describe('createForgejoClient.addComment / closeIssue', () => {
  it('POSTs a comment with a JSON body to the issue number path', async () => {
    const { fetchImpl, calls } = makeFetch(() => new Response(null, { status: 201 }));
    const client = createForgejoClient('t', { fetchImpl, siteUrl: SITE });
    await client.addComment('acme/app', 42, 'hi there');
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.url).toBe('https://code.acme.com/api/v1/repos/acme/app/issues/42/comments');
    expect(JSON.parse(calls[0]!.body!)).toEqual({ body: 'hi there' });
  });

  it('PATCHes state=closed to the issue number path', async () => {
    const { fetchImpl, calls } = makeFetch(() => jsonResponse({ state: 'closed' }));
    const client = createForgejoClient('t', { fetchImpl, siteUrl: SITE });
    await client.closeIssue('acme/app', 42);
    expect(calls[0]!.method).toBe('PATCH');
    expect(calls[0]!.url).toBe('https://code.acme.com/api/v1/repos/acme/app/issues/42');
    expect(JSON.parse(calls[0]!.body!)).toEqual({ state: 'closed' });
  });
});

describe('createForgejoClient error mapping', () => {
  it('maps 401 → auth failed', async () => {
    const { fetchImpl } = makeFetch(() => new Response('bad creds', { status: 401 }));
    const client = createForgejoClient('t', { fetchImpl, siteUrl: SITE });
    await expect(client.getViewer()).rejects.toMatchObject({ status: 401 });
  });

  it('maps 403 → forbidden', async () => {
    const { fetchImpl } = makeFetch(() => new Response('nope', { status: 403 }));
    const client = createForgejoClient('t', { fetchImpl, siteUrl: SITE });
    await expect(client.listOpenIssues('a/b', 10)).rejects.toMatchObject({ status: 403 });
  });

  it('maps 404 → not found with the right status', async () => {
    const { fetchImpl } = makeFetch(() => new Response('nope', { status: 404 }));
    const client = createForgejoClient('t', { fetchImpl, siteUrl: SITE });
    await expect(client.listOpenIssues('a/b', 10)).rejects.toMatchObject({ status: 404 });
  });

  it('wraps a network throw in ForgejoApiError', async () => {
    const fetchImpl = (async () => {
      throw new Error('ECONNRESET');
    }) as unknown as typeof fetch;
    const client = createForgejoClient('t', { fetchImpl, siteUrl: SITE });
    await expect(client.getViewer()).rejects.toBeInstanceOf(ForgejoApiError);
  });

  it('getViewer returns the login', async () => {
    const { fetchImpl } = makeFetch(() => jsonResponse({ login: 'chris' }));
    const client = createForgejoClient('t', { fetchImpl, siteUrl: SITE });
    expect(await client.getViewer()).toEqual({ login: 'chris' });
  });
});
