/**
 * Phase 8C.2 — narrow GitHub REST client seam.
 *
 * Mirrors `linear-client.ts`: the connector talks to this interface, never the
 * raw API, so unit tests substitute a hand-written fake without any network.
 * The real impl is a thin REST layer over global `fetch` (no Octokit / `gh` CLI
 * dependency — emdash's `GitHubService.ts` proved the raw API is enough, and a
 * connector shouldn't shell out to a CLI it can't guarantee is installed).
 *
 * Auth: a GitHub **personal access token** in the `Authorization: Bearer <token>`
 * header (GitHub's preferred PAT scheme; the legacy `token <token>` form also
 * works but `Bearer` is current). `Accept: application/vnd.github+json` +
 * `X-GitHub-Api-Version: 2022-11-28` pin the response shape.
 *
 * ETag: list responses carry an `ETag`; we cache it per repo and send
 * `If-None-Match` on the next list. A `304 Not Modified` returns the cached
 * issues and does NOT count against the rate limit — making repeat `sync_github`
 * (and the Phase 8D trigger loop) nearly free. Adapted from emdash
 * `GitHubService.ts:1470-1484` (Issues API instead of the Events API).
 */

const DEFAULT_API_BASE = 'https://api.github.com';
const API_VERSION = '2022-11-28';
/** GitHub caps `per_page` at 100. */
const MAX_PER_PAGE = 100;

/** A raw GitHub issue, plus the `owner/repo` it came from (always populated by
 *  the client so the connector can form a stable `owner/repo#number` id). */
export interface GitHubIssueNode {
  readonly repo: string;
  readonly id: number;
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

export interface GitHubClientLike {
  /**
   * Open issues for one `owner/repo`, newest-updated first, PRs excluded. Honors
   * an internal per-repo ETag cache (304 → cached result). `limit` caps the
   * total returned (paginates via the `Link` header when > 100).
   */
  listOpenIssues(repo: string, limit: number): Promise<readonly GitHubIssueNode[]>;
  /** Server-side search across the given repos (`is:issue is:open` + `term`). */
  searchIssues(
    term: string,
    limit: number,
    repos: readonly string[],
  ): Promise<readonly GitHubIssueNode[]>;
  /** Post a comment on an issue. */
  addComment(repo: string, issueNumber: number, body: string): Promise<void>;
  /** Close an issue (PATCH state=closed). */
  closeIssue(repo: string, issueNumber: number): Promise<void>;
  /** Connection check — the authenticated user's login, or null. */
  getViewer(): Promise<{ readonly login: string } | null>;
}

export class GitHubApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'GitHubApiError';
  }
}

type FetchLike = typeof fetch;

interface RawIssue {
  id: number;
  number: number;
  title?: string | null;
  body?: string | null;
  state?: string | null;
  html_url?: string | null;
  updated_at?: string | null;
  labels?: Array<{ name?: string | null } | string> | null;
  assignee?: { login?: string | null } | null;
  /** Presence means this "issue" is actually a pull request — filter it out. */
  pull_request?: unknown;
  /** Only on /search/issues results — `https://api.github.com/repos/owner/repo`. */
  repository_url?: string | null;
}

interface EtagCacheEntry {
  readonly etag: string;
  readonly issues: readonly GitHubIssueNode[];
}

