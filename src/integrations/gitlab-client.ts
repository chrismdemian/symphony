/**
 * Phase 8C.3 — narrow GitLab REST client seam.
 *
 * Mirrors `github-client.ts`: the connector talks to this interface, never the
 * raw API, so unit tests substitute a hand-written fake without any network.
 * The real impl is a thin REST layer over global `fetch`.
 *
 * Auth: a GitLab **personal access token** in the `PRIVATE-TOKEN: <token>`
 * header (GitLab's PAT scheme — NOT `Authorization: Bearer`, which is OAuth).
 *
 * Project ref: GitLab's v4 API accepts a URL-encoded `group/project` path
 * (`group%2Fproject`) directly as the `:id` path segment, so we never resolve a
 * project to its numeric id — the configured path is the ref everywhere.
 *
 * id vs iid: a GitLab issue has BOTH a global `id` and a per-project `iid` (the
 * `#42` shown in the UI/URL). EVERY issue-level path (`/issues/:iid`, notes,
 * close) uses `iid`, NEVER the global `id`. The connector keys its external id
 * on `iid` (`<projectPath>#<iid>`) for exactly this reason.
 *
 * ETag: list responses carry an `ETag`; we cache it per project (single-page
 * requests only) and send `If-None-Match` on the next list. A `304 Not Modified`
 * returns the cached issues — the same cheap-repeat-poll foundation as GitHub
 * (8D trigger loop).
 */

const DEFAULT_SITE_URL = 'https://gitlab.com';
/** GitLab caps `per_page` at 100. */
const MAX_PER_PAGE = 100;

/** A raw GitLab issue, plus the `group/project` path it came from (always
 *  populated by the client so the connector can form a stable
 *  `group/project#iid` id). */
export interface GitLabIssueNode {
  readonly projectPath: string;
  /** Global, unique-across-GitLab id (NOT used for writeback paths). */
  readonly id: number;
  /** Per-project issue number (`#42`) — the writeback path segment. */
  readonly iid: number;
  readonly title: string;
  readonly body: string | null;
  /** `opened` | `closed`. */
  readonly state: string;
  readonly webUrl: string;
  readonly updatedAt: string;
  readonly labels: readonly string[];
  readonly assignee: string | null;
}

export interface GitLabClientLike {
  /**
   * Open issues for one `group/project`, newest-updated first. Honors an
   * internal per-project ETag cache (304 → cached result). `limit` caps the
   * total returned (paginates via the `Link` header when > 100).
   */
  listOpenIssues(projectPath: string, limit: number): Promise<readonly GitLabIssueNode[]>;
  /** Server-side search within one project (`search` over title+description). */
  searchIssues(
    term: string,
    limit: number,
    projectPath: string,
  ): Promise<readonly GitLabIssueNode[]>;
  /** Post a note (comment) on an issue. */
  addNote(projectPath: string, iid: number, body: string): Promise<void>;
  /** Close an issue (PUT state_event=close). */
  closeIssue(projectPath: string, iid: number): Promise<void>;
  /** Connection check — the authenticated user's username, or null. */
  getViewer(): Promise<{ readonly username: string } | null>;
}

export class GitLabApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'GitLabApiError';
  }
}

type FetchLike = typeof fetch;

interface RawIssue {
  id: number;
  iid: number;
  title?: string | null;
  description?: string | null;
  state?: string | null;
  web_url?: string | null;
  updated_at?: string | null;
  labels?: string[] | null;
  assignee?: { username?: string | null; name?: string | null } | null;
}

interface EtagCacheEntry {
  readonly etag: string;
  readonly issues: readonly GitLabIssueNode[];
}

