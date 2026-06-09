import { describe, expect, it } from 'vitest';
import { createSentryClient, SentryApiError } from '../../src/integrations/sentry-client.js';

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

const ORG = 'acme';
const BASE = 'https://sentry.io';

const ISSUE = {
  id: '123456',
  shortId: 'BACKEND-7',
  title: 'TypeError: undefined is not a function',
  culprit: 'app/handler in process',
  permalink: 'https://sentry.io/organizations/acme/issues/123456/',
  status: 'unresolved',
  level: 'error',
  lastSeen: '2026-06-08T00:00:00Z',
  metadata: { value: 'undefined is not a function', type: 'TypeError' },
  assignedTo: { name: 'Dana', email: 'dana@acme.com', type: 'user' },
};

function client(fetchImpl: typeof fetch, baseUrl = BASE) {
  return createSentryClient('sntry-secret', { org: ORG, baseUrl, fetchImpl });
}

describe('createSentryClient.listUnresolvedIssues', () => {
  it('sends Bearer auth + /api/0 project path + correct query, maps the issue', async () => {
    const { fetchImpl, calls } = makeFetch(() => jsonResponse([ISSUE]));
    const issues = await client(fetchImpl).listUnresolvedIssues('backend', 50);

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.method).toBe('GET');
    expect(call.url).toContain('https://sentry.io/api/0/projects/acme/backend/issues/');
    const decoded = decodeURIComponent(call.url);
    expect(decoded).toContain('query=is:unresolved');
    expect(decoded).toContain('sort=new');
    expect(call.url).toContain('statsPeriod=');
    expect(call.url).toContain('limit=50');
    expect(call.headers.authorization).toBe('Bearer sntry-secret'); // Bearer, not a DSN

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      project: 'backend',
      id: '123456',
      shortId: 'BACKEND-7',
      title: 'TypeError: undefined is not a function',
      culprit: 'app/handler in process',
      permalink: 'https://sentry.io/organizations/acme/issues/123456/',
      status: 'unresolved',
      level: 'error',
      lastSeen: '2026-06-08T00:00:00Z',
      assignee: 'Dana',
    });
  });

  it('coerces a numeric id to a string and falls back to metadata.value for the title', async () => {
    const raw = { ...ISSUE, id: 999, title: null };
    const { fetchImpl } = makeFetch(() => jsonResponse([raw]));
    const [issue] = await client(fetchImpl).listUnresolvedIssues('backend', 10);
    expect(issue!.id).toBe('999');
    expect(issue!.title).toBe('undefined is not a function');
  });

  it('normalizes a trailing slash on the base URL', async () => {
    const { fetchImpl, calls } = makeFetch(() => jsonResponse([]));
    await client(fetchImpl, 'https://sentry.io/').listUnresolvedIssues('backend', 10);
    expect(calls[0]!.url).toContain('https://sentry.io/api/0/projects/acme/backend/issues/');
    expect(calls[0]!.url).not.toContain('//api/0');
  });

  it('follows the Link cursor only while results="true"', async () => {
    const page1Link =
      '<https://sentry.io/api/0/projects/acme/backend/issues/?&cursor=0:0:1>; rel="previous"; results="false"; cursor="0:0:1", ' +
      '<https://sentry.io/api/0/projects/acme/backend/issues/?&cursor=0:100:0>; rel="next"; results="true"; cursor="0:100:0"';
    const page2Link =
      '<https://sentry.io/api/0/projects/acme/backend/issues/?&cursor=0:200:0>; rel="next"; results="false"; cursor="0:200:0"';
    const p1 = Array.from({ length: 100 }, (_, i) => ({ ...ISSUE, id: String(i + 1) }));
    const p2 = [{ ...ISSUE, id: '101' }];
    const { fetchImpl, calls } = makeFetch((_call, index) =>
      index === 0
        ? jsonResponse(p1, { headers: { link: page1Link } })
        : jsonResponse(p2, { headers: { link: page2Link } }),
    );
    const issues = await client(fetchImpl).listUnresolvedIssues('backend', 150);
    expect(issues).toHaveLength(101);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.url).toContain('cursor=0:100:0');
  });

  it('stops after one page when results="false" (no further fetch)', async () => {
    const link =
      '<https://sentry.io/api/0/projects/acme/backend/issues/?&cursor=0:100:0>; rel="next"; results="false"; cursor="0:100:0"';
    const { fetchImpl, calls } = makeFetch(() =>
      jsonResponse([ISSUE], { headers: { link } }),
    );
    await client(fetchImpl).listUnresolvedIssues('backend', 150);
    expect(calls).toHaveLength(1);
  });
});

describe('createSentryClient.searchIssues', () => {
  it('prefixes the term with is:unresolved', async () => {
    const { fetchImpl, calls } = makeFetch(() => jsonResponse([ISSUE]));
    await client(fetchImpl).searchIssues('TypeError', 20, 'backend');
    const decoded = decodeURIComponent(calls[0]!.url);
    expect(decoded).toContain('query=is:unresolved TypeError');
  });
});

describe('createSentryClient.addNote / resolveIssue', () => {
  it('POSTs a note with a `text` body to the issue-level notes path', async () => {
    const { fetchImpl, calls } = makeFetch(() => new Response(null, { status: 201 }));
    await client(fetchImpl).addNote('123456', 'looked into it');
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.url).toBe('https://sentry.io/api/0/issues/123456/notes/');
    expect(JSON.parse(calls[0]!.body!)).toEqual({ text: 'looked into it' });
  });

  it('PUTs status=resolved to the org-scoped issue path', async () => {
    const { fetchImpl, calls } = makeFetch(() => jsonResponse({ status: 'resolved' }));
    await client(fetchImpl).resolveIssue('123456');
    expect(calls[0]!.method).toBe('PUT');
    expect(calls[0]!.url).toBe('https://sentry.io/api/0/organizations/acme/issues/123456/');
    expect(JSON.parse(calls[0]!.body!)).toEqual({ status: 'resolved' });
  });
});

describe('createSentryClient error mapping', () => {
  it('maps 401 → auth failed', async () => {
    const { fetchImpl } = makeFetch(() => new Response('bad token', { status: 401 }));
    await expect(client(fetchImpl).listUnresolvedIssues('backend', 10)).rejects.toMatchObject({ status: 401 });
  });

  it('maps 403 → forbidden', async () => {
    const { fetchImpl } = makeFetch(() => new Response('nope', { status: 403 }));
    await expect(client(fetchImpl).listUnresolvedIssues('backend', 10)).rejects.toMatchObject({ status: 403 });
  });

  it('maps 404 → not found', async () => {
    const { fetchImpl } = makeFetch(() => new Response('nope', { status: 404 }));
    await expect(client(fetchImpl).resolveIssue('1')).rejects.toMatchObject({ status: 404 });
  });

  it('wraps a network throw in SentryApiError', async () => {
    const fetchImpl = (async () => {
      throw new Error('ECONNRESET');
    }) as unknown as typeof fetch;
    await expect(client(fetchImpl).addNote('1', 'x')).rejects.toBeInstanceOf(SentryApiError);
  });
});
