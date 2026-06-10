/**
 * Phase 9C.2 — unit coverage for the REAL forgejo-source plugin port
 * (`packages/examples/forgejo-source/src/forgejo.ts`). Drives the actual
 * `ForgejoSource` with an INJECTED fetch (no network) so the `Authorization:
 * token` auth, `owner/repo#number` externalId, PR filtering, page-based
 * pagination, single-page ETag cache, multi-repo skip-on-fail, and comment+close
 * writeback are exercised faithfully.
 */
import { describe, expect, it } from 'vitest';

import {
  ForgejoSource,
  ForgejoSourceConfigSchema,
  mapForgejoIssue,
  forgejoLabelsToPriority,
  parseForgejoExternalId,
  type ForgejoSourceConfig,
  type ForgejoIssueNode,
} from '../../packages/examples/forgejo-source/src/forgejo.js';

function config(overrides: Partial<Record<string, unknown>> = {}): ForgejoSourceConfig {
  return ForgejoSourceConfigSchema.parse({
    token: 'fj_x',
    siteUrl: 'https://code.acme.com',
    repos: ['acme/repo'],
    ...overrides,
  });
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
  number: number,
  state = 'open',
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: 1000 + number,
    number,
    title: `Issue ${number}`,
    body: 'body',
    state,
    html_url: `https://code.acme.com/acme/repo/issues/${number}`,
    updated_at: '2026-06-01T00:00:00Z',
    labels: [{ name: 'priority/high' }],
    assignee: { login: 'ada' },
    ...extra,
  };
}

const NODE: ForgejoIssueNode = {
  repo: 'acme/repo',
  id: 1001,
  number: 1,
  title: 'Implement the widget',
  body: 'do the thing',
  state: 'open',
  htmlUrl: 'https://code.acme.com/acme/repo/issues/1',
  updatedAt: '2026-06-01T00:00:00Z',
  labels: ['priority/high'],
  assignee: 'ada',
};

describe('9C.2 forgejo-source — pure mapping', () => {
  it('maps an issue to a NormalizedIssue (owner/repo#number id, repo route, label priority)', () => {
    expect(mapForgejoIssue(NODE)).toEqual({
      externalId: 'acme/repo#1',
      title: 'Implement the widget',
      url: 'https://code.acme.com/acme/repo/issues/1',
      state: 'open',
      isTerminal: false,
      body: 'do the thing',
      assignee: 'ada',
      labels: ['priority/high'],
      projectValue: 'acme/repo',
      priority: 2,
      updatedAt: '2026-06-01T00:00:00Z',
    });
  });

  it('flags a closed issue terminal; nulls empty url', () => {
    const issue = mapForgejoIssue({ ...NODE, state: 'closed', htmlUrl: '' });
    expect(issue.isTerminal).toBe(true);
    expect(issue.url).toBeNull();
  });

  it('untitled issue falls back to a placeholder with the number', () => {
    expect(mapForgejoIssue({ ...NODE, title: '   ' }).title).toBe('(untitled Forgejo issue acme/repo#1)');
  });

  it('forgejoLabelsToPriority: takes the highest, handles scoped + bare labels', () => {
    expect(forgejoLabelsToPriority([])).toBe(0);
    expect(forgejoLabelsToPriority(['p4', 'low'])).toBe(0);
    expect(forgejoLabelsToPriority(['medium'])).toBe(1);
    expect(forgejoLabelsToPriority(['priority/high'])).toBe(2);
    expect(forgejoLabelsToPriority(['urgent'])).toBe(3);
    expect(forgejoLabelsToPriority(['p3', 'critical', 'high'])).toBe(3); // highest wins
  });

  it('parseForgejoExternalId: splits on the LAST # , strict decimal number', () => {
    expect(parseForgejoExternalId('acme/repo#42')).toEqual({ repo: 'acme/repo', number: 42 });
    expect(parseForgejoExternalId('no-hash')).toBeUndefined();
    expect(parseForgejoExternalId('flat#1')).toBeUndefined(); // no `/` in repo
    expect(parseForgejoExternalId('acme/repo#')).toBeUndefined(); // empty number
    expect(parseForgejoExternalId('acme/repo#1f')).toBeUndefined(); // non-decimal
    expect(parseForgejoExternalId('acme/repo#0')).toBeUndefined(); // number must be > 0
  });
});