/** Build a real `GitLabClientLike` backed by the GitLab REST v4 API. */
export function createGitLabClient(
  token: string,
  opts: { readonly fetchImpl?: FetchLike; readonly siteUrl?: string } = {},
): GitLabClientLike {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const apiBase = `${(opts.siteUrl ?? DEFAULT_SITE_URL).replace(/\/+$/, '')}/api/v4`;
  // Per-project ETag cache (keyed by the first-page list URL).
  const etagCache = new Map<string, EtagCacheEntry>();

  function headers(extra?: Record<string, string>): Record<string, string> {
    return {
      'private-token': token,
      accept: 'application/json',
      ...extra,
    };
  }

  /** URL-encode a `group/project` path for the `:id` path segment. */
  function encodeProject(projectPath: string): string {
    return encodeURIComponent(projectPath);
  }

  async function request(
    url: string,
    init: { method: string; headers?: Record<string, string>; body?: string },
  ): Promise<Response> {
    try {
      return await fetchImpl(url, init);
    } catch (err) {
      throw new GitLabApiError(
        `GitLab request failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Throw a descriptive error for a non-OK, non-304 response. */
  async function fail(resp: Response, context: string): Promise<never> {
    const body = await resp.text().catch(() => '');
    const detail = body ? `: ${body.slice(0, 300)}` : '';
    if (resp.status === 401) {
      throw new GitLabApiError(`GitLab auth failed (401) on ${context}: check the token${detail}`, 401);
    }
    if (resp.status === 403) {
      throw new GitLabApiError(`GitLab forbidden (403) on ${context} (token scope?)${detail}`, 403);
    }
    if (resp.status === 404) {
      throw new GitLabApiError(
        `GitLab not found (404) on ${context}: project missing or no access${detail}`,
        404,
      );
    }
    throw new GitLabApiError(`GitLab API ${resp.status} ${resp.statusText} on ${context}${detail}`, resp.status);
  }

  function mapIssue(raw: RawIssue, projectPath: string): GitLabIssueNode {
    return {
      projectPath,
      id: raw.id,
      iid: raw.iid,
      title: (raw.title ?? '').trim(),
      body: raw.description ?? null,
      state: raw.state ?? 'opened',
      webUrl: raw.web_url ?? '',
      updatedAt: raw.updated_at ?? '',
      labels: (raw.labels ?? []).filter((l): l is string => typeof l === 'string' && l.length > 0),
      assignee: raw.assignee?.username ?? raw.assignee?.name ?? null,
    };
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
    async listOpenIssues(projectPath, limit) {
      const perPage = Math.min(limit, MAX_PER_PAGE);
      const firstUrl =
        `${apiBase}/projects/${encodeProject(projectPath)}/issues` +
        `?state=opened&order_by=updated_at&sort=desc&per_page=${perPage}`;

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
      if (!firstResp.ok) await fail(firstResp, `list issues for ${projectPath}`);

      const collected: GitLabIssueNode[] = [];
      const pushPage = (raws: RawIssue[]): void => {
        for (const raw of raws) collected.push(mapIssue(raw, projectPath));
      };
      pushPage((await firstResp.json()) as RawIssue[]);

      let next = collected.length < limit ? nextLink(firstResp.headers.get('link')) : undefined;
      while (next !== undefined && collected.length < limit) {
        const resp = await request(next, { method: 'GET', headers: headers() });
        if (!resp.ok) await fail(resp, `list issues for ${projectPath} (page)`);
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

    async searchIssues(term, limit, projectPath) {
      const perPage = Math.min(limit, MAX_PER_PAGE);
      const url =
        `${apiBase}/projects/${encodeProject(projectPath)}/issues` +
        `?search=${encodeURIComponent(term)}&in=title,description` +
        `&order_by=updated_at&sort=desc&per_page=${perPage}`;
      const resp = await request(url, { method: 'GET', headers: headers() });
      if (!resp.ok) await fail(resp, `search issues for ${projectPath}`);
      const raws = (await resp.json()) as RawIssue[];
      return raws.map((raw) => mapIssue(raw, projectPath)).slice(0, limit);
    },

    async addNote(projectPath, iid, body) {
      const url = `${apiBase}/projects/${encodeProject(projectPath)}/issues/${iid}/notes`;
      const resp = await request(url, {
        method: 'POST',
        headers: headers({ 'content-type': 'application/json' }),
        body: JSON.stringify({ body }),
      });
      if (!resp.ok) await fail(resp, `note on ${projectPath}#${iid}`);
    },

    async closeIssue(projectPath, iid) {
      const url = `${apiBase}/projects/${encodeProject(projectPath)}/issues/${iid}`;
      const resp = await request(url, {
        method: 'PUT',
        headers: headers({ 'content-type': 'application/json' }),
        body: JSON.stringify({ state_event: 'close' }),
      });
      if (!resp.ok) await fail(resp, `close ${projectPath}#${iid}`);
    },

    async getViewer() {
      const resp = await request(`${apiBase}/user`, { method: 'GET', headers: headers() });
      if (!resp.ok) await fail(resp, 'get authenticated user');
      const data = (await resp.json()) as { username?: string | null };
      return data.username ? { username: data.username } : null;
    },
  };
}
