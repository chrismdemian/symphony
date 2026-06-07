/**
 * Phase 8C.4 — narrow Forgejo (Gitea-compatible) REST v1 client seam.
 *
 * Mirrors `github-client.ts`: the connector talks to this interface, never the
 * raw API, so unit tests substitute a hand-written fake without any network.
 * The real impl is a thin REST layer over global `fetch`.
 *
 * Auth: a Forgejo **personal access token** in the `Authorization: token <token>`
 * header — the Gitea/Forgejo scheme, NOT `Authorization: Bearer` (that's OAuth).
 *
 * Base URL: Forgejo is always self-hosted; the configured `siteUrl` + `/api/v1`
 * is the API root. The issue index in every writeback path (`/issues/:index`,
 * comments, close) is the repo-scoped `number` (Gitea calls it `index`), NEVER
 * the global `id` — so the connector keys its external id on `number`
 * (`<owner/repo>#<number>`).
 *
 * PR filtering: Gitea's issues endpoint returns pull requests too. We pass
 * `type=issues` (server-side filter) AND belt-and-suspenders skip any item with a
 * non-null `pull_request` field.
 *
 * Pagination: page-based (`?page=N&limit=M`); the client walks pages until a
 * short page or `limit` is reached. ETag conditional caching applies to
 * SINGLE-PAGE requests only (304 → cached, no extra cost — the 8D trigger-loop
 * foundation); Forgejo emits an `ETag` on list responses, and the cache no-ops
 * gracefully on instances that don't.
 */

const API_PREFIX = '/api/v1';
/** Gitea/Forgejo default `limit` cap per page is 50. */
const MAX_PER_PAGE = 50;

/** A raw Forgejo issue, plus the `owner/repo` it came from (always populated by
 *  the client so the connector can form a stable `owner/repo#number` id). */
export interface ForgejoIssueNode {
  readonly repo: string;
  /** Global, unique-across-instance id (NOT used for writeback paths). */
  readonly id: number;
  /** Per-repo issue number / index (`#42`) — the writeback path segment. */
  readonly number: number;
  readonly title: string;
  readonly body: string | null;
  /** `open` | `closed`. */
  readonly state: string;
  readonly htmlUrl: string;
  readonly updatedAt: string;
  readonly labels: readonly string[];
  readonly assignee: string | null;
}

export interface ForgejoClientLike {
  /**
   * Open issues for one `owner/repo`, newest-updated first, PRs excluded. Honors
   * an internal per-repo ETag cache (304 → cached result). `limit` caps the
   * total returned (paginates by `page` when > one page).
   */
  listOpenIssues(repo: string, limit: number): Promise<readonly ForgejoIssueNode[]>;
  /** Server-side search within one repo (`q` over title/body). */
  searchIssues(term: string, limit: number, repo: string): Promise<readonly ForgejoIssueNode[]>;
  /** Post a comment on an issue. */
  addComment(repo: string, issueNumber: number, body: string): Promise<void>;
  /** Close an issue (PATCH state=closed). */
  closeIssue(repo: string, issueNumber: number): Promise<void>;
  /** Connection check — the authenticated user's login, or null. */
  getViewer(): Promise<{ readonly login: string } | null>;
}

export class ForgejoApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ForgejoApiError';
  }
}

type FetchLike = typeof fetch;

interface RawIssue {
  id?: number | null;
  number?: number | null;
  title?: string | null;
  body?: string | null;
  state?: string | null;
  html_url?: string | null;
  updated_at?: string | null;
  labels?: Array<{ name?: string | null } | string> | null;
  assignee?: { login?: string | null; full_name?: string | null } | null;
  /** Non-null means this "issue" is actually a pull request — filter it out. */
  pull_request?: unknown;
}

interface EtagCacheEntry {
  readonly etag: string;
  readonly issues: readonly ForgejoIssueNode[];
}

