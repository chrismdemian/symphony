/**
 * Phase 9C.2 — unit coverage for the REAL gitlab-source plugin port
 * (`packages/examples/gitlab-source/src/gitlab.ts`). Drives the actual
 * `GitLabSource` with an INJECTED fetch (no network) so the PRIVATE-TOKEN auth,
 * `iid`-keyed externalId, Link-header pagination, single-page ETag cache,
 * multi-project skip-on-fail, and note+close writeback are exercised faithfully.
 */
import { describe, expect, it } from 'vitest';

import {
  GitLabSource,
  GitLabSourceConfigSchema,
  mapGitLabIssue,
  gitlabLabelsToPriority,
  parseGitLabExternalId,
  type GitLabSourceConfig,
  type GitLabIssueNode,
} from '../../packages/examples/gitlab-source/src/gitlab.js';

function config(overrides: Partial<Record<string, unknown>> = {}): GitLabSourceConfig {
  return GitLabSourceConfigSchema.parse({ token: 'glpat_x', projects: ['acme/widgets'], ...overrides });
}

interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}
interface RespSpec {
  status?: number;
  json?: unknown;
  headers?: Record<string, string>;
}

/** A REST fetch fake: `handler(req)` returns a response spec; calls are captured. */
function makeFetch(
  handler: (req: { url: string; method: string; body: string | undefined; headers: Record<string, string> }) => RespSpec,
): { fetchImpl: typeof fetch; calls: Captured[] } {
  const calls: Captured[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? 'GET';
    const body = init?.body === undefined ? undefined : String(init.body);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url: u, method, headers, body });
    const r = handler({ url: u, method, body, headers }) ?? {};
    const status = r.status ?? 200;
    const respHeaders = r.headers ?? {};
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: 'OK',
      json: async () => r.json ?? {},
      text: async () => JSON.stringify(r.json ?? {}),
      headers: { get: (k: string) => respHeaders[k.toLowerCase()] ?? null },
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function rawIssue(
  iid: number,
  state = 'opened',
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: 1000 + iid,
    iid,
    title: `Issue ${iid}`,
    description: 'body',
    state,
    web_url: `https://gitlab.com/acme/widgets/-/issues/${iid}`,
    updated_at: '2026-06-01T00:00:00Z',
    labels: ['priority::high'],
    assignee: { username: 'ada' },
    ...extra,
  };
}

const NODE: GitLabIssueNode = {
  projectPath: 'acme/widgets',
  id: 1001,
  iid: 1,
  title: 'Implement the widget',
  body: 'do the thing',
  state: 'opened',
  webUrl: 'https://gitlab.com/acme/widgets/-/issues/1',
  updatedAt: '2026-06-01T00:00:00Z',
  labels: ['priority::high'],
  assignee: 'ada',
};

describe('9C.2 gitlab-source — pure mapping', () => {
  it('maps an issue to a NormalizedIssue (group/project#iid id, path route, label priority)', () => {
    expect(mapGitLabIssue(NODE)).toEqual({
      externalId: 'acme/widgets#1',
      title: 'Implement the widget',
      url: 'https://gitlab.com/acme/widgets/-/issues/1',
      state: 'opened',
      isTerminal: false,
      body: 'do the thing',
      assignee: 'ada',
      labels: ['priority::high'],
      projectValue: 'acme/widgets',
      priority: 2,
      updatedAt: '2026-06-01T00:00:00Z',
    });
  });

  it('flags a closed issue terminal; nulls empty url', () => {
    const issue = mapGitLabIssue({ ...NODE, state: 'closed', webUrl: '' });
    expect(issue.isTerminal).toBe(true);
    expect(issue.url).toBeNull();
  });

  it('untitled issue falls back to a placeholder with the iid', () => {
    expect(mapGitLabIssue({ ...NODE, title: '   ' }).title).toBe('(untitled GitLab issue acme/widgets#1)');
  });

  it('gitlabLabelsToPriority: takes the highest, handles scoped + bare labels', () => {
    expect(gitlabLabelsToPriority([])).toBe(0);
    expect(gitlabLabelsToPriority(['p4', 'low'])).toBe(0);
    expect(gitlabLabelsToPriority(['medium'])).toBe(1);
    expect(gitlabLabelsToPriority(['priority::high'])).toBe(2);
    expect(gitlabLabelsToPriority(['urgent'])).toBe(3);
    expect(gitlabLabelsToPriority(['p3', 'critical', 'high'])).toBe(3); // highest wins
  });

  it('parseGitLabExternalId: splits on the LAST # (subgroups), strict decimal iid', () => {
    expect(parseGitLabExternalId('acme/widgets#42')).toEqual({ projectPath: 'acme/widgets', iid: 42 });
    expect(parseGitLabExternalId('group/sub/project#7')).toEqual({ projectPath: 'group/sub/project', iid: 7 });
    expect(parseGitLabExternalId('no-hash')).toBeUndefined();
    expect(parseGitLabExternalId('flat#1')).toBeUndefined(); // no `/` in path
    expect(parseGitLabExternalId('acme/widgets#')).toBeUndefined(); // empty iid
    expect(parseGitLabExternalId('acme/widgets#0x1f')).toBeUndefined(); // non-decimal
    expect(parseGitLabExternalId('acme/widgets#0')).toBeUndefined(); // iid must be > 0
  });
});