/** Build a real `GitHubClientLike` backed by the GitHub REST API. */
export function createGitHubClient(
  token: string,
  opts: { readonly fetchImpl?: FetchLike; readonly apiBaseUrl?: string } = {},
): GitHubClientLike {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const apiBase = (opts.apiBaseUrl ?? DEFAULT_API_BASE).replace(/\/+$/, '');
  // Per-repo ETag cache (keyed by the first-page list URL).
  const etagCache = new Map<string, EtagCacheEntry>();

  function headers(extra?: Record<string, string>): Record<string, string> {
    return {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': API_VERSION,
      ...extra,
    };
  }

  async function request(
    url: string,
    init: { method: string; headers?: Record<string, string>; body?: string },
  ): Promise<Response> {
    let resp: Response;
    try {
      resp = await fetchImpl(url, init);
    } catch (err) {
      throw new GitHubApiError(
        `GitHub request failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return resp;
  }

  /** Throw a descriptive error for a non-OK, non-304 response. */
  async function fail(resp: Response, context: string): Promise<never> {
    const remaining = resp.headers.get('x-ratelimit-remaining');
    const body = await resp.text().catch(() => '');
    const detail = body ? `: ${body.slice(0, 300)}` : '';
    if (resp.status === 401) {
      throw new GitHubApiError(`GitHub auth failed (401) on ${context}: check the token${detail}`, 401);
    }
    if (resp.status === 403) {
      const rl = remaining === '0' ? ' (rate limit exhausted)' : ' (token scope?)';
      throw new GitHubApiError(`GitHub forbidden (403)${rl} on ${context}${detail}`, 403);
    }
    if (resp.status === 404) {
      throw new GitHubApiError(`GitHub not found (404) on ${context}: repo missing or no access${detail}`, 404);
    }
    throw new GitHubApiError(`GitHub API ${resp.status} ${resp.statusText} on ${context}${detail}`, resp.status);
  }

  function mapIssue(raw: RawIssue, repo: string): GitHubIssueNode {
    return {
      repo,
      id: raw.id,
      number: raw.number,
      title: (raw.title ?? '').trim(),
      body: raw.body ?? null,
      state: raw.state ?? 'open',
      htmlUrl: raw.html_url ?? '',
      updatedAt: raw.updated_at ?? '',
      labels: (raw.labels ?? [])
        .map((l) => (typeof l === 'string' ? l : (l.name ?? '')))
        .filter((n): n is string => n.length > 0),
      assignee: raw.assignee?.login ?? null,
    };
  }

  /** Parse `owner/repo` out of a search result's `repository_url`. */
  function repoFromUrl(repositoryUrl: string | null | undefined): string {
    if (!repositoryUrl) return '';
    const m = repositoryUrl.match(/\/repos\/([^/]+\/[^/]+)$/);
    return m?.[1] ?? '';
  }

  /** Extract the `rel="next"` URL from a `Link` response header, if present. */
  function nextLink(linkHeader: string | null): string | undefined {
    if (!linkHeader) return undefined;
    for (const part of linkHeader.split(',')) {
      const m = part.match(/<([^>]+)>;\s*rel="next"/);
      if (m) return m[1];
    }
    return undefined;
  }

  return {
    async listOpenIssues(repo, limit) {
      const perPage = Math.min(limit, MAX_PER_PAGE);
      const firstUrl =
        `${apiBase}/repos/${repo}/issues` +
        `?state=open&sort=updated&direction=desc&per_page=${perPage}`;

      // ETag conditional caching is only correct for SINGLE-PAGE requests: a 304
      // on page 1 doesn't prove later pages are unchanged, and the cache is keyed
      // by the page-1 URL (which only varies `per_page`). For a multi-page request
      // (limit > one page) fetch unconditionally and never touch the cache. For a
      // single-page request, `per_page === limit`, so the URL key uniquely
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

      const collected: GitHubIssueNode[] = [];
      const pushPage = (raws: RawIssue[]): void => {
        for (const raw of raws) {
          // GitHub's issues endpoint returns PRs too — drop them.
          if (raw.pull_request !== undefined) continue;
          collected.push(mapIssue(raw, repo));
        }
      };
      pushPage((await firstResp.json()) as RawIssue[]);

      // Paginate only when the caller asked for more than one page can hold.
      let next = collected.length < limit ? nextLink(firstResp.headers.get('link')) : undefined;
      while (next !== undefined && collected.length < limit) {
        const resp = await request(next, { method: 'GET', headers: headers() });
        if (!resp.ok) await fail(resp, `list issues for ${repo} (page)`);
        pushPage((await resp.json()) as RawIssue[]);
        next = nextLink(resp.headers.get('link'));
      }

      const result = collected.slice(0, limit);
      if (useCache) {
        const etag = firstResp.headers.get('etag');
        if (etag) etagCache.set(firstUrl, { etag, issues: result });
      }
      return result;
    },

    async searchIssues(term, limit, repos) {
      const perPage = Math.min(limit, MAX_PER_PAGE);
      const repoQualifiers = repos.map((r) => `repo:${r}`).join(' ');
      const q = `${term} is:issue is:open ${repoQualifiers}`.trim();
      const url =
        `${apiBase}/search/issues` +
        `?q=${encodeURIComponent(q)}&sort=updated&order=desc&per_page=${perPage}`;
      const resp = await request(url, { method: 'GET', headers: headers() });
      if (!resp.ok) await fail(resp, 'search issues');
      const data = (await resp.json()) as { items?: RawIssue[] };
      const out: GitHubIssueNode[] = [];
      for (const raw of data.items ?? []) {
        if (raw.pull_request !== undefined) continue;
        out.push(mapIssue(raw, repoFromUrl(raw.repository_url)));
      }
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
