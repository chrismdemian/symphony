import { describe, expect, it } from 'vitest';
import { createGitLabClient, GitLabApiError } from '../../src/integrations/gitlab-client.js';

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

function jsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
}

const ISSUE = {
  id: 9001,
  iid: 42,
  title: 'A bug',
  description: 'desc',
  state: 'opened',
  web_url: 'https://gitlab.com/acme/app/-/issues/42',
  updated_at: '2026-06-01T00:00:00Z',
  labels: ['bug', 'priority::high'],
  assignee: { username: 'dana', name: 'Dana Q' },
};

describe('createGitLabClient.listOpenIssues', () => {
  it('sends PRIVATE-TOKEN + encoded project path + correct query, maps the issue', async () => {
    const { fetchImpl, calls } = makeFetch(() => jsonResponse([ISSUE]));
    const client = createGitLabClient('glpat-secret', { fetchImpl });
    const issues = await client.listOpenIssues('acme/app', 50);

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.method).toBe('GET');
    expect(call.url).toContain('https://gitlab.com/api/v4/projects/acme%2Fapp/issues');
    expect(call.url).toContain('state=opened');
    expect(call.url).toContain('order_by=updated_at');
    expect(call.url).toContain('per_page=50');
    expect(call.headers['private-token']).toBe('glpat-secret');
    expect(call.headers.authorization).toBeUndefined(); // PRIVATE-TOKEN, not Bearer

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      projectPath: 'acme/app',
      id: 9001,
      iid: 42,
      title: 'A bug',
      state: 'opened',
      labels: ['bug', 'priority::high'],
      assignee: 'dana',
    });
  });

  it('URL-encodes a subgroup path (group/subgroup/project → %2F)', async () => {
    const { fetchImpl, calls } = makeFetch(() => jsonResponse([]));
    const client = createGitLabClient('t', { fetchImpl });
    await client.listOpenIssues('acme/team/app', 10);
    expect(calls[0]!.url).toContain('/api/v4/projects/acme%2Fteam%2Fapp/issues');
  });

  it('honors a self-hosted siteUrl and normalizes a trailing slash', async () => {
    const { fetchImpl, calls } = makeFetch(() => jsonResponse([]));
    const client = createGitLabClient('t', { fetchImpl, siteUrl: 'https://gitlab.acme.com/' });
    await client.listOpenIssues('acme/app', 10);
    expect(calls[0]!.url).toContain('https://gitlab.acme.com/api/v4/projects/acme%2Fapp/issues');
    expect(calls[0]!.url).not.toContain('//api/v4'); // trailing slash normalized
  });

  it('caches by ETag and returns the cached result on 304', async () => {
    let n = 0;
    const { fetchImpl, calls } = makeFetch((call) => {
      n += 1;
      if (n === 1) return jsonResponse([ISSUE], { headers: { etag: 'W/"abc"' } });
      expect(call.headers['if-none-match']).toBe('W/"abc"');
      return new Response(null, { status: 304, headers: { etag: 'W/"abc"' } });
    });
    const client = createGitLabClient('t', { fetchImpl });
    const first = await client.listOpenIssues('acme/app', 50);
    const second = await client.listOpenIssues('acme/app', 50);
    expect(first).toEqual(second);
    expect(second[0]!.iid).toBe(42);
    expect(calls).toHaveLength(2);
  });

  it('paginates via the Link header when limit exceeds one page', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({ ...ISSUE, id: i + 1, iid: i + 1 }));
    const page2 = [{ ...ISSUE, id: 101, iid: 101 }];
    const { fetchImpl, calls } = makeFetch((_call, index) => {
      if (index === 0) {
        return jsonResponse(page1, {
          headers: { link: '<https://gitlab.com/api/v4/projects/1/issues?page=2>; rel="next"' },
        });
      }
      return jsonResponse(page2);
    });
    const client = createGitLabClient('t', { fetchImpl });
    const issues = await client.listOpenIssues('acme/app', 150);
    expect(issues).toHaveLength(101);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.url).toBe('https://gitlab.com/api/v4/projects/1/issues?page=2');
  });

  it('does NOT use the ETag cache for multi-page (limit > 100) requests', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({ ...ISSUE, id: i + 1, iid: i + 1 }));
    const { fetchImpl, calls } = makeFetch((_call, index) => {
      if (index % 2 === 0) {
        return jsonResponse(page1, {
          headers: { etag: 'W/"p1"', link: '<https://gitlab.com/x?page=2>; rel="next"' },
        });
      }
      return jsonResponse([{ ...ISSUE, id: 101, iid: 101 }]);
    });
    const client = createGitLabClient('t', { fetchImpl });
    await client.listOpenIssues('acme/app', 150);
    await client.listOpenIssues('acme/app', 150);
    expect(calls).toHaveLength(4);
    expect(calls.every((c) => c.headers['if-none-match'] === undefined)).toBe(true);
  });
});