describe('9C.2 gitlab-source — GitLabSource I/O (injected fetch)', () => {
  it('fetchOpenIssues sends PRIVATE-TOKEN (no Bearer), maps nodes, default limit per_page', async () => {
    const { fetchImpl, calls } = makeFetch((req) =>
      req.url.includes('/issues?') ? { json: [rawIssue(1), rawIssue(2, 'closed')] } : {},
    );
    const issues = await new GitLabSource(config(), fetchImpl).fetchOpenIssues();
    expect(issues.map((i) => i.externalId)).toEqual(['acme/widgets#1', 'acme/widgets#2']);
    expect(issues[1]!.isTerminal).toBe(true);
    // Auth is the PRIVATE-TOKEN header — NOT Authorization: Bearer.
    expect(calls[0]!.headers['private-token']).toBe('glpat_x');
    expect(calls[0]!.headers.authorization).toBeUndefined();
    expect(calls[0]!.url).toContain('per_page=50'); // default fetch limit
    expect(calls[0]!.url).toContain('state=opened');
    // The project path is URL-encoded as the :id segment.
    expect(calls[0]!.url).toContain('/projects/acme%2Fwidgets/issues');
  });

  it('aggregates issues across multiple configured projects', async () => {
    const { fetchImpl } = makeFetch((req) => {
      if (req.url.includes('acme%2Fwidgets')) return { json: [rawIssue(1)] };
      if (req.url.includes('acme%2Fgadgets')) return { json: [rawIssue(5)] };
      return {};
    });
    const src = new GitLabSource(config({ projects: ['acme/widgets', 'acme/gadgets'] }), fetchImpl);
    const issues = await src.fetchOpenIssues();
    expect(issues.map((i) => i.externalId).sort()).toEqual(['acme/gadgets#5', 'acme/widgets#1']);
  });

  it('skips a project that 404s but returns the others; throws only if EVERY project fails', async () => {
    const { fetchImpl } = makeFetch((req) => {
      if (req.url.includes('acme%2Fwidgets')) return { status: 404, json: { message: 'gone' } };
      if (req.url.includes('acme%2Fgadgets')) return { json: [rawIssue(5)] };
      return {};
    });
    const partial = new GitLabSource(config({ projects: ['acme/widgets', 'acme/gadgets'] }), fetchImpl);
    expect((await partial.fetchOpenIssues()).map((i) => i.externalId)).toEqual(['acme/gadgets#5']);

    const { fetchImpl: allFail } = makeFetch(() => ({ status: 403, json: { message: 'no' } }));
    await expect(new GitLabSource(config(), allFail).fetchOpenIssues()).rejects.toThrow(/403/);
  });

  it('single-page ETag: a 304 returns the cached issues + sends If-None-Match', async () => {
    let listCalls = 0;
    const { fetchImpl, calls } = makeFetch((req) => {
      if (req.url.includes('/issues?') && req.method === 'GET') {
        listCalls += 1;
        if (req.headers['if-none-match'] !== undefined) return { status: 304 };
        return { json: [rawIssue(1)], headers: { etag: 'W/"abc"' } };
      }
      return {};
    });
    const src = new GitLabSource(config(), fetchImpl);
    const first = await src.fetchOpenIssues();
    const second = await src.fetchOpenIssues();
    expect(first.map((i) => i.externalId)).toEqual(['acme/widgets#1']);
    expect(second).toEqual(first); // served from cache on the 304
    expect(listCalls).toBe(2);
    expect(calls[1]!.headers['if-none-match']).toBe('W/"abc"');
  });

  it('Link-header pagination: follows rel="next" when limit > one page', async () => {
    const page2 = 'https://gitlab.com/api/v4/projects/acme%2Fwidgets/issues?page=2';
    const { fetchImpl, calls } = makeFetch((req) => {
      if (req.url === page2) return { json: [rawIssue(3), rawIssue(4)] };
      if (req.url.includes('/issues?')) {
        return { json: [rawIssue(1), rawIssue(2)], headers: { link: `<${page2}>; rel="next"` } };
      }
      return {};
    });
    // limit > MAX_PER_PAGE (100) → multi-page semantics, cache bypassed.
    const issues = await new GitLabSource(config(), fetchImpl).fetchOpenIssues(150);
    expect(issues.map((i) => i.externalId)).toEqual([
      'acme/widgets#1',
      'acme/widgets#2',
      'acme/widgets#3',
      'acme/widgets#4',
    ]);
    expect(calls.some((c) => c.url === page2)).toBe(true);
  });

  it('searchIssues maps results from the configured project', async () => {
    const { fetchImpl, calls } = makeFetch((req) =>
      req.url.includes('search=widget') ? { json: [rawIssue(1)] } : {},
    );
    const issues = await new GitLabSource(config(), fetchImpl).searchIssues('widget');
    expect(issues).toHaveLength(1);
    expect(issues[0]!.externalId).toBe('acme/widgets#1');
    expect(calls[0]!.url).toContain('in=title,description');
  });

  it('writeBack completed → note then close (POST notes + PUT state_event=close)', async () => {
    const { fetchImpl, calls } = makeFetch(() => ({}));
    const result = await new GitLabSource(config(), fetchImpl).writeBack('acme/widgets#1', 'completed');
    expect(result).toEqual({ written: true, code: 'written', value: 'noted + closed' });
    const note = calls.find((c) => c.method === 'POST' && c.url.endsWith('/issues/1/notes'))!;
    expect(JSON.parse(note.body!).body).toBe('Completed by Symphony.');
    const close = calls.find((c) => c.method === 'PUT' && c.url.endsWith('/issues/1'))!;
    expect(JSON.parse(close.body!).state_event).toBe('close');
  });

  it('writeBack completed honors a configured note', async () => {
    const { fetchImpl, calls } = makeFetch(() => ({}));
    const src = new GitLabSource(config({ statusWriteback: { completed: 'shipped 🚀' } }), fetchImpl);
    await src.writeBack('acme/widgets#1', 'completed');
    const note = calls.find((c) => c.url.endsWith('/notes'))!;
    expect(JSON.parse(note.body!).body).toBe('shipped 🚀');
  });

  it('writeBack failed → skipped (no calls) when not configured', async () => {
    const { fetchImpl, calls } = makeFetch(() => ({}));
    const result = await new GitLabSource(config(), fetchImpl).writeBack('acme/widgets#1', 'failed');
    expect(result).toEqual({ written: false, code: 'skipped', reason: "no 'failed' writeback configured" });
    expect(calls).toHaveLength(0);
  });

  it('writeBack failed → note only (never closes) when configured', async () => {
    const { fetchImpl, calls } = makeFetch(() => ({}));
    const src = new GitLabSource(config({ statusWriteback: { failed: 'could not finish' } }), fetchImpl);
    const result = await src.writeBack('acme/widgets#1', 'failed');
    expect(result).toEqual({ written: true, code: 'written', value: 'noted (left open)' });
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(0);
  });

  it('writeBack → not-found on a 404; not-found on a malformed id (no calls)', async () => {
    const { fetchImpl } = makeFetch(() => ({ status: 404, json: { message: 'gone' } }));
    expect((await new GitLabSource(config(), fetchImpl).writeBack('acme/widgets#9', 'completed')).code).toBe('not-found');

    const { fetchImpl: f2, calls } = makeFetch(() => ({}));
    const bad = await new GitLabSource(config(), f2).writeBack('not-an-id', 'completed');
    expect(bad.code).toBe('not-found');
    expect(calls).toHaveLength(0);
  });

  it('checkConnection reports the username', async () => {
    const { fetchImpl } = makeFetch((req) => (req.url.endsWith('/user') ? { json: { username: 'ada' } } : {}));
    const result = await new GitLabSource(config(), fetchImpl).checkConnection();
    expect(result.ok).toBe(true);
    expect(result.detail).toContain('ada');
  });
});