/** Build a real `ForgejoClientLike` backed by the Forgejo/Gitea REST v1 API. */
export function createForgejoClient(
  token: string,
  opts: { readonly fetchImpl?: FetchLike; readonly siteUrl: string },
): ForgejoClientLike {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const apiBase = `${opts.siteUrl.replace(/\/+$/, '')}${API_PREFIX}`;
  // Per-repo ETag cache (keyed by the first-page list URL).
  const etagCache = new Map<string, EtagCacheEntry>();

  function headers(extra?: Record<string, string>): Record<string, string> {
    return {
      authorization: `token ${token}`,
      accept: 'application/json',
      ...extra,
    };
  }

  async function request(
    url: string,
    init: { method: string; headers?: Record<string, string>; body?: string },
  ): Promise<Response> {
    try {
      return await fetchImpl(url, init);
    } catch (err) {
      throw new ForgejoApiError(
        `Forgejo request failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Throw a descriptive error for a non-OK, non-304 response. */
  async function fail(resp: Response, context: string): Promise<never> {
    const body = await resp.text().catch(() => '');
    const detail = body ? `: ${body.slice(0, 300)}` : '';
    if (resp.status === 401) {
      throw new ForgejoApiError(`Forgejo auth failed (401) on ${context}: check the token${detail}`, 401);
    }
    if (resp.status === 403) {
      throw new ForgejoApiError(`Forgejo forbidden (403) on ${context} (token scope?)${detail}`, 403);
    }
    if (resp.status === 404) {
      throw new ForgejoApiError(
        `Forgejo not found (404) on ${context}: repo missing or no access${detail}`,
        404,
      );
    }
    throw new ForgejoApiError(`Forgejo API ${resp.status} ${resp.statusText} on ${context}${detail}`, resp.status);
  }

  function mapIssue(raw: RawIssue, repo: string): ForgejoIssueNode {
    return {
      repo,
      id: raw.id ?? 0,
      number: raw.number ?? 0,
      title: (raw.title ?? '').trim(),
      body: raw.body ?? null,
      state: raw.state ?? 'open',
      htmlUrl: raw.html_url ?? '',
      updatedAt: raw.updated_at ?? '',
      labels: (raw.labels ?? [])
        .map((l) => (typeof l === 'string' ? l : (l.name ?? '')))
        .filter((n): n is string => n.length > 0),
      assignee: raw.assignee?.login ?? raw.assignee?.full_name ?? null,
    };
  }

  /** Push only real issues (Gitea returns PRs too — `pull_request` is non-null for those). */
  function pushPage(collected: ForgejoIssueNode[], raws: RawIssue[], repo: string): void {
    for (const raw of raws) {
      if (raw.pull_request !== undefined && raw.pull_request !== null) continue;
      collected.push(mapIssue(raw, repo));
    }
  }

  return {
    async listOpenIssues(repo, limit) {
      const perPage = Math.min(limit, MAX_PER_PAGE);
      const listUrl = (page: number): string =>
        `${apiBase}/repos/${repo}/issues` +
        `?state=open&type=issues&sort=recentupdate&page=${page}&limit=${perPage}`;
      const firstUrl = listUrl(1);

      // ETag conditional caching is only correct for SINGLE-PAGE requests: a 304
      // on page 1 doesn't prove later pages are unchanged, and the cache is keyed
      // by the page-1 URL (which only varies `limit`). For a multi-page request
      // (limit > one page) fetch unconditionally and never touch the cache. For a
      // single-page request, `perPage === limit`, so the URL key uniquely
      // reflects the limit and the cached set is always the complete result.
      const useCache = limit <= MAX_PER_PAGE;
      const cached = useCache ? etagCache.get(firstUrl) : undefined;
      const firstResp = await request(firstUrl, {
        method: 'GET',
        headers: headers(cached !== undefined ? { 'if-none-match': cached.etag } : undefined),
      });
      if (firstResp.status === 304 && cached !== undefined) {
        return cached.issues.slice(0, limit);
      }
      if (!firstResp.ok) await fail(firstResp, `list issues for ${repo}`);

      const collected: ForgejoIssueNode[] = [];
      const firstRaws = (await firstResp.json()) as RawIssue[];
      pushPage(collected, firstRaws, repo);

      // Page-based pagination: keep fetching while the last page was full AND we
      // still need more. A short page means we hit the end.
      let page = 1;
      let lastPageLen = firstRaws.length;
      while (lastPageLen === perPage && collected.length < limit) {
        page += 1;
        const resp = await request(listUrl(page), { method: 'GET', headers: headers() });
        if (!resp.ok) await fail(resp, `list issues for ${repo} (page ${page})`);
        const raws = (await resp.json()) as RawIssue[];
        pushPage(collected, raws, repo);
        lastPageLen = raws.length;
      }

      const result = collected.slice(0, limit);
      if (useCache) {
        const etag = firstResp.headers.get('etag');
        if (etag) etagCache.set(firstUrl, { etag, issues: result });
      }
      return result;
    },

    async searchIssues(term, limit, repo) {
      const perPage = Math.min(limit, MAX_PER_PAGE);
      const url =
        `${apiBase}/repos/${repo}/issues` +
        `?state=open&type=issues&q=${encodeURIComponent(term)}&page=1&limit=${perPage}`;
      const resp = await request(url, { method: 'GET', headers: headers() });
      if (!resp.ok) await fail(resp, `search issues for ${repo}`);
      const raws = (await resp.json()) as RawIssue[];
      const out: ForgejoIssueNode[] = [];
      pushPage(out, raws, repo);
      return out.slice(0, limit);
    },

    async addComment(repo, issueNumber, body) {
      const url = `${apiBase}/repos/${repo}/issues/${issueNumber}/comments`;
      const resp = await request(url, {
        method: 'POST',
        headers: headers({ 'content-type': 'application/json' }),
        body: JSON.stringify({ body }),
      });
      if (!resp.ok) await fail(resp, `comment on ${repo}#${issueNumber}`);
    },

    async closeIssue(repo, issueNumber) {
      const url = `${apiBase}/repos/${repo}/issues/${issueNumber}`;
      const resp = await request(url, {
        method: 'PATCH',
        headers: headers({ 'content-type': 'application/json' }),
        body: JSON.stringify({ state: 'closed' }),
      });
      if (!resp.ok) await fail(resp, `close ${repo}#${issueNumber}`);
    },

    async getViewer() {
      const resp = await request(`${apiBase}/user`, { method: 'GET', headers: headers() });
      if (!resp.ok) await fail(resp, 'get authenticated user');
      const data = (await resp.json()) as { login?: string | null };
      return data.login ? { login: data.login } : null;
    },
  };
}