describe('createGitLabClient.searchIssues', () => {
  it('builds a search query scoped to title+description', async () => {
    const { fetchImpl, calls } = makeFetch(() => jsonResponse([ISSUE]));
    const client = createGitLabClient('t', { fetchImpl });
    const issues = await client.searchIssues('crash', 20, 'acme/app');
    expect(calls[0]!.url).toContain('/api/v4/projects/acme%2Fapp/issues');
    const decoded = decodeURIComponent(calls[0]!.url);
    expect(decoded).toContain('search=crash');
    expect(decoded).toContain('in=title,description');
    expect(issues[0]!.iid).toBe(42);
  });
});

describe('createGitLabClient.addNote / closeIssue', () => {
  it('POSTs a note with a JSON body to the iid path', async () => {
    const { fetchImpl, calls } = makeFetch(() => new Response(null, { status: 201 }));
    const client = createGitLabClient('t', { fetchImpl });
    await client.addNote('acme/app', 42, 'hi there');
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.url).toBe('https://gitlab.com/api/v4/projects/acme%2Fapp/issues/42/notes');
    expect(JSON.parse(calls[0]!.body!)).toEqual({ body: 'hi there' });
  });

  it('PUTs state_event=close to the iid path', async () => {
    const { fetchImpl, calls } = makeFetch(() => jsonResponse({ state: 'closed' }));
    const client = createGitLabClient('t', { fetchImpl });
    await client.closeIssue('acme/app', 42);
    expect(calls[0]!.method).toBe('PUT');
    expect(calls[0]!.url).toBe('https://gitlab.com/api/v4/projects/acme%2Fapp/issues/42');
    expect(JSON.parse(calls[0]!.body!)).toEqual({ state_event: 'close' });
  });
});

describe('createGitLabClient error mapping', () => {
  it('maps 401 → auth failed', async () => {
    const { fetchImpl } = makeFetch(() => new Response('bad creds', { status: 401 }));
    const client = createGitLabClient('t', { fetchImpl });
    await expect(client.getViewer()).rejects.toMatchObject({ status: 401 });
  });

  it('maps 403 → forbidden', async () => {
    const { fetchImpl } = makeFetch(() => new Response('nope', { status: 403 }));
    const client = createGitLabClient('t', { fetchImpl });
    await expect(client.listOpenIssues('a/b', 10)).rejects.toMatchObject({ status: 403 });
  });

  it('maps 404 → not found with the right status', async () => {
    const { fetchImpl } = makeFetch(() => new Response('nope', { status: 404 }));
    const client = createGitLabClient('t', { fetchImpl });
    await expect(client.listOpenIssues('a/b', 10)).rejects.toMatchObject({ status: 404 });
  });

  it('wraps a network throw in GitLabApiError', async () => {
    const fetchImpl = (async () => {
      throw new Error('ECONNRESET');
    }) as unknown as typeof fetch;
    const client = createGitLabClient('t', { fetchImpl });
    await expect(client.getViewer()).rejects.toBeInstanceOf(GitLabApiError);
  });

  it('getViewer returns the username', async () => {
    const { fetchImpl } = makeFetch(() => jsonResponse({ username: 'chris' }));
    const client = createGitLabClient('t', { fetchImpl });
    expect(await client.getViewer()).toEqual({ username: 'chris' });
  });
});
