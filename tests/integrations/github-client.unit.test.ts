import { describe, expect, it } from 'vitest';
import { createGitHubClient, GitHubApiError } from '../../src/integrations/github-client.js';

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
  id: 100,
  number: 42,
  title: 'A bug',
  body: 'desc',
  state: 'open',
  html_url: 'https://github.com/acme/app/issues/42',
  updated_at: '2026-06-01T00:00:00Z',
  labels: [{ name: 'bug' }, 'high'],
  assignee: { login: 'dana' },
};

describe('createGitHubClient.listOpenIssues', () => {
  it('sends the correct auth/version headers and URL, maps the issue', async () => {
    const { fetchImpl, calls } = makeFetch(() => jsonResponse([ISSUE]));
    const client = createGitHubClient('ghp_secret', { fetchImpl });
    const issues = await client.listOpenIssues('acme/app', 50);

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.method).toBe('GET');
    expect(call.url).toContain('https://api.github.com/repos/acme/app/issues');
    expect(call.url).toContain('state=open');
    expect(call.url).toContain('sort=updated');
    expect(call.url).toContain('per_page=50');
    expect(call.headers.authorization).toBe('Bearer ghp_secret');
    expect(call.headers.accept).toBe('application/vnd.github+json');
    expect(call.headers['x-github-api-version']).toBe('2022-11-28');

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      repo: 'acme/app',
      id: 100,
      number: 42,
      title: 'A bug',
      state: 'open',
      labels: ['bug', 'high'],
      assignee: 'dana',
    });
  });

  it('filters out pull requests (the pull_request field)', async () => {
    const pr = { ...ISSUE, id: 200, number: 7, pull_request: { url: 'x' } };
    const { fetchImpl } = makeFetch(() => jsonResponse([ISSUE, pr]));
    const client = createGitHubClient('t', { fetchImpl });
    const issues = await client.listOpenIssues('acme/app', 50);
    expect(issues.map((i) => i.number)).toEqual([42]);
  });

  it('honors a GitHub Enterprise apiBaseUrl', async () => {
    const { fetchImpl, calls } = makeFetch(() => jsonResponse([]));
    const client = createGitHubClient('t', {
      fetchImpl,
      apiBaseUrl: 'https://github.acme.com/api/v3/',
    });
    await client.listOpenIssues('acme/app', 10);
    expect(calls[0]!.url).toContain('https://github.acme.com/api/v3/repos/acme/app/issues');
    expect(calls[0]!.url).not.toContain('//repos'); // trailing slash normalized
  });

  it('caches by ETag and returns the cached result on 304', async () => {
    let n = 0;
    const { fetchImpl, calls } = makeFetch((call) => {
      n += 1;
      if (n === 1) return jsonResponse([ISSUE], { headers: { etag: 'W/"abc"' } });
      // Second call should carry If-None-Match → respond 304.
      expect(call.headers['if-none-match']).toBe('W/"abc"');
      return new Response(null, { status: 304, headers: { etag: 'W/"abc"' } });
    });
    const client = createGitHubClient('t', { fetchImpl });
    const first = await client.listOpenIssues('acme/app', 50);
    const second = await client.listOpenIssues('acme/app', 50);
    expect(first).toEqual(second);
    expect(second[0]!.number).toBe(42);
    expect(calls).toHaveLength(2);
  });

  it('paginates via the Link header when limit exceeds one page', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({ ...ISSUE, id: i + 1, number: i + 1 }));
    const page2 = [{ ...ISSUE, id: 101, number: 101 }];
    const { fetchImpl, calls } = makeFetch((_call, index) => {
      if (index === 0) {
        return jsonResponse(page1, {
          headers: {
            link: '<https://api.github.com/repositories/1/issues?page=2>; rel="next"',
          },
        });
      }
      return jsonResponse(page2);
    });
    const client = createGitHubClient('t', { fetchImpl });
    const issues = await client.listOpenIssues('acme/app', 150);
    expect(issues).toHaveLength(101);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.url).toBe('https://api.github.com/repositories/1/issues?page=2');
  });

  it('does NOT use the ETag cache for multi-page (limit > 100) requests', async () => {
    // A 304 on page 1 can't prove later pages are unchanged, so multi-page
    // requests must fetch unconditionally and never send If-None-Match.
    const page1 = Array.from({ length: 100 }, (_, i) => ({ ...ISSUE, id: i + 1, number: i + 1 }));
    const { fetchImpl, calls } = makeFetch((_call, index) => {
      // page requests alternate: even index = page 1, odd = page 2
      if (index % 2 === 0) {
        return jsonResponse(page1, {
          headers: {
            etag: 'W/"p1"',
            link: '<https://api.github.com/x?page=2>; rel="next"',
          },
        });
      }
      return jsonResponse([{ ...ISSUE, id: 101, number: 101 }]);
    });
    const client = createGitHubClient('t', { fetchImpl });
    await client.listOpenIssues('acme/app', 150);
    await client.listOpenIssues('acme/app', 150);
    // 4 calls total (2 pages × 2 invocations); no If-None-Match ever sent.
    expect(calls).toHaveLength(4);
    expect(calls.every((c) => c.headers['if-none-match'] === undefined)).toBe(true);
  });

  it('does NOT paginate when the first page already satisfies the limit', async () => {
    const page1 = Array.from({ length: 10 }, (_, i) => ({ ...ISSUE, id: i + 1, number: i + 1 }));
    const { fetchImpl, calls } = makeFetch(() =>
      jsonResponse(page1, {
        headers: { link: '<https://api.github.com/x?page=2>; rel="next"' },
      }),
    );
    const client = createGitHubClient('t', { fetchImpl });
    const issues = await client.listOpenIssues('acme/app', 10);
    expect(issues).toHaveLength(10);
    expect(calls).toHaveLength(1); // limit satisfied; no follow-up
  });
});