describe('9C.2 forgejo-source — ForgejoSource I/O (injected fetch)', () => {
  it('fetchOpenIssues sends Authorization: token (no Bearer), maps nodes, type=issues', async () => {
    const { fetchImpl, calls } = makeFetch((req) =>
      req.url.includes('/issues?') ? { json: [rawIssue(1), rawIssue(2, 'closed')] } : {},
    );
    const issues = await new ForgejoSource(config(), fetchImpl).fetchOpenIssues();
    expect(issues.map((i) => i.externalId)).toEqual(['acme/repo#1', 'acme/repo#2']);
    expect(issues[1]!.isTerminal).toBe(true);
    // Auth is `token <pat>` — NOT Bearer, NOT PRIVATE-TOKEN.
    expect(calls[0]!.headers.authorization).toBe('token fj_x');
    expect(calls[0]!.url).toContain('type=issues');
    expect(calls[0]!.url).toContain('/api/v1/repos/acme/repo/issues');
  });

  it('filters out pull requests (pull_request field non-null)', async () => {
    const { fetchImpl } = makeFetch((req) =>
      req.url.includes('/issues?')
        ? { json: [rawIssue(1), { ...rawIssue(2), pull_request: { merged: false } }, rawIssue(3)] }
        : {},
    );
    const issues = await new ForgejoSource(config(), fetchImpl).fetchOpenIssues();
    expect(issues.map((i) => i.externalId)).toEqual(['acme/repo#1', 'acme/repo#3']); // #2 (a PR) dropped
  });

  it('aggregates across repos; skips a repo that 404s; throws only if EVERY repo fails', async () => {
    const { fetchImpl } = makeFetch((req) => {
      if (req.url.includes('/repos/acme/a/')) return { status: 404, json: { message: 'gone' } };
      if (req.url.includes('/repos/acme/b/')) return { json: [rawIssue(5)] };
      return {};
    });
    const partial = new ForgejoSource(config({ repos: ['acme/a', 'acme/b'] }), fetchImpl);
    expect((await partial.fetchOpenIssues()).map((i) => i.externalId)).toEqual(['acme/b#5']);

    const { fetchImpl: allFail } = makeFetch(() => ({ status: 403, json: { message: 'no' } }));
    await expect(new ForgejoSource(config(), allFail).fetchOpenIssues()).rejects.toThrow(/403/);
  });

  it('single-page ETag: a 304 returns the cached issues + sends If-None-Match', async () => {
    let listCalls = 0;
    const { fetchImpl, calls } = makeFetch((req) => {
      if (req.url.includes('/issues?') && req.method === 'GET') {
        listCalls += 1;
        if (req.headers['if-none-match'] !== undefined) return { status: 304 };
        return { json: [rawIssue(1)], headers: { etag: 'W/"def"' } };
      }
      return {};
    });
    const src = new ForgejoSource(config(), fetchImpl);
    const first = await src.fetchOpenIssues();
    const second = await src.fetchOpenIssues();
    expect(first.map((i) => i.externalId)).toEqual(['acme/repo#1']);
    expect(second).toEqual(first); // served from cache on the 304
    expect(listCalls).toBe(2);
    expect(calls[1]!.headers['if-none-match']).toBe('W/"def"');
  });

  it('page-based pagination: fetches page 2 after a full first page', async () => {
    const fullPage = Array.from({ length: 50 }, (_, i) => rawIssue(i + 1)); // exactly per_page → there may be more
    const { fetchImpl, calls } = makeFetch((req) => {
      if (req.url.includes('page=2')) return { json: [rawIssue(51)] };
      if (req.url.includes('/issues?')) return { json: fullPage };
      return {};
    });
    // limit 51 > MAX_PER_PAGE (50) → multi-page semantics, cache bypassed.
    const issues = await new ForgejoSource(config(), fetchImpl).fetchOpenIssues(51);
    expect(issues).toHaveLength(51);
    expect(issues.at(-1)!.externalId).toBe('acme/repo#51');
    expect(calls.some((c) => c.url.includes('page=2'))).toBe(true);
  });

  it('searchIssues maps results from the configured repo', async () => {
    const { fetchImpl, calls } = makeFetch((req) => (req.url.includes('q=widget') ? { json: [rawIssue(1)] } : {}));
    const issues = await new ForgejoSource(config(), fetchImpl).searchIssues('widget');
    expect(issues).toHaveLength(1);
    expect(issues[0]!.externalId).toBe('acme/repo#1');
    expect(calls[0]!.url).toContain('type=issues');
  });

  it('writeBack completed → comment then close (POST comments + PATCH state=closed)', async () => {
    const { fetchImpl, calls } = makeFetch(() => ({}));
    const result = await new ForgejoSource(config(), fetchImpl).writeBack('acme/repo#1', 'completed');
    expect(result).toEqual({ written: true, code: 'written', value: 'commented + closed' });
    const comment = calls.find((c) => c.method === 'POST' && c.url.endsWith('/issues/1/comments'))!;
    expect(JSON.parse(comment.body!).body).toBe('Completed by Symphony.');
    const close = calls.find((c) => c.method === 'PATCH' && c.url.endsWith('/issues/1'))!;
    expect(JSON.parse(close.body!).state).toBe('closed');
  });

  it('writeBack failed → skipped (no calls) when not configured', async () => {
    const { fetchImpl, calls } = makeFetch(() => ({}));
    const result = await new ForgejoSource(config(), fetchImpl).writeBack('acme/repo#1', 'failed');
    expect(result).toEqual({ written: false, code: 'skipped', reason: "no 'failed' writeback configured" });
    expect(calls).toHaveLength(0);
  });

  it('writeBack failed → comment only (never closes) when configured', async () => {
    const { fetchImpl, calls } = makeFetch(() => ({}));
    const src = new ForgejoSource(config({ statusWriteback: { failed: 'could not finish' } }), fetchImpl);
    const result = await src.writeBack('acme/repo#1', 'failed');
    expect(result).toEqual({ written: true, code: 'written', value: 'commented (left open)' });
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
    expect(calls.filter((c) => c.method === 'PATCH')).toHaveLength(0);
  });

  it('writeBack → not-found on a 404; not-found on a malformed id (no calls)', async () => {
    const { fetchImpl } = makeFetch(() => ({ status: 404, json: { message: 'gone' } }));
    expect((await new ForgejoSource(config(), fetchImpl).writeBack('acme/repo#9', 'completed')).code).toBe('not-found');

    const { fetchImpl: f2, calls } = makeFetch(() => ({}));
    const bad = await new ForgejoSource(config(), f2).writeBack('not-an-id', 'completed');
    expect(bad.code).toBe('not-found');
    expect(calls).toHaveLength(0);
  });

  it('checkConnection reports the login', async () => {
    const { fetchImpl } = makeFetch((req) => (req.url.endsWith('/user') ? { json: { login: 'ada' } } : {}));
    const result = await new ForgejoSource(config(), fetchImpl).checkConnection();
    expect(result.ok).toBe(true);
    expect(result.detail).toContain('ada');
  });
});