describe('createGitHubClient.searchIssues', () => {
  it('builds a search query with repo qualifiers and derives repo from repository_url', async () => {
    const item = { ...ISSUE, repository_url: 'https://api.github.com/repos/acme/api' };
    const { fetchImpl, calls } = makeFetch(() => jsonResponse({ items: [item] }));
    const client = createGitHubClient('t', { fetchImpl });
    const issues = await client.searchIssues('crash', 20, ['acme/app', 'acme/api']);
    expect(calls[0]!.url).toContain('/search/issues');
    const decoded = decodeURIComponent(calls[0]!.url);
    expect(decoded).toContain('is:issue is:open');
    expect(decoded).toContain('repo:acme/app');
    expect(decoded).toContain('repo:acme/api');
    expect(issues[0]!.repo).toBe('acme/api');
  });
});

describe('createGitHubClient.addComment / closeIssue', () => {
  it('POSTs a comment with a JSON body', async () => {
    const { fetchImpl, calls } = makeFetch(() => new Response(null, { status: 201 }));
    const client = createGitHubClient('t', { fetchImpl });
    await client.addComment('acme/app', 42, 'hi there');
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.url).toBe('https://api.github.com/repos/acme/app/issues/42/comments');
    expect(JSON.parse(calls[0]!.body!)).toEqual({ body: 'hi there' });
  });

  it('PATCHes state=closed', async () => {
    const { fetchImpl, calls } = makeFetch(() => jsonResponse({ state: 'closed' }));
    const client = createGitHubClient('t', { fetchImpl });
    await client.closeIssue('acme/app', 42);
    expect(calls[0]!.method).toBe('PATCH');
    expect(calls[0]!.url).toBe('https://api.github.com/repos/acme/app/issues/42');
    expect(JSON.parse(calls[0]!.body!)).toEqual({ state: 'closed' });
  });
});

describe('createGitHubClient error mapping', () => {
  it('maps 401 → auth failed', async () => {
    const { fetchImpl } = makeFetch(() => new Response('bad creds', { status: 401 }));
    const client = createGitHubClient('t', { fetchImpl });
    await expect(client.getViewer()).rejects.toMatchObject({ status: 401 });
  });

  it('maps 403 with remaining=0 → rate limit', async () => {
    const { fetchImpl } = makeFetch(() =>
      new Response('limit', { status: 403, headers: { 'x-ratelimit-remaining': '0' } }),
    );
    const client = createGitHubClient('t', { fetchImpl });
    await expect(client.listOpenIssues('a/b', 10)).rejects.toThrowError(/rate limit/);
  });

  it('maps 404 → not found with the right status', async () => {
    const { fetchImpl } = makeFetch(() => new Response('nope', { status: 404 }));
    const client = createGitHubClient('t', { fetchImpl });
    await expect(client.listOpenIssues('a/b', 10)).rejects.toMatchObject({ status: 404 });
  });

  it('wraps a network throw in GitHubApiError', async () => {
    const fetchImpl = (async () => {
      throw new Error('ECONNRESET');
    }) as unknown as typeof fetch;
    const client = createGitHubClient('t', { fetchImpl });
    await expect(client.getViewer()).rejects.toBeInstanceOf(GitHubApiError);
  });
});
